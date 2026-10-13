import {
  RuntimeSettingsPatchSchema,
  RuntimeSettingsSchema,
  type RuntimeSettings,
} from "@cet-reading/contracts/config";
import { config } from "./config.js";
import { pool } from "./store.js";
import { readRuntimeSettings } from "./runtime-settings.js";
import { emptyQuestionProgress, getPaperQuestionProgress } from "./analysis-progress.js";
import { analysisErrorCode } from "@cet-reading/contracts/analysis-jobs";

export class InvalidAdminSettingsError extends Error {
  constructor(message = "Invalid analysis runtime settings") {
    super(message);
    this.name = "InvalidAdminSettingsError";
  }
}

function asIso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function audit(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  action: string,
  before: unknown,
  after: unknown,
  actor = "admin-console",
) {
  await client.query(
    `INSERT INTO analysis_config_audit (actor, action, before_json, after_json) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
    [
      actor,
      action,
      JSON.stringify(before ?? null),
      JSON.stringify(after ?? null),
    ],
  );
}

export async function getAdminSettings() {
  return readRuntimeSettings(pool, config);
}

export async function updateAdminSettings(
  value: unknown,
  actor = "admin-console",
): Promise<RuntimeSettings> {
  const patch = RuntimeSettingsPatchSchema.safeParse(value);
  if (!patch.success)
    throw new InvalidAdminSettingsError(patch.error.issues[0]?.message);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await readRuntimeSettings(client, config);
    const next = RuntimeSettingsSchema.safeParse({ ...current, ...patch.data });
    if (!next.success)
      throw new InvalidAdminSettingsError(next.error.issues[0]?.message);
    if (next.data.queueCapacity < next.data.workerConcurrency)
      throw new InvalidAdminSettingsError(
        "queueCapacity must be at least workerConcurrency",
      );
    await client.query(
      `UPDATE analysis_runtime_settings SET worker_concurrency=$1,queue_capacity=$2,background_target=$3,backfill_paused=$4,prompt_override=$5,updated_at=NOW() WHERE id=TRUE`,
      [
        next.data.workerConcurrency,
        next.data.queueCapacity,
        next.data.backgroundTarget,
        next.data.backfillPaused,
        next.data.promptOverride,
      ],
    );
    await audit(client, "runtime_settings.updated", current, next.data, actor);
    await client.query("NOTIFY analysis_runtime_settings");
    await client.query("COMMIT");
    return next.data;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setBackfillPaused(
  paused: boolean,
  actor = "admin-console",
) {
  return updateAdminSettings({ backfillPaused: paused }, actor);
}

export async function getAdminOverview(jobType?: string, jobStatus?: string) {
  const settings = await getAdminSettings();
  const params = [config.mode, config.model, config.promptVersion];
  const [queue, recent, timeline, errors, cache, workers, questionProgress, jobs] = await Promise.all([
    pool.query<{
      job_type: 'sentence' | 'text' | 'question';
      pending: number;
      running: number;
      failed: number;
      oldest_pending: Date | null;
      oldest_running: Date | null;
    }>(
      `SELECT job_type,
         COUNT(*) FILTER (WHERE status='pending' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=NOW())))::integer pending,
         COUNT(*) FILTER (WHERE status='running' AND lease_expires_at>NOW())::integer running,
         COUNT(*) FILTER (WHERE status='failed')::integer failed,
         MIN(created_at) FILTER (WHERE status='pending' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=NOW()))) oldest_pending,
         MIN(started_at) FILTER (WHERE status='running' AND lease_expires_at>NOW()) oldest_running
       FROM analysis_jobs WHERE mode=$1 AND model=$2 AND prompt_version=$3 GROUP BY job_type`,
      params,
    ),
    pool.query<{
      success_1h: number;
      failed_1h: number;
      success_6h: number;
      failed_6h: number;
      queue_p50: number | null;
      queue_p90: number | null;
      generation_p50: number | null;
      generation_p90: number | null;
    }>(
      `SELECT COUNT(*) FILTER (WHERE status='succeeded' AND finished_at>=NOW()-INTERVAL '1 hour')::integer success_1h,COUNT(*) FILTER (WHERE status='failed' AND finished_at>=NOW()-INTERVAL '1 hour')::integer failed_1h,COUNT(*) FILTER (WHERE status='succeeded' AND finished_at>=NOW()-INTERVAL '6 hours')::integer success_6h,COUNT(*) FILTER (WHERE status='failed' AND finished_at>=NOW()-INTERVAL '6 hours')::integer failed_6h,percentile_cont(.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM(started_at-created_at))) FILTER (WHERE status='succeeded' AND finished_at>=NOW()-INTERVAL '24 hours') queue_p50,percentile_cont(.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM(started_at-created_at))) FILTER (WHERE status='succeeded' AND finished_at>=NOW()-INTERVAL '24 hours') queue_p90,percentile_cont(.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM(finished_at-started_at))) FILTER (WHERE status='succeeded' AND finished_at>=NOW()-INTERVAL '24 hours') generation_p50,percentile_cont(.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM(finished_at-started_at))) FILTER (WHERE status='succeeded' AND finished_at>=NOW()-INTERVAL '24 hours') generation_p90 FROM analysis_jobs WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND finished_at IS NOT NULL`,
      params,
    ),
    pool.query<{
      bucket: Date;
      success: number;
      failed: number;
      queue_p50: number | null;
      queue_p90: number | null;
      generation_p50: number | null;
      generation_p90: number | null;
    }>(
      `SELECT date_trunc('hour',finished_at) bucket,COUNT(*) FILTER (WHERE status='succeeded')::integer success,COUNT(*) FILTER (WHERE status='failed')::integer failed,percentile_cont(.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM(started_at-created_at))) FILTER (WHERE status='succeeded') queue_p50,percentile_cont(.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM(started_at-created_at))) FILTER (WHERE status='succeeded') queue_p90,percentile_cont(.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM(finished_at-started_at))) FILTER (WHERE status='succeeded') generation_p50,percentile_cont(.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM(finished_at-started_at))) FILTER (WHERE status='succeeded') generation_p90 FROM analysis_jobs WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND finished_at>=NOW()-INTERVAL '24 hours' GROUP BY 1 ORDER BY 1`,
      params,
    ),
    pool.query<{ error_code: string; count: number }>(
      `SELECT CASE WHEN error_message~*'abort|timed? ?out|timeout' THEN 'timeout' WHEN error_message~*'AI request failed|fetch failed|AI response did not contain' THEN 'service_unavailable' WHEN error_message~*'Grammar|Vocabulary|Translation|AI word|word token|validation|JSON|Unexpected token' THEN 'invalid_result' ELSE 'generation_failed' END error_code,COUNT(*)::integer count FROM analysis_jobs WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND status='failed' AND finished_at>=NOW()-INTERVAL '24 hours' GROUP BY 1 ORDER BY count DESC`,
      params,
    ),
    pool.query<{
      total: number;
      cached: number;
      current_cached: number;
      paper_total: number;
      news_total: number;
    }>(
      `WITH ordered AS (SELECT s.id,s.paper_id,s.article_id,s.section_id,s.source_hash,jsonb_build_object('title',COALESCE(p.title,n.title,''),'previousSentence',lag(s.source_text) OVER w,'nextSentence',lead(s.source_text) OVER w) context_json FROM sentences s LEFT JOIN papers p ON p.id=s.paper_id LEFT JOIN news_articles n ON n.id=s.article_id WHERE p.status='published' OR n.status='published' WINDOW w AS(PARTITION BY s.paper_id,s.article_id ORDER BY s.paragraph_index,s.sentence_index)),visible AS (SELECT o.* FROM ordered o WHERE NOT EXISTS(SELECT 1 FROM shared_paper_sections x WHERE x.paper_id=o.paper_id AND x.section_id=o.section_id)) SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE a.sentence_id IS NOT NULL)::integer cached,COUNT(*) FILTER(WHERE a.prompt_version=$1)::integer current_cached,COUNT(*) FILTER(WHERE v.paper_id IS NOT NULL)::integer paper_total,COUNT(*) FILTER(WHERE v.article_id IS NOT NULL)::integer news_total FROM visible v LEFT JOIN LATERAL (SELECT sentence_id,prompt_version FROM sentence_analyses WHERE sentence_id=v.id AND source_hash=v.source_hash AND context_json=v.context_json AND prompt_version=ANY($2::text[]) AND model=$3 AND mode=$4 AND status='succeeded' ORDER BY(prompt_version=$1) DESC,updated_at DESC LIMIT 1)a ON TRUE`,
      [
        config.promptVersion,
        config.cachePromptVersions,
        config.model,
        config.mode,
      ],
    ),
    pool.query<{
      worker_id: string;
      hostname: string;
      pid: number;
      active_jobs: number;
      concurrency: number;
      last_seen_at: Date;
      started_at: Date;
    }>(
      `SELECT worker_id,hostname,pid,active_jobs,concurrency,last_seen_at,started_at FROM analysis_worker_heartbeats ORDER BY last_seen_at DESC`,
    ),
    getPaperQuestionProgress(pool),
    pool.query<{
      id: string; job_type: 'sentence' | 'text' | 'question'; text_key: string | null;
      status: string; attempts: number; error_message: string | null;
      title: string; section_title: string | null; source_text: string;
      question_id: string | null; sentence_id: string | null;
      created_at: Date; started_at: Date | null; finished_at: Date | null; next_attempt_at: Date;
    }>(
      `SELECT j.id, j.job_type, j.text_key, j.question_id, j.sentence_id, j.attempts, j.error_message,
         CASE WHEN j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW())
              THEN 'pending' ELSE j.status END status,
         COALESCE(p.title,n.title,j.context_json->>'title','') title, ps.title section_title,
         LEFT(CASE WHEN j.job_type='question' THEN COALESCE(j.question_json->>'prompt',q.prompt,'')
                   ELSE j.source_text END,240) source_text,
         j.created_at, j.started_at, j.finished_at, j.next_attempt_at
       FROM analysis_jobs j LEFT JOIN sentences s ON s.id=j.sentence_id
       LEFT JOIN questions q ON q.id=j.question_id LEFT JOIN paper_sections ps ON ps.id=q.section_id
       LEFT JOIN papers p ON p.id=COALESCE(ps.paper_id,s.paper_id)
       LEFT JOIN news_articles n ON n.id=s.article_id
       WHERE j.mode=$1 AND j.model=$2 AND j.prompt_version=$3
         AND (j.status IN ('pending','running') OR j.finished_at>=NOW()-INTERVAL '24 hours')
         AND ($4::text IS NULL OR j.job_type=$4)
         AND ($5::text IS NULL OR CASE WHEN j.status='running' AND
           (j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW()) THEN 'pending' ELSE j.status END=$5)
       ORDER BY CASE WHEN j.status='running' AND j.lease_expires_at>NOW() THEN 0
                     WHEN j.status IN ('pending','running') THEN 1 ELSE 2 END,
                j.updated_at DESC, j.id DESC LIMIT 50`,
      [...params, jobType ?? null, jobStatus ?? null],
    ),
  ]);
  const q = { pending: 0, running: 0, failed: 0, oldest_pending: null as Date | null, oldest_running: null as Date | null };
  const byType = {
    sentence: { pending: 0, running: 0, failed: 0 },
    text: { pending: 0, running: 0, failed: 0 },
    question: { pending: 0, running: 0, failed: 0 },
  };
  for (const row of queue.rows) {
    byType[row.job_type] = { pending: row.pending, running: row.running, failed: row.failed };
    q.pending += row.pending; q.running += row.running; q.failed += row.failed;
    if (row.oldest_pending && (!q.oldest_pending || row.oldest_pending < q.oldest_pending)) q.oldest_pending = row.oldest_pending;
    if (row.oldest_running && (!q.oldest_running || row.oldest_running < q.oldest_running)) q.oldest_running = row.oldest_running;
  }
  const extra = emptyQuestionProgress();
  for (const progress of questionProgress.values()) {
    for (const key of Object.keys(extra) as Array<keyof typeof extra>) extra[key] += progress[key];
  }
  const m = recent.rows[0] ?? {
    success_1h: 0,
    failed_1h: 0,
    success_6h: 0,
    failed_6h: 0,
    queue_p50: null,
    queue_p90: null,
    generation_p50: null,
    generation_p90: null,
  };
  const c = cache.rows[0] ?? {
    total: 0,
    cached: 0,
    current_cached: 0,
    paper_total: 0,
    news_total: 0,
  };
  return {
    observedAt: new Date().toISOString(),
    model: config.model,
    mode: config.mode,
    promptVersion: config.promptVersion,
    settings,
    queue: {
      pending: q.pending,
      running: q.running,
      failed: q.failed,
      active: q.pending + q.running,
      capacity: settings.queueCapacity,
      oldestPendingAt: asIso(q.oldest_pending),
      oldestRunningAt: asIso(q.oldest_running),
      byType,
    },
    jobs: jobs.rows.map(row => ({
      id: row.id, type: row.job_type, textKey: row.text_key, status: row.status,
      title: row.title, sectionTitle: row.section_title, source: row.source_text,
      questionId: row.question_id, sentenceId: row.sentence_id, attempts: row.attempts,
      errorCode: row.error_message ? analysisErrorCode(row.error_message) : null,
      createdAt: asIso(row.created_at), startedAt: asIso(row.started_at),
      finishedAt: asIso(row.finished_at), nextAttemptAt: asIso(row.next_attempt_at),
    })),
    metrics: {
      successLastHour: m.success_1h,
      failedLastHour: m.failed_1h,
      successLastSixHours: m.success_6h,
      failedLastSixHours: m.failed_6h,
      queueP50Seconds: m.queue_p50 == null ? null : Number(m.queue_p50),
      queueP90Seconds: m.queue_p90 == null ? null : Number(m.queue_p90),
      generationP50Seconds:
        m.generation_p50 == null ? null : Number(m.generation_p50),
      generationP90Seconds:
        m.generation_p90 == null ? null : Number(m.generation_p90),
      timeline: timeline.rows.map((row) => ({
        at: asIso(row.bucket),
        success: row.success,
        failed: row.failed,
        queueP50Seconds: row.queue_p50 == null ? null : Number(row.queue_p50),
        queueP90Seconds: row.queue_p90 == null ? null : Number(row.queue_p90),
        generationP50Seconds:
          row.generation_p50 == null ? null : Number(row.generation_p50),
        generationP90Seconds:
          row.generation_p90 == null ? null : Number(row.generation_p90),
      })),
    },
    errors: errors.rows,
    workers: workers.rows.map((row) => ({
      workerId: row.worker_id,
      hostname: row.hostname,
      pid: row.pid,
      activeJobs: row.active_jobs,
      concurrency: row.concurrency,
      lastSeenAt: asIso(row.last_seen_at),
      startedAt: asIso(row.started_at),
    })),
    cache: {
      total: c.total + extra.analysis_text_total + extra.analysis_solving_total,
      cached: c.cached + extra.analysis_text_cached + extra.analysis_solving_cached,
      currentCached: c.current_cached + extra.analysis_text_current_cached + extra.analysis_solving_current_cached,
      legacyCached: Math.max(0, c.cached - c.current_cached)
        + extra.analysis_text_cached - extra.analysis_text_current_cached
        + extra.analysis_solving_cached - extra.analysis_solving_current_cached,
      sentenceTotal: c.total,
      sentenceCached: c.cached,
      textTotal: extra.analysis_text_total,
      textCached: extra.analysis_text_cached,
      solvingTotal: extra.analysis_solving_total,
      solvingCached: extra.analysis_solving_cached,
      paperTotal: c.paper_total,
      newsTotal: c.news_total,
      rate: c.total + extra.analysis_text_total + extra.analysis_solving_total
        ? Number(((c.cached + extra.analysis_text_cached + extra.analysis_solving_cached) * 100
          / (c.total + extra.analysis_text_total + extra.analysis_solving_total)).toFixed(2)) : 0,
    },
  };
}

export async function listAdminPapers() {
  const [paperResult, newsResult, questionProgress] = await Promise.all([
    pool.query(
      `WITH ordered AS (
         SELECT s.id, s.paper_id, s.section_id, s.source_hash,
                jsonb_build_object('title', p.title, 'previousSentence', lag(s.source_text) OVER w,
                  'nextSentence', lead(s.source_text) OVER w) context_json
         FROM sentences s JOIN papers p ON p.id=s.paper_id
         WHERE p.status='published'
         WINDOW w AS (PARTITION BY s.paper_id ORDER BY s.paragraph_index,s.sentence_index)
       ), visible AS (
         SELECT o.* FROM ordered o WHERE NOT EXISTS (SELECT 1 FROM shared_paper_sections x
           WHERE x.paper_id=o.paper_id AND x.section_id=o.section_id)
       ), totals AS (SELECT paper_id, COUNT(*)::integer total FROM visible GROUP BY paper_id),
       cached AS (SELECT v.paper_id, COUNT(DISTINCT v.id)::integer cached FROM visible v
         JOIN sentence_analyses a ON a.sentence_id=v.id AND a.source_hash=v.source_hash
           AND a.context_json=v.context_json AND a.prompt_version=ANY($1::text[])
           AND a.model=$2 AND a.mode=$3 AND a.status='succeeded' GROUP BY v.paper_id)
       SELECT p.id, p.title, p.exam_level, p.year, p.month, p.set_no,
         COALESCE(pr.priority,0)::integer priority, COALESCE(pr.sort_order,2147483647)::integer sort_order,
         COALESCE(t.total,0)::integer total, COALESCE(c.cached,0)::integer cached,
         'paper'::text source_type, p.id source_id
       FROM papers p LEFT JOIN analysis_paper_priorities pr ON pr.paper_id=p.id
         LEFT JOIN totals t ON t.paper_id=p.id LEFT JOIN cached c ON c.paper_id=p.id
       WHERE p.status='published'`,
      [config.cachePromptVersions, config.model, config.mode],
    ),
    pool.query(
      `WITH ordered AS (
         SELECT s.id, s.article_id, s.source_hash,
           jsonb_build_object('title', n.title, 'previousSentence', lag(s.source_text) OVER w,
             'nextSentence', lead(s.source_text) OVER w) context_json
         FROM sentences s JOIN news_articles n ON n.id=s.article_id
         WHERE n.status='published'
         WINDOW w AS (PARTITION BY s.article_id ORDER BY s.paragraph_index,s.sentence_index)
       ), totals AS (SELECT article_id, COUNT(*)::integer total FROM ordered GROUP BY article_id),
       cached AS (SELECT v.article_id, COUNT(DISTINCT v.id)::integer cached FROM ordered v
         JOIN sentence_analyses a ON a.sentence_id=v.id AND a.source_hash=v.source_hash
           AND a.context_json=v.context_json AND a.prompt_version=ANY($1::text[])
           AND a.model=$2 AND a.mode=$3 AND a.status='succeeded' GROUP BY v.article_id)
       SELECT n.id, n.title, 'NEWS'::text exam_level,
         EXTRACT(YEAR FROM n.batch_at)::integer AS year, EXTRACT(MONTH FROM n.batch_at)::integer AS month,
         0::integer set_no, COALESCE(pr.priority,0)::integer priority,
         COALESCE(pr.sort_order,2147483647)::integer sort_order,
         COALESCE(t.total,0)::integer total, COALESCE(c.cached,0)::integer cached,
         'news'::text source_type, n.id source_id
       FROM news_articles n LEFT JOIN analysis_news_priorities pr ON pr.article_id=n.id
         LEFT JOIN totals t ON t.article_id=n.id LEFT JOIN cached c ON c.article_id=n.id
       WHERE n.status='published' AND COALESCE(t.total,0)>COALESCE(c.cached,0)`,
      [config.cachePromptVersions, config.model, config.mode],
    ),
    getPaperQuestionProgress(pool),
  ]);
  const papers = paperResult.rows.map(paper => {
    const progress = questionProgress.get(paper.id) ?? emptyQuestionProgress();
    return {
      ...paper, ...progress,
      sentence_total: paper.total, sentence_cached: paper.cached,
      total: paper.total + progress.analysis_text_total + progress.analysis_solving_total,
      cached: paper.cached + progress.analysis_text_cached + progress.analysis_solving_cached,
    };
  }).filter(paper => paper.total > paper.cached);
  return [...papers, ...newsResult.rows].sort((a, b) =>
    Number(b.priority) - Number(a.priority) || Number(a.sort_order) - Number(b.sort_order) ||
    Number(b.year) - Number(a.year) || Number(b.month) - Number(a.month) || String(a.id).localeCompare(String(b.id)),
  );
}

export async function reorderAdminPapers(
  items: unknown,
  actor = "admin-console",
) {
  if (!Array.isArray(items) || items.length > 500)
    throw new InvalidAdminSettingsError("Invalid paper ordering");
  const normalized = items.map((item, index) => {
    const row = item as {
      sourceType?: unknown;
      sourceId?: unknown;
      paperId?: unknown;
      priority?: unknown;
      sortOrder?: unknown;
    };
    const sourceType = row.sourceType === "news" ? "news" : row.sourceType === "paper" ? "paper" : null;
    const sourceId = typeof row.sourceId === "string" ? row.sourceId : row.paperId;
    if (
      !sourceType ||
      typeof sourceId !== "string" ||
      !Number.isInteger(row.priority) ||
      !Number.isInteger(row.sortOrder) ||
      Math.abs(row.priority as number) > 100 ||
      (row.sortOrder as number) < 0
    )
      throw new InvalidAdminSettingsError("Invalid paper ordering");
    return [
      sourceType,
      sourceId,
      row.priority as number,
      (row.sortOrder as number) || index,
    ];
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = normalized.map((row) => row[1]);
    const before = await client.query(
      `SELECT 'paper'::text source_type,paper_id source_id,priority,sort_order FROM analysis_paper_priorities WHERE paper_id=ANY($1::text[])
       UNION ALL SELECT 'news'::text source_type,article_id source_id,priority,sort_order FROM analysis_news_priorities WHERE article_id=ANY($1::text[])`,
      [ids],
    );
    for (const row of normalized) {
      if (row[0] === "news") {
        await client.query(
          `INSERT INTO analysis_news_priorities(article_id,priority,sort_order) VALUES($1,$2,$3) ON CONFLICT(article_id) DO UPDATE SET priority=EXCLUDED.priority,sort_order=EXCLUDED.sort_order,updated_at=NOW()`,
          [row[1], row[2], row[3]],
        );
      } else {
        await client.query(
          `INSERT INTO analysis_paper_priorities(paper_id,priority,sort_order) VALUES($1,$2,$3) ON CONFLICT(paper_id) DO UPDATE SET priority=EXCLUDED.priority,sort_order=EXCLUDED.sort_order,updated_at=NOW()`,
          [row[1], row[2], row[3]],
        );
      }
    }
    await audit(client, "papers.reordered", before.rows, normalized, actor);
    await client.query("COMMIT");
    return listAdminPapers();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const RETRY_CODES = new Set([
  "timeout",
  "service_unavailable",
  "invalid_result",
  "generation_failed",
]);
export async function retryAdminFailures(
  errorCode: string | undefined,
  limit = 100,
  actor = "admin-console",
) {
  if (errorCode && !RETRY_CODES.has(errorCode))
    throw new InvalidAdminSettingsError("Invalid error type");
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit || 100)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH picked AS(SELECT id FROM analysis_jobs WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND status='failed' AND($4::text IS NULL OR CASE WHEN error_message~*'abort|timed? ?out|timeout' THEN'timeout' WHEN error_message~*'AI request failed|fetch failed|AI response did not contain' THEN'service_unavailable' WHEN error_message~*'Grammar|Vocabulary|Translation|AI word|word token|validation|JSON|Unexpected token' THEN'invalid_result' ELSE'generation_failed' END=$4) ORDER BY finished_at ASC LIMIT $5 FOR UPDATE SKIP LOCKED) UPDATE analysis_jobs j SET status='pending',attempts=0,error_message=NULL,lease_expires_at=NULL,started_at=NULL,finished_at=NULL,next_attempt_at=NOW(),updated_at=NOW() FROM picked WHERE j.id=picked.id RETURNING j.id`,
      [
        config.mode,
        config.model,
        config.promptVersion,
        errorCode ?? null,
        safeLimit,
      ],
    );
    await audit(
      client,
      "jobs.retried",
      { errorCode: errorCode ?? null, limit: safeLimit },
      { count: result.rowCount ?? 0 },
      actor,
    );
    await client.query("COMMIT");
    return { retried: result.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listAdminAudit(limit = 50) {
  const result = await pool.query(
    `SELECT id,changed_at,actor,action,before_json AS before,after_json AS after FROM analysis_config_audit ORDER BY changed_at DESC LIMIT $1`,
    [Math.max(1, Math.min(200, Math.trunc(limit || 50)))],
  );
  return result.rows.map((row) => ({
    ...row,
    changedAt: asIso(row.changed_at),
  }));
}

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
import { getAdminPriority } from "./admin-priority.js";

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

export async function getAdminOverview(jobType?: string, jobStatus?: string, page = 0, limit = 20) {
  const settings = await getAdminSettings();
  const safeLimit = Math.min(50, Math.max(10, Math.trunc(limit || 20)));
  const safePage = Math.min(10000, Math.max(0, Math.trunc(page || 0)));
  const params = [config.mode, config.model, config.promptVersion];
  const [priority, queue, jobs] = await Promise.all([
    getAdminPriority(),
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
      id: string; job_type: 'sentence' | 'text' | 'question'; text_key: string | null;
      status: string; attempts: number; error_message: string | null;
      paper_id: string | null; article_id: string | null; exam_level: string | null;
      title: string; section_title: string | null; source_text: string;
      question_id: string | null; sentence_id: string | null;
      created_at: Date; started_at: Date | null; finished_at: Date | null; next_attempt_at: Date;
    }>(
      `SELECT j.id, j.job_type, j.text_key, j.question_id, j.sentence_id, j.attempts, j.error_message,
         CASE WHEN j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW())
              THEN 'pending' ELSE j.status END status,
         p.id paper_id, n.id article_id, p.exam_level,
         COALESCE(p.title,n.title,j.context_json->>'title','') title, ps.title section_title,
         LEFT(CASE WHEN j.job_type='question' THEN COALESCE(j.question_json->>'prompt',q.prompt,'')
                   ELSE j.source_text END,240) source_text,
         j.created_at, j.started_at, j.finished_at, j.next_attempt_at
       FROM analysis_jobs j LEFT JOIN sentences s ON s.id=j.sentence_id
       LEFT JOIN questions q ON q.id=j.question_id LEFT JOIN paper_sections ps ON ps.id=q.section_id
       LEFT JOIN papers p ON p.id=COALESCE(ps.paper_id,s.paper_id)
       LEFT JOIN news_articles n ON n.id=s.article_id
       WHERE j.mode=$1 AND j.model=$2 AND j.prompt_version=$3
         AND (j.status IN ('pending','running') OR j.finished_at>=NOW()-INTERVAL '24 hours'
           OR ($5='failed' AND j.status='failed'))
         AND ($4::text IS NULL OR j.job_type=$4)
         AND ($5::text IS NULL OR ($5='active' AND j.status IN ('pending','running'))
           OR CASE WHEN j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW())
              THEN 'pending' ELSE j.status END=$5)
       ORDER BY CASE WHEN j.status='running' AND j.lease_expires_at>NOW() THEN 0
                     WHEN j.status IN ('pending','running') THEN 1 ELSE 2 END,
                j.updated_at DESC, j.id DESC LIMIT ${safeLimit + 1} OFFSET ${safePage * safeLimit}`,
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
  return {
    observedAt: new Date().toISOString(),
    priority,
    model: config.model,
    mode: config.mode,
    promptVersion: config.promptVersion,
    settings: {
      workerConcurrency: settings.workerConcurrency,
      queueCapacity: settings.queueCapacity,
      backfillPaused: settings.backfillPaused,
    },
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
    jobs: jobs.rows.slice(0, safeLimit).map(row => ({
      id: row.id, type: row.job_type, textKey: row.text_key, status: row.status,
      paperId: row.paper_id, articleId: row.article_id, examLevel: row.exam_level,
      title: row.title, sectionTitle: row.section_title, source: row.source_text,
      questionId: row.question_id, sentenceId: row.sentence_id, attempts: row.attempts,
      errorCode: row.error_message ? analysisErrorCode(row.error_message) : null,
      createdAt: asIso(row.created_at), startedAt: asIso(row.started_at),
      finishedAt: asIso(row.finished_at), nextAttemptAt: asIso(row.next_attempt_at),
    })),
    jobsPage: {
      page: safePage,
      limit: safeLimit,
      hasMore: jobs.rows.length > safeLimit,
    },
  };
}

export async function getAdminJobDetail(id: string) {
  const result = await pool.query<{
    id: string; status: string; job_type: string; attempts: number;
    error_message: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
  }>(
    `SELECT id,status,job_type,attempts,error_message,created_at,started_at,finished_at
     FROM analysis_jobs
     WHERE id=$1 AND mode=$2 AND model=$3 AND prompt_version=$4`,
    [id, config.mode, config.model, config.promptVersion],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    type: row.job_type,
    attempts: row.attempts,
    errorMessage: row.error_message,
    createdAt: asIso(row.created_at),
    startedAt: asIso(row.started_at),
    finishedAt: asIso(row.finished_at),
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
  jobId?: string,
  jobType?: string,
) {
  if (errorCode && !RETRY_CODES.has(errorCode)) throw new InvalidAdminSettingsError("Invalid error type");
  if (jobId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId))
    throw new InvalidAdminSettingsError("Invalid job ID");
  if (jobType && !['sentence', 'text', 'question'].includes(jobType)) throw new InvalidAdminSettingsError("Invalid job type");
  if (!Number.isFinite(limit)) throw new InvalidAdminSettingsError("Invalid retry limit");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Retry uses the same admission lock and queue bounds as a reader request.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `analysis:${config.mode}:${config.model}:${config.promptVersion}`,
    ]);
    const runtime = await readRuntimeSettings(client, config);
    const safeLimit = Math.min(runtime.queueCapacity, Math.max(1, Math.trunc(limit || 100)));
    const candidates = await client.query<{ id: string }>(
      `SELECT j.id FROM analysis_jobs j JOIN (
         SELECT DISTINCT ON (job_type,sentence_id,question_id,text_key,source_hash,context_hash) id
         FROM analysis_jobs failed
         WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND status='failed'
           AND ($6::uuid IS NULL OR id=$6::uuid) AND ($7::text IS NULL OR job_type=$7)
           AND ($4::text IS NULL OR CASE WHEN error_message~*'abort|timed? ?out|timeout' THEN 'timeout'
             WHEN error_message~*'AI request failed|fetch failed|AI response did not contain' THEN 'service_unavailable'
             WHEN error_message~*'Grammar|Vocabulary|Translation|AI word|word token|validation|JSON|Unexpected token' THEN 'invalid_result'
             ELSE 'generation_failed' END=$4)
           AND NOT EXISTS (SELECT 1 FROM analysis_jobs active
             WHERE active.mode=failed.mode AND active.model=failed.model AND active.prompt_version=failed.prompt_version
               AND active.status IN ('pending','running') AND active.job_type=failed.job_type
               AND active.sentence_id IS NOT DISTINCT FROM failed.sentence_id
               AND active.question_id IS NOT DISTINCT FROM failed.question_id
               AND active.text_key IS NOT DISTINCT FROM failed.text_key
               AND active.source_hash=failed.source_hash AND active.context_hash=failed.context_hash)
         ORDER BY job_type,sentence_id,question_id,text_key,source_hash,context_hash,updated_at DESC
       ) eligible ON eligible.id=j.id
       ORDER BY j.finished_at ASC LIMIT $5 FOR UPDATE OF j SKIP LOCKED`,
      [config.mode, config.model, config.promptVersion, errorCode ?? null, safeLimit, jobId ?? null, jobType ?? null],
    );
    if (!candidates.rows.length) { await client.query('COMMIT'); return { retried: 0 }; }
    const active = await client.query<{ count: number }>(
      `SELECT COUNT(*)::integer count FROM analysis_jobs
       WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND status IN ('pending','running')`,
      [config.mode, config.model, config.promptVersion],
    );
    const activeCount = active.rows[0]?.count ?? 0;
    let slots = Math.max(0, runtime.queueCapacity - activeCount);
    if (slots < candidates.rows.length) {
      const evicted = await client.query(
        `DELETE FROM analysis_jobs WHERE id IN (
           SELECT id FROM analysis_jobs WHERE mode=$1 AND model=$2 AND prompt_version=$3
             AND status='pending' AND priority<=1 AND attempts=0
           ORDER BY created_at DESC LIMIT $4 FOR UPDATE SKIP LOCKED
         ) RETURNING id`,
        [config.mode, config.model, config.promptVersion, activeCount + candidates.rows.length - runtime.queueCapacity],
      );
      slots = Math.max(0, runtime.queueCapacity - activeCount + (evicted.rowCount ?? 0));
    }
    const ids = candidates.rows.slice(0, slots).map(row => row.id);
    if (!ids.length) { await client.query('COMMIT'); return { retried: 0 }; }
    const result = await client.query(
      `UPDATE analysis_jobs SET status='pending',priority=GREATEST(priority,100),attempts=0,error_message=NULL,
         lease_expires_at=NULL,started_at=NULL,finished_at=NULL,next_attempt_at=NOW(),updated_at=NOW()
       WHERE id=ANY($1::uuid[]) AND status='failed' RETURNING id`,
      [ids],
    );
    await audit(client, "jobs.retried", { errorCode, jobId, jobType, limit: safeLimit }, { count: result.rowCount ?? 0 }, actor);
    await client.query("COMMIT");
    return { retried: result.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function clearAdminFailures(
  jobType?: string,
  actor = "admin-console",
) {
  if (jobType && !['sentence', 'text', 'question'].includes(jobType)) {
    throw new InvalidAdminSettingsError("Invalid job type");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `analysis:${config.mode}:${config.model}:${config.promptVersion}`,
    ]);
    const result = await client.query(
      `DELETE FROM analysis_jobs
       WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND status='failed'
         AND ($4::text IS NULL OR job_type=$4)
       RETURNING id`,
      [config.mode, config.model, config.promptVersion, jobType ?? null],
    );
    await audit(
      client,
      "jobs.failures_cleared",
      { jobType: jobType ?? null },
      { count: result.rowCount ?? 0 },
      actor,
    );
    await client.query("COMMIT");
    return { cleared: result.rowCount ?? 0 };
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

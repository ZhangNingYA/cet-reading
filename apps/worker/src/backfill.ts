import { createHash } from 'node:crypto';
import { contextHash, validateAnalysis, type SentenceAnalysis } from '@cet-reading/contracts';
import type { RuntimeConfig } from '@cet-reading/contracts/config';
import type { Pool } from 'pg';
import { readRuntimeSettings } from './runtime-settings.js';
import { fillPriorityQueue } from '@cet-reading/contracts/analysis-priority';

const BACKGROUND_PRIORITY = 1;

type Candidate = {
  id: string;
  owner_id: string;
  source_text: string;
  source_hash: string;
  paper_id: string | null;
  article_id: string | null;
  section_id: string | null;
  title: string;
  previous_sentence: string | null;
  next_sentence: string | null;
  paragraph_index: number;
  sentence_index: number;
  news_batch_at: Date | string | null;
  news_published_at: Date | string | null;
};

type CandidateWithContext = Candidate & {
  context_json: { title: string; previousSentence: string | null; nextSentence: string | null };
  context_hash: string;
};

type Cursor = {
  source: 'news' | 'paper';
  owner_id: string;
  paragraph_index: number;
  sentence_index: number;
  batch_at: string | null;
  published_at: string | null;
};

type ExistingCache = {
  sentence_id: string;
  source_hash: string;
  context_hash: string;
  analysis_json: unknown;
};

type ExistingJob = {
  sentence_id: string;
  source_hash: string;
  context_hash: string;
  status: string;
};

type QuestionTextCandidate = {
  question_id: string;
  text_key: string;
  source_text: string;
  title: string;
  content_hash: string;
  context_json: { title: string; previousSentence: null; nextSentence: null };
};

type QuestionTextCursor = { question_id: string; text_key: string };

type ExistingQuestionTextJob = {
  question_id: string;
  text_key: string;
  source_hash: string;
  status: string;
};

function toIso(value: Date | string | null | undefined) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cursorFromCandidate(candidate: Candidate): Cursor {
  const news = Boolean(candidate.article_id);
  return {
    source: news ? 'news' : 'paper',
    owner_id: candidate.owner_id,
    paragraph_index: candidate.paragraph_index,
    sentence_index: candidate.sentence_index,
    batch_at: news ? toIso(candidate.news_batch_at) : null,
    published_at: news ? toIso(candidate.news_published_at) : null,
  };
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function loadCandidates(pool: Pool, limit: number, cursor: Cursor | null) {
  const cursorClause = cursor ? `AND (
    (
      $1::text = 'news' AND (
        article_id IS NULL OR (
          article_id IS NOT NULL AND (
            news_batch_at < $2::timestamptz OR
            (news_batch_at = $2::timestamptz AND (
              news_published_at < $3::timestamptz OR
              (news_published_at = $3::timestamptz AND (
                article_id < $4::text OR
                (article_id = $4::text AND
                  (paragraph_index, sentence_index) > ($5::integer, $6::integer))
                )
              )
            ))
          )
        )
      )
    ) OR (
      $1::text = 'paper' AND article_id IS NULL AND (
        paper_id > $4::text OR
        (paper_id = $4::text AND
          (paragraph_index, sentence_index) > ($5::integer, $6::integer))
      )
    )
  )` : '';
  const params = cursor
    ? [cursor.source, cursor.batch_at, cursor.published_at, cursor.owner_id,
      cursor.paragraph_index, cursor.sentence_index, limit]
    : [limit];
  const limitParameter = cursor ? '$7' : '$1';
  const result = await pool.query<Candidate>(
    `WITH ordered AS (
       SELECT s.id, COALESCE(s.paper_id, s.article_id) AS owner_id,
              s.source_text, s.source_hash, s.paper_id, s.article_id,
              s.section_id,
              COALESCE(p.title, n.title, '') AS title,
              n.batch_at AS news_batch_at, n.published_at AS news_published_at,
              lag(s.source_text) OVER w AS previous_sentence,
              lead(s.source_text) OVER w AS next_sentence,
              s.paragraph_index, s.sentence_index
       FROM sentences s
       LEFT JOIN papers p ON p.id = s.paper_id
       LEFT JOIN news_articles n ON n.id = s.article_id
       WHERE (p.status = 'published' OR n.status = 'published')
       WINDOW w AS (
         PARTITION BY s.paper_id, s.article_id
         ORDER BY s.paragraph_index, s.sentence_index
       )
     )
     SELECT * FROM ordered
     WHERE NOT EXISTS (
             SELECT 1 FROM shared_paper_sections shared
             WHERE shared.paper_id = ordered.paper_id
               AND shared.section_id = ordered.section_id
           )
       ${cursorClause}
     ORDER BY (article_id IS NOT NULL) DESC,
              news_batch_at DESC NULLS LAST,
              news_published_at DESC NULLS LAST,
              CASE WHEN article_id IS NOT NULL THEN article_id END DESC NULLS LAST,
              CASE WHEN article_id IS NULL THEN paper_id END ASC NULLS LAST,
              paragraph_index, sentence_index
     LIMIT ${limitParameter}`,
    params,
  );
  return result.rows.map(row => {
    const context_json = {
      title: row.title,
      previousSentence: row.previous_sentence,
      nextSentence: row.next_sentence,
    };
    return { ...row, context_json, context_hash: contextHash(context_json) };
  });
}

async function loadExisting(pool: Pool, candidates: CandidateWithContext[], config: RuntimeConfig) {
  if (!candidates.length) return { caches: new Map<string, SentenceAnalysis>(), jobs: new Map<string, ExistingJob>() };
  const ids = candidates.map(candidate => candidate.id);
  const [cacheRows, jobRows] = await Promise.all([
    pool.query<ExistingCache>(
      `SELECT sentence_id, source_hash, context_hash, analysis_json
       FROM sentence_analyses
       WHERE sentence_id = ANY($1::text[]) AND prompt_version = $2
         AND model = $3 AND mode = $4 AND status = 'succeeded'`,
      [ids, config.promptVersion, config.model, config.mode],
    ),
    pool.query<ExistingJob>(
      `SELECT sentence_id, source_hash, context_hash, status
       FROM analysis_jobs
       WHERE sentence_id = ANY($1::text[]) AND prompt_version = $2
         AND model = $3 AND mode = $4`,
      [ids, config.promptVersion, config.model, config.mode],
    ),
  ]);
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const caches = new Map<string, SentenceAnalysis>();
  for (const row of cacheRows.rows) {
    const candidate = byId.get(row.sentence_id);
    if (!candidate || caches.has(row.sentence_id) ||
        candidate.source_hash !== row.source_hash || candidate.context_hash !== row.context_hash) continue;
    try {
      caches.set(row.sentence_id, validateAnalysis(candidate.source_text, row.analysis_json));
    } catch {
      // Invalid historical results must be regenerated by the queue.
    }
  }
  const jobs = new Map<string, ExistingJob>();
  for (const row of jobRows.rows) {
    const candidate = byId.get(row.sentence_id);
    if (candidate && candidate.source_hash === row.source_hash && candidate.context_hash === row.context_hash) {
      const previous = jobs.get(row.sentence_id);
      if (!previous || previous.status === 'succeeded') jobs.set(row.sentence_id, row);
    }
  }
  return { caches, jobs };
}

async function loadQuestionTextCandidates(pool: Pool, limit: number, cursor: QuestionTextCursor | null) {
  const result = await pool.query<Omit<QuestionTextCandidate, 'content_hash' | 'context_json'>>(
    `WITH visible_questions AS (
       SELECT q.id AS question_id, q.prompt, q.options_json, ps.kind, ps.title
       FROM questions q
       JOIN paper_sections ps ON ps.id = q.section_id
       JOIN papers p ON p.id = ps.paper_id
       WHERE p.status = 'published' AND ps.kind IN ('reading', 'matching')
         AND NOT EXISTS (
           SELECT 1 FROM shared_paper_sections shared
           WHERE shared.paper_id = p.id AND shared.section_id = ps.id
         )
     ), question_texts AS (
       SELECT question_id, 'prompt'::text AS text_key,
              regexp_replace(prompt, '^[[:space:]]*[0-9]+[.)][[:space:]]*', '') AS source_text,
              title
       FROM visible_questions
       UNION ALL
       SELECT question_id, 'option:' || (opt.value->>'key') AS text_key,
              opt.value->>'text' AS source_text, title
       FROM visible_questions
       CROSS JOIN LATERAL jsonb_array_elements(options_json) AS opt(value)
       WHERE kind = 'reading'
     )
     SELECT question_id, text_key, source_text, title
     FROM question_texts
     WHERE NULLIF(BTRIM(source_text), '') IS NOT NULL
       AND ($1::text IS NULL OR (question_id, text_key) > ($1::text, $2::text))
     ORDER BY question_id, text_key
     LIMIT $3`,
    [cursor?.question_id ?? null, cursor?.text_key ?? null, limit],
  );
  return result.rows.map(row => {
    const content_hash = createHash('sha256')
      .update(JSON.stringify({ questionId: row.question_id, textKey: row.text_key, source: row.source_text }))
      .digest('hex');
    return {
      ...row,
      content_hash,
      context_json: { title: row.title, previousSentence: null, nextSentence: null },
    };
  });
}

function questionTextKey(candidate: Pick<QuestionTextCandidate, 'question_id' | 'text_key'>) {
  return `${candidate.question_id}\u0000${candidate.text_key}`;
}

async function loadExistingQuestionText(pool: Pool, candidates: QuestionTextCandidate[], config: RuntimeConfig) {
  if (!candidates.length) return { caches: new Set<string>(), jobs: new Map<string, ExistingQuestionTextJob>() };
  const questionIds = [...new Set(candidates.map(candidate => candidate.question_id))];
  const [cacheRows, jobRows] = await Promise.all([
    pool.query<{ question_id: string; content_hash: string; analysis_json: unknown }>(
      `SELECT question_id, content_hash, analysis_json
       FROM question_analyses
       WHERE question_id = ANY($1::text[]) AND prompt_version = ANY($2::text[])
         AND model = $3 AND mode = $4 AND status = 'succeeded'`,
      [questionIds, config.cachePromptVersions, config.model, config.mode],
    ),
    pool.query<ExistingQuestionTextJob>(
      `SELECT question_id, text_key, source_hash, status
       FROM analysis_jobs
       WHERE job_type = 'text' AND question_id = ANY($1::text[])
         AND prompt_version = $2 AND model = $3 AND mode = $4
       ORDER BY updated_at DESC`,
      [questionIds, config.promptVersion, config.model, config.mode],
    ),
  ]);
  const byHash = new Map(candidates.map(candidate => [`${candidate.question_id}\u0000${candidate.content_hash}`, candidate]));
  const caches = new Set<string>();
  for (const row of cacheRows.rows) {
    const candidate = byHash.get(`${row.question_id}\u0000${row.content_hash}`);
    if (!candidate) continue;
    try {
      validateAnalysis(candidate.source_text, row.analysis_json);
      caches.add(questionTextKey(candidate));
    } catch {
      // Invalid or mismatched history is not a cache hit.
    }
  }
  const byKey = new Map(candidates.map(candidate => [questionTextKey(candidate), candidate]));
  const jobs = new Map<string, ExistingQuestionTextJob>();
  for (const row of jobRows.rows) {
    const candidate = byKey.get(questionTextKey(row));
    const key = questionTextKey(row);
    if (candidate && candidate.content_hash === row.source_hash && !jobs.has(key)) jobs.set(key, row);
  }
  return { caches, jobs };
}

async function enqueueBackgroundSentence(pool: Pool, sentence: CandidateWithContext, config: RuntimeConfig) {
  const client = await pool.connect();
  const key = [sentence.id, sentence.source_hash, sentence.context_hash, config.promptVersion, config.model, config.mode];
  try {
    await client.query('BEGIN');
    // Share the API's admission lock, including the capacity check below.
    // A scan is only a plan: user requests can arrive while it is running.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `analysis:${config.mode}:${config.model}:${config.promptVersion}`,
    ]);
    const runtime = await readRuntimeSettings(client, config);
    const existing = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM analysis_jobs
       WHERE sentence_id = $1 AND source_hash = $2 AND context_hash = $3
         AND prompt_version = $4 AND model = $5 AND mode = $6
       ORDER BY updated_at DESC LIMIT 1`, key,
    );
    const row = existing.rows[0];
    if (row?.status === 'pending' || row?.status === 'running' || row?.status === 'failed') {
      await client.query('ROLLBACK');
      return false;
    }
    const counts = await client.query<{ total: number; background: number }>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'running'))::integer AS total,
              COUNT(*) FILTER (WHERE status IN ('pending', 'running') AND priority <= $4)::integer AS background
       FROM analysis_jobs
       WHERE mode = $1 AND model = $2 AND prompt_version = $3`,
      [config.mode, config.model, config.promptVersion, BACKGROUND_PRIORITY],
    );
    if ((counts.rows[0]?.total ?? 0) >= runtime.queueCapacity ||
        (counts.rows[0]?.background ?? 0) >= runtime.backgroundTarget) {
      await client.query('ROLLBACK');
      return false;
    }
    if (row?.status === 'succeeded') {
      await client.query(
        `UPDATE analysis_jobs SET status = 'pending', priority = $2,
         error_message = NULL, attempts = 0, lease_expires_at = NULL,
         started_at = NULL, finished_at = NULL, next_attempt_at = NOW(), updated_at = NOW()
         WHERE id = $1`, [row.id, BACKGROUND_PRIORITY],
      );
    } else {
      await client.query(
        `INSERT INTO analysis_jobs
           (sentence_id, source_text, source_hash, context_hash, context_json,
            prompt_version, model, mode, status, priority, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, NOW())`,
        [sentence.id, sentence.source_text, sentence.source_hash, sentence.context_hash,
          JSON.stringify(sentence.context_json), config.promptVersion, config.model, config.mode, BACKGROUND_PRIORITY],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Another enqueue path may have won the per-sentence lock between scans.
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  } finally {
    client.release();
  }
}

async function availableBackgroundCapacity(pool: Pool, config: RuntimeConfig) {
  const runtime = await readRuntimeSettings(pool, config);
  if (!config.backfillEnabled || config.mode !== 'ai' || runtime.backfillPaused || runtime.backgroundTarget === 0) return 0;
  const counts = await pool.query<{ total: number; background: number }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'running'))::integer AS total,
            COUNT(*) FILTER (WHERE status IN ('pending', 'running') AND priority <= $4)::integer AS background
     FROM analysis_jobs WHERE mode = $1 AND model = $2 AND prompt_version = $3`,
    [config.mode, config.model, config.promptVersion, BACKGROUND_PRIORITY],
  );
  const total = counts.rows[0]?.total ?? 0;
  const background = counts.rows[0]?.background ?? 0;
  return Math.max(0, Math.min(runtime.backgroundTarget - background, runtime.queueCapacity - total));
}

async function enqueueBackgroundQuestionText(pool: Pool, candidate: QuestionTextCandidate, config: RuntimeConfig) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `analysis:${config.mode}:${config.model}:${config.promptVersion}`,
    ]);
    const runtime = await readRuntimeSettings(client, config);
    const existing = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM analysis_jobs
       WHERE job_type = 'text' AND question_id = $1 AND text_key = $2 AND source_hash = $3
         AND prompt_version = $4 AND model = $5 AND mode = $6
       ORDER BY updated_at DESC LIMIT 1`,
      [candidate.question_id, candidate.text_key, candidate.content_hash,
        config.promptVersion, config.model, config.mode],
    );
    const row = existing.rows[0];
    if (row?.status === 'pending' || row?.status === 'running' || row?.status === 'failed') {
      await client.query('ROLLBACK');
      return false;
    }
    const counts = await client.query<{ total: number; background: number }>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'running'))::integer AS total,
              COUNT(*) FILTER (WHERE status IN ('pending', 'running') AND priority <= $4)::integer AS background
       FROM analysis_jobs WHERE mode = $1 AND model = $2 AND prompt_version = $3`,
      [config.mode, config.model, config.promptVersion, BACKGROUND_PRIORITY],
    );
    if ((counts.rows[0]?.total ?? 0) >= runtime.queueCapacity ||
        (counts.rows[0]?.background ?? 0) >= runtime.backgroundTarget) {
      await client.query('ROLLBACK');
      return false;
    }
    if (row?.status === 'succeeded') {
      await client.query(
        `UPDATE analysis_jobs SET status = 'pending', priority = $2,
         error_message = NULL, attempts = 0, lease_expires_at = NULL,
         started_at = NULL, finished_at = NULL, next_attempt_at = NOW(), updated_at = NOW()
         WHERE id = $1`, [row.id, BACKGROUND_PRIORITY],
      );
    } else {
      await client.query(
        `INSERT INTO analysis_jobs
           (job_type, question_id, text_key, sentence_id, source_text, source_hash,
            context_hash, context_json, question_json, prompt_version, model, mode,
            status, priority, next_attempt_at)
         VALUES ('text', $1, $2, NULL, $3, $4, $4, $5, $6, $7, $8, $9, 'pending', $10, NOW())`,
        [candidate.question_id, candidate.text_key, candidate.source_text, candidate.content_hash,
          JSON.stringify(candidate.context_json),
          JSON.stringify({ source_text: candidate.source_text, context_json: candidate.context_json }),
          config.promptVersion, config.model, config.mode, BACKGROUND_PRIORITY],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  } finally {
    client.release();
  }
}

export async function fillBackgroundQuestionTextQueue(
  pool: Pool, config: RuntimeConfig, cursor: QuestionTextCursor | null = null, maxQueued = Number.POSITIVE_INFINITY,
) {
  const capacity = Math.min(await availableBackgroundCapacity(pool, config), maxQueued);
  if (capacity <= 0) return { queued: 0, nextCursor: cursor, scanHasMore: false };
  const candidateLimit = Math.max(50, capacity * 10);
  const candidates = await loadQuestionTextCandidates(pool, candidateLimit, cursor);
  if (!candidates.length) return { queued: 0, nextCursor: null, scanHasMore: false };
  const { caches, jobs } = await loadExistingQuestionText(pool, candidates, config);
  let queued = 0;
  let lastExamined = candidates[0]!;
  for (const candidate of candidates) {
    if (queued >= capacity) break;
    lastExamined = candidate;
    const key = questionTextKey(candidate);
    if (caches.has(key)) continue;
    const job = jobs.get(key);
    if (job?.status === 'pending' || job?.status === 'running' || job?.status === 'failed') continue;
    if (await enqueueBackgroundQuestionText(pool, candidate, config)) queued += 1;
  }
  return {
    queued,
    nextCursor: { question_id: lastExamined.question_id, text_key: lastExamined.text_key },
    scanHasMore: queued < capacity && candidates.length === candidateLimit,
  };
}

export async function fillBackgroundQueue(
  pool: Pool, config: RuntimeConfig, cursor: Cursor | null = null, maxQueued = Number.POSITIVE_INFINITY,
) {
  const runtime = await readRuntimeSettings(pool, config);
  if (!config.backfillEnabled || config.mode !== 'ai' || runtime.backfillPaused || runtime.backgroundTarget === 0) {
    return { queued: 0, nextCursor: cursor, scanHasMore: false };
  }
  const counts = await pool.query<{ total: number; background: number }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'running'))::integer AS total,
            COUNT(*) FILTER (WHERE status IN ('pending', 'running') AND priority <= $4)::integer AS background
     FROM analysis_jobs
     WHERE mode = $1 AND model = $2 AND prompt_version = $3`,
    [config.mode, config.model, config.promptVersion, BACKGROUND_PRIORITY],
  );
  const total = counts.rows[0]?.total ?? 0;
  const background = counts.rows[0]?.background ?? 0;
  const capacity = Math.min(runtime.backgroundTarget - background, runtime.queueCapacity - total, maxQueued);
  if (capacity <= 0) return { queued: 0, nextCursor: cursor, scanHasMore: false };

  const candidateLimit = Math.max(50, capacity * 10);
  const candidates = await loadCandidates(pool, candidateLimit, cursor);
  if (!candidates.length) return { queued: 0, nextCursor: null, scanHasMore: false };
  const { caches, jobs } = await loadExisting(pool, candidates, config);
  let queued = 0;
  let lastExamined = candidates[0]!;
  for (const candidate of candidates) {
    if (queued >= capacity) break;
    lastExamined = candidate;
    if (caches.has(candidate.id)) continue;
    const job = jobs.get(candidate.id);
    if (job?.status === 'pending' || job?.status === 'running' || job?.status === 'failed') continue;
    if (await enqueueBackgroundSentence(pool, candidate, config)) queued += 1;
  }
  return {
    queued,
    nextCursor: cursorFromCandidate(lastExamined),
    // Cached pages are common after a restart. Scan the next page immediately
    // instead of leaving worker slots idle for a full scheduler interval.
    scanHasMore: queued < capacity && candidates.length === candidateLimit,
  };
}

export async function runBackfillScheduler(pool: Pool, config: RuntimeConfig, signal: AbortSignal) {
  let sentenceCursor: Cursor | null = null;
  let questionTextCursor: QuestionTextCursor | null = null;
  let questionTextFirst = false;
  while (!signal.aborted) {
    let scanHasMore = false;
    try {
      const priority = await fillPriorityQueue(pool, config, db => readRuntimeSettings(db, config));
      if (priority.queued) process.stdout.write(`Priority analysis queued ${priority.queued} item(s).\n`);
      if (priority.active || !config.backfillEnabled || config.mode !== 'ai') {
        await sleep(Math.min(config.backfillIntervalMs, 3000), signal);
        continue;
      }
      const runtime = await readRuntimeSettings(pool, config);
      if (runtime.backfillPaused) {
        sentenceCursor = null;
        questionTextCursor = null;
        await sleep(config.backfillIntervalMs, signal);
        continue;
      }
      const available = await availableBackgroundCapacity(pool, config);
      if (available > 0) {
        const firstLimit = Math.ceil(available / 2);
        let sentenceResult: Awaited<ReturnType<typeof fillBackgroundQueue>>;
        let questionTextResult: Awaited<ReturnType<typeof fillBackgroundQuestionTextQueue>>;
        if (questionTextFirst) {
          questionTextResult = await fillBackgroundQuestionTextQueue(pool, config, questionTextCursor, firstLimit);
          questionTextCursor = questionTextResult.nextCursor;
          sentenceResult = await fillBackgroundQueue(pool, config, sentenceCursor, available - questionTextResult.queued);
          sentenceCursor = sentenceResult.nextCursor;
        } else {
          sentenceResult = await fillBackgroundQueue(pool, config, sentenceCursor, firstLimit);
          sentenceCursor = sentenceResult.nextCursor;
          questionTextResult = await fillBackgroundQuestionTextQueue(pool, config, questionTextCursor, available - sentenceResult.queued);
          questionTextCursor = questionTextResult.nextCursor;
        }
        questionTextFirst = !questionTextFirst;
        const queued = sentenceResult.queued + questionTextResult.queued;
        scanHasMore = sentenceResult.scanHasMore || questionTextResult.scanHasMore;
        if (queued) {
          process.stdout.write(`Background analysis queued ${queued} item(s) (${sentenceResult.queued} sentence, ${questionTextResult.queued} question text).\n`);
        }
      }
    } catch (error) {
      process.stderr.write(`Background analysis scheduler: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (!scanHasMore) await sleep(config.backfillIntervalMs, signal);
  }
}

import { createHash } from 'node:crypto';
import { contextHash, validateAnalysis, validateQuestionAnalysis } from './index.js';
import { ANALYSIS_BATCH_LOCK_ID } from './analysis-jobs.js';
import type { RuntimeConfig } from './config.js';

// Server-only helpers shared by the admin API and worker.
export type PriorityType = 'sentence' | 'text' | 'question';
export const ADMIN_PRIORITY = 200;
export type PriorityTarget = {
  revision: string; paperId: string; sectionId: string | null; type: PriorityType;
  title: string; sectionTitle: string | null; finishedAt: Date | string | null;
  selectedAt: Date | string;
};
export type PriorityDatabase = {
  query<T extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>;
};
type PriorityClient = PriorityDatabase & { release(): void };
type PriorityPool = PriorityDatabase & { connect(): Promise<PriorityClient> };
type PriorityConfig = Pick<RuntimeConfig, 'mode' | 'model' | 'promptVersion' | 'cachePromptVersions'>;
export type PriorityCandidate = {
  type: PriorityType; sectionId: string; sentenceId: string | null; questionId: string | null;
  textKey: string | null; source: string; sourceHash: string; contextHash: string;
  context: object; question: object | null; validate(value: unknown): unknown;
};
export type PriorityState = { candidate: PriorityCandidate; state: 'cached' | 'missing' | 'pending' | 'running' | 'failed'; jobId?: string; jobUpdatedAt?: Date | string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (type: string, sentence: string | null, question: string | null, text: string | null, source: string, context: string) =>
  JSON.stringify([type, sentence, question, text, source, context]);
const candidateIdentity = (c: PriorityCandidate) => identity(c.type, c.sentenceId, c.questionId, c.textKey, c.sourceHash, c.contextHash);

export async function readPriorityTarget(db: PriorityDatabase, lock = false): Promise<PriorityTarget | null> {
  const result = await db.query<PriorityTarget>(
    `SELECT t.revision, t.paper_id AS "paperId", t.section_id AS "sectionId", t.job_type AS type,
            p.title, ps.title AS "sectionTitle", t.finished_at AS "finishedAt", t.updated_at AS "selectedAt"
     FROM analysis_priority_target t JOIN papers p ON p.id=t.paper_id
     LEFT JOIN paper_sections ps ON ps.id=t.section_id WHERE t.id=TRUE
     ${lock ? 'FOR UPDATE OF t' : ''}`,
  );
  return result.rows[0] ?? null;
}

export async function loadPriorityCandidates(
  db: PriorityDatabase, target: { paperId: string; sectionId: string | null; type?: PriorityType },
) {
  const candidates: PriorityCandidate[] = [];
  if (!target.type || target.type === 'sentence') {
    const result = await db.query<{
      id: string; section_id: string; source_text: string; source_hash: string;
      title: string; previous_sentence: string | null; next_sentence: string | null;
    }>(
      `WITH ordered AS (
         SELECT s.id,s.section_id,s.source_text,s.source_hash,p.title,
                lag(s.source_text) OVER w AS previous_sentence,lead(s.source_text) OVER w AS next_sentence
         FROM sentences s JOIN papers p ON p.id=s.paper_id WHERE p.id=$1 AND p.status='published'
         WINDOW w AS (PARTITION BY s.paper_id ORDER BY s.paragraph_index,s.sentence_index)
       ) SELECT * FROM ordered WHERE section_id IS NOT NULL AND ($2::text IS NULL OR section_id=$2)
         AND NOT EXISTS (SELECT 1 FROM shared_paper_sections shared
           WHERE shared.paper_id=$1 AND shared.section_id=ordered.section_id)`,
      [target.paperId, target.sectionId],
    );
    for (const row of result.rows) {
      const context = { title: row.title, previousSentence: row.previous_sentence, nextSentence: row.next_sentence };
      candidates.push({
        type: 'sentence', sectionId: row.section_id, sentenceId: row.id, questionId: null, textKey: null,
        source: row.source_text, sourceHash: row.source_hash, contextHash: contextHash(context), context,
        question: null, validate: value => validateAnalysis(row.source_text, value),
      });
    }
  }
  if (!target.type || target.type !== 'sentence') {
    const result = await db.query<{
      id: string; section_id: string; question_type: 'reading' | 'matching'; title: string; instructions: string;
      paragraphs: string[]; prompt: string; options: Array<{ key: string; text: string }>; answer: string; explanation: string;
    }>(
      `SELECT q.id,q.section_id,ps.kind AS question_type,ps.title,ps.instructions,
              ps.paragraphs_json AS paragraphs,q.prompt,q.options_json AS options,q.answer_text AS answer,q.explanation
       FROM questions q JOIN paper_sections ps ON ps.id=q.section_id JOIN papers p ON p.id=ps.paper_id
       WHERE p.id=$1 AND p.status='published' AND ($2::text IS NULL OR ps.id=$2)
         AND ps.kind IN ('reading','matching') AND NULLIF(q.answer_text,'') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM shared_paper_sections shared
           WHERE shared.paper_id=p.id AND shared.section_id=ps.id)
       ORDER BY ps.position,q.position`,
      [target.paperId, target.sectionId],
    );
    for (const row of result.rows) {
      const context = { title: row.title, previousSentence: null, nextSentence: null };
      if (!target.type || target.type === 'text') {
        const addText = (textKey: string, source: string) => {
          if (!source) return;
          const contentHash = hash({ questionId: row.id, textKey, source });
          candidates.push({
            type: 'text', sectionId: row.section_id, sentenceId: null, questionId: row.id, textKey,
            source, sourceHash: contentHash, contextHash: contentHash, context,
            question: { source_text: source, context_json: context }, validate: value => validateAnalysis(source, value),
          });
        };
        addText('prompt', row.prompt.replace(/^\s*\d+\s*[.)]\s*/, ''));
        if (row.question_type === 'reading') for (const option of row.options) addText(`option:${option.key}`, option.text);
      }
      if ((!target.type || target.type === 'question') && row.question_type === 'reading') {
        const content = {
          question_type: row.question_type, title: row.title, instructions: row.instructions,
          paragraphs: row.paragraphs, prompt: row.prompt, options: row.options, answer: row.answer, explanation: row.explanation,
        };
        const contentHash = hash(content);
        candidates.push({
          type: 'question', sectionId: row.section_id, sentenceId: null, questionId: row.id, textKey: null,
          source: '', sourceHash: contentHash, contextHash: contentHash, context: {},
          question: { id: row.id, ...content, content_hash: contentHash },
          validate: value => validateQuestionAnalysis(value, {
            questionType: row.question_type, options: row.options, answer: row.answer, paragraphs: row.paragraphs,
          }),
        });
      }
    }
  }
  return candidates;
}

export async function inspectPriorityCandidates(db: PriorityDatabase, candidates: PriorityCandidate[], config: PriorityConfig): Promise<PriorityState[]> {
  if (!candidates.length) return [];
  const sentenceIds = candidates.flatMap(c => c.sentenceId ? [c.sentenceId] : []);
  const questionIds = [...new Set(candidates.flatMap(c => c.questionId ? [c.questionId] : []))];
  const versions = config.cachePromptVersions ?? [config.promptVersion];
  const sentenceCaches = sentenceIds.length ? (await db.query<{
    sentence_id: string; source_hash: string; context_hash: string; analysis_json: unknown;
  }>(
    `SELECT sentence_id,source_hash,context_hash,analysis_json FROM sentence_analyses
     WHERE sentence_id=ANY($1::text[]) AND prompt_version=ANY($2::text[]) AND model=$3 AND mode=$4 AND status='succeeded'`,
    [sentenceIds, versions, config.model, config.mode],
  )).rows : [];
  const questionCaches = questionIds.length ? (await db.query<{ question_id: string; content_hash: string; analysis_json: unknown }>(
    `SELECT question_id,content_hash,analysis_json FROM question_analyses
     WHERE question_id=ANY($1::text[]) AND prompt_version=ANY($2::text[]) AND model=$3 AND mode=$4 AND status='succeeded'`,
    [questionIds, versions, config.model, config.mode],
  )).rows : [];
  const jobs = (await db.query<{
    id: string; job_type: PriorityType; sentence_id: string | null; question_id: string | null; text_key: string | null;
    source_hash: string; context_hash: string; state: 'pending' | 'running' | 'failed'; updated_at: Date | string;
  }>(
    `SELECT id,job_type,sentence_id,question_id,text_key,source_hash,context_hash,updated_at,
            CASE WHEN status='running' AND lease_expires_at>NOW() THEN 'running'
                 WHEN status='failed' THEN 'failed' ELSE 'pending' END AS state
     FROM analysis_jobs WHERE (sentence_id=ANY($1::text[]) OR question_id=ANY($2::text[]))
       AND prompt_version=$3 AND model=$4 AND mode=$5 AND status IN ('pending','running','failed')
     ORDER BY (status IN ('pending','running')) DESC,updated_at DESC`,
    [sentenceIds, questionIds, config.promptVersion, config.model, config.mode],
  )).rows;
  const byIdentity = new Map<string, typeof jobs[number]>();
  for (const j of jobs) {
    const key = identity(j.job_type, j.sentence_id, j.question_id, j.text_key, j.source_hash, j.context_hash);
    if (!byIdentity.has(key)) byIdentity.set(key, j);
  }
  return candidates.map(candidate => {
    const cachedResults = candidate.type === 'sentence'
      ? sentenceCaches.filter(c => c.sentence_id === candidate.sentenceId && c.source_hash === candidate.sourceHash && c.context_hash === candidate.contextHash)
      : questionCaches.filter(c => c.question_id === candidate.questionId && c.content_hash === candidate.sourceHash);
    for (const cache of cachedResults) {
      try { candidate.validate(cache.analysis_json); return { candidate, state: 'cached' }; } catch { /* Reuse only valid results. */ }
    }
    const job = byIdentity.get(candidateIdentity(candidate));
    return { candidate, state: job?.state ?? 'missing', jobId: job?.id, jobUpdatedAt: job?.updated_at };
  });
}

export function summarizePriority(states: PriorityState[]) {
  return {
    total: states.length, cached: states.filter(s => s.state === 'cached').length,
    pending: states.filter(s => s.state === 'pending').length, running: states.filter(s => s.state === 'running').length,
    failed: states.filter(s => s.state === 'failed').length,
  };
}

export async function fillPriorityQueue(
  pool: PriorityPool, config: PriorityConfig,
  readRuntime: (db: PriorityDatabase) => Promise<{ queueCapacity: number; backfillPaused: boolean }>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const gate = await client.query<{ allowed: boolean }>('SELECT pg_try_advisory_xact_lock_shared($1::integer) AS allowed', [ANALYSIS_BATCH_LOCK_ID]);
    if (!gate.rows[0]?.allowed) { await client.query('ROLLBACK'); return { active: true, queued: 0 }; }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`analysis:${config.mode}:${config.model}:${config.promptVersion}`]);
    const target = await readPriorityTarget(client, true);
    if (!target || target.finishedAt) { await client.query('COMMIT'); return { active: false, queued: 0 }; }
    const runtime = await readRuntime(client);
    if (runtime.backfillPaused) { await client.query('COMMIT'); return { active: true, queued: 0 }; }
    const states = await inspectPriorityCandidates(client, await loadPriorityCandidates(client, target), config);
    if (states.every(s => s.state === 'cached')) {
      await client.query('UPDATE analysis_priority_target SET finished_at=NOW() WHERE revision=$1', [target.revision]);
      await client.query('COMMIT');
      return { active: false, queued: 0 };
    }
    const pending = states.filter(s => s.state === 'pending' && s.jobId).map(s => s.jobId);
    if (pending.length) await client.query(
      `UPDATE analysis_jobs SET priority=GREATEST(priority,$2),updated_at=NOW() WHERE id=ANY($1::uuid[]) AND status='pending'`, [pending, ADMIN_PRIORITY],
    );
    // A click permits one retry of older failures, including when the queue is
    // initially full. A failure produced after that click needs another action.
    const missing = states.filter(s => s.state === 'missing' || (s.state === 'failed' && s.jobUpdatedAt &&
      new Date(s.jobUpdatedAt).getTime() < new Date(target.selectedAt).getTime()));
    const active = missing.length > 0 || states.some(s => s.state === 'pending' || s.state === 'running');
    if (!missing.length) { await client.query('COMMIT'); return { active, queued: 0 }; }
    const count = await client.query<{ count: number }>(
      `SELECT COUNT(*)::integer count FROM analysis_jobs WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND status IN ('pending','running')`,
      [config.mode, config.model, config.promptVersion],
    );
    const occupied = count.rows[0]?.count ?? 0;
    let slots = Math.max(0, runtime.queueCapacity - occupied);
    const desired = Math.min(missing.length, runtime.queueCapacity);
    if (slots < desired) {
      const evicted = await client.query(
        `DELETE FROM analysis_jobs WHERE id IN (
           SELECT id FROM analysis_jobs WHERE mode=$1 AND model=$2 AND prompt_version=$3
             AND status='pending' AND priority<=1 AND attempts=0
           ORDER BY created_at DESC LIMIT $4 FOR UPDATE SKIP LOCKED
         ) RETURNING id`, [config.mode, config.model, config.promptVersion, occupied + desired - runtime.queueCapacity],
      );
      slots = Math.max(0, runtime.queueCapacity - occupied + (evicted.rowCount ?? 0));
    }
    let queued = 0;
    for (const state of missing.slice(0, slots)) {
      const c = state.candidate;
      if (state.state === 'failed' && state.jobId) await client.query(
        `UPDATE analysis_jobs SET status='pending',priority=$2,attempts=0,error_message=NULL,
           lease_expires_at=NULL,started_at=NULL,finished_at=NULL,next_attempt_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND status='failed'`, [state.jobId,ADMIN_PRIORITY],
      );
      else await client.query(
        `INSERT INTO analysis_jobs
           (job_type,sentence_id,question_id,text_key,source_text,source_hash,context_hash,context_json,question_json,
            prompt_version,model,mode,status,priority,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,'pending',$13,NOW())`,
        [c.type,c.sentenceId,c.questionId,c.textKey,c.source,c.sourceHash,c.contextHash,JSON.stringify(c.context),
          c.question ? JSON.stringify(c.question) : null,config.promptVersion,config.model,config.mode,ADMIN_PRIORITY],
      );
      queued += 1;
    }
    await client.query('COMMIT');
    return { active, queued };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

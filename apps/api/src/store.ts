import { Pool } from 'pg';
import { AnswersSchema, contextHash, validateAnalysis, type Answers, type PracticeResult } from '@cet-reading/contracts';
import { config } from './config.js';
import { ANALYSIS_BATCH_LOCK_ID, analysisErrorCode } from '@cet-reading/contracts/analysis-jobs';
import { presentPaper } from '@cet-reading/contracts/shared-reading';

export const pool = new Pool({ connectionString: config.databaseUrl });
const MAX_ACTIVE_ANALYSIS_JOBS = 8;

export class AnalysisQueueFullError extends Error {
  constructor() {
    super('Analysis queue is full');
    this.name = 'AnalysisQueueFullError';
  }
}

export class AnalysisPausedError extends Error {
  constructor() {
    super('Public analysis requests are temporarily paused for a batch run');
    this.name = 'AnalysisPausedError';
  }
}

type SentenceRow = {
  id: string;
  paper_id: string;
  source_text: string;
  source_hash: string;
  title: string;
  exam_level: string;
  year: number;
  previous_sentence: string | null;
  next_sentence: string | null;
};

export async function listPapers() {
  const result = await pool.query(
    `WITH ordered AS (
       SELECT s.id, s.paper_id, s.source_hash,
              jsonb_build_object(
                'title', p.title,
                'previousSentence', lag(s.source_text) OVER w,
                'nextSentence', lead(s.source_text) OVER w
              ) AS context_json
       FROM sentences s JOIN papers p ON p.id = s.paper_id
       WHERE p.status = 'published'
       WINDOW w AS (PARTITION BY s.paper_id ORDER BY s.paragraph_index, s.sentence_index)
     ), totals AS (
       SELECT paper_id, COUNT(*)::integer AS total
       FROM ordered GROUP BY paper_id
     ), cached AS (
       SELECT o.paper_id, COUNT(DISTINCT o.id)::integer AS cached
       FROM ordered o JOIN sentence_analyses a
         ON a.sentence_id = o.id AND a.source_hash = o.source_hash
        AND a.context_json = o.context_json
        AND a.prompt_version = $1 AND a.model = $2 AND a.mode = $3 AND a.status = 'succeeded'
       GROUP BY o.paper_id
     ), queued AS (
       SELECT o.paper_id,
              COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND
                (j.status = 'pending' OR (j.status = 'running' AND
                  (j.lease_expires_at IS NULL OR j.lease_expires_at <= NOW()))))::integer AS pending,
              COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND
                j.status = 'running' AND j.lease_expires_at > NOW())::integer AS running,
              COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND j.status = 'failed')::integer AS failed
       FROM ordered o JOIN analysis_jobs j
         ON j.sentence_id = o.id AND j.source_hash = o.source_hash
        AND j.context_json = o.context_json
       LEFT JOIN sentence_analyses a
         ON a.sentence_id = o.id AND a.source_hash = o.source_hash
        AND a.context_json = o.context_json
        AND a.prompt_version = $1 AND a.model = $2 AND a.mode = $3 AND a.status = 'succeeded'
       WHERE j.prompt_version = $1 AND j.model = $2 AND j.mode = $3
         AND j.status IN ('pending', 'running', 'failed')
       GROUP BY o.paper_id
     )
     SELECT p.id, p.exam_level, p.year, p.month, p.set_no, p.variant, p.title, p.is_demo,
            content_state, content_kind, description, reference_paper_id, source_url,
            EXISTS (SELECT 1 FROM paper_sections ps WHERE ps.paper_id = p.id) AS has_content,
            COALESCE(t.total, 0) AS analysis_total,
            COALESCE(c.cached, 0) AS analysis_cached,
            COALESCE(q.pending, 0) AS analysis_pending,
            COALESCE(q.running, 0) AS analysis_running,
            COALESCE(q.failed, 0) AS analysis_failed
     FROM papers p
     LEFT JOIN totals t ON t.paper_id = p.id
     LEFT JOIN cached c ON c.paper_id = p.id
     LEFT JOIN queued q ON q.paper_id = p.id
     WHERE p.status = 'published'
     ORDER BY p.year DESC, p.month DESC, p.exam_level, p.set_no`,
    [config.promptVersion, config.model, config.mode],
  );
  return result.rows;
}

async function getStoredPaper(id: string) {
  const result = await pool.query(
    `SELECT p.id, p.exam_level, p.year, p.month, p.set_no, p.variant, p.title, p.is_demo,
            p.content_state, p.content_kind, p.description, p.reference_paper_id, p.source_url,
            COALESCE((SELECT json_agg(json_build_object(
              'id', ps.id, 'kind', ps.kind, 'title', ps.title,
              'instructions', ps.instructions, 'paragraphs', ps.paragraphs_json,
              'images', ps.images_json,
              'questions', COALESCE((SELECT json_agg(json_build_object(
                'id', q.id, 'type', q.type, 'prompt', q.prompt,
                'options', q.options_json
              ) ORDER BY q.position) FROM questions q WHERE q.section_id = ps.id), '[]'::json)
            ) ORDER BY ps.position) FROM paper_sections ps WHERE ps.paper_id = p.id), '[]'::json) AS sections,
            COALESCE((SELECT json_agg(json_build_object(
              'id', s.id, 'paragraphIndex', s.paragraph_index,
              'sentenceIndex', s.sentence_index, 'source', s.source_text,
              'sectionId', s.section_id
            ) ORDER BY s.paragraph_index, s.sentence_index) FROM sentences s WHERE s.paper_id = p.id), '[]'::json) AS sentences
     FROM papers p
     WHERE p.id = $1 AND p.status = 'published'
     GROUP BY p.id`,
    [id],
  );
  const paper = result.rows[0] ?? null;
  for (const section of paper?.sections ?? []) if (!section.images.length) delete section.images;
  return paper;
}

export async function getPaper(id: string) {
  const paper = await getStoredPaper(id);
  if (!paper || !paper.reference_paper_id) return paper;
  const reference = await getStoredPaper(paper.reference_paper_id);
  return presentPaper(paper, reference);
}

type PracticeQuestion = {
  id: string;
  type: 'choice' | 'text';
  prompt: string;
  options: Array<{ key: string; text: string }>;
  answer: string | null;
  explanation: string;
  points: number;
};

async function getPracticeQuestions(paperId: string) {
  const result = await pool.query<PracticeQuestion>(
    `SELECT q.id, q.type, q.prompt, q.options_json AS options,
            q.answer_text AS answer, q.explanation, q.points::double precision AS points
     FROM questions q JOIN paper_sections ps ON ps.id = q.section_id
     WHERE ps.paper_id = $1 ORDER BY ps.position, q.position`,
    [paperId],
  );
  return result.rows;
}

function publicQuestion(question: PracticeQuestion) {
  return { id: question.id, type: question.type, prompt: question.prompt, options: question.options };
}

export async function createPracticeAttempt(paperId: string) {
  const paper = await getPaper(paperId);
  if (!paper || paper.content_state !== 'local') return null;
  const visibleIds = new Set(paper.sections.flatMap((section: { questions: { id: string }[] }) => section.questions.map(question => question.id)));
  const questions = (await getPracticeQuestions(paperId)).filter(question => visibleIds.has(question.id));
  if (!questions.length) return null;
  const result = await pool.query(
    `INSERT INTO practice_attempts (paper_id, questions_snapshot)
     VALUES ($1, $2) RETURNING id, paper_id, status, answers_json AS answers, result_json AS result`,
    [paperId, JSON.stringify(questions)],
  );
  const attempt = result.rows[0];
  return { ...attempt, questions: questions.map(publicQuestion) };
}

export async function getPracticeAttempt(id: string) {
  const result = await pool.query(
    `SELECT id, paper_id, status, answers_json AS answers, result_json AS result,
            questions_snapshot AS questions FROM practice_attempts WHERE id = $1`,
    [id],
  );
  const attempt = result.rows[0];
  if (!attempt) return null;
  return { ...attempt, questions: attempt.questions.map(publicQuestion) };
}

export async function savePracticeAnswers(id: string, input: unknown) {
  const answers = AnswersSchema.parse(input);
  const result = await pool.query(
    `UPDATE practice_attempts SET answers_json = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING id, paper_id, status, answers_json AS answers, result_json AS result,
               questions_snapshot AS questions`,
    [id, JSON.stringify(answers)],
  );
  const attempt = result.rows[0];
  return attempt ? { ...attempt, questions: attempt.questions.map(publicQuestion) } : null;
}

function gradePractice(questions: PracticeQuestion[], answers: Answers): PracticeResult {
  let objectiveScore = 0;
  let objectiveTotal = 0;
  let correctCount = 0;
  let objectiveCount = 0;
  let manualCount = 0;
  const results = questions.map((question) => {
    const answer = answers[question.id] ?? '';
    if (question.type === 'text') {
      manualCount += 1;
      return { id: question.id, answer, correctAnswer: question.answer, explanation: question.explanation, status: 'manual' as const, points: question.points, earned: null };
    }
    objectiveCount += 1;
    objectiveTotal += question.points;
    const correct = answer.trim().toUpperCase() === question.answer?.trim().toUpperCase();
    if (correct) { objectiveScore += question.points; correctCount += 1; }
    const status: 'correct' | 'incorrect' | 'unanswered' = answer
      ? (correct ? 'correct' : 'incorrect')
      : 'unanswered';
    return { id: question.id, answer, correctAnswer: question.answer, explanation: question.explanation, status, points: question.points, earned: correct ? question.points : 0 };
  });
  return { objectiveScore, objectiveTotal, correctCount, objectiveCount, manualCount, questions: results };
}

export async function submitPracticeAttempt(id: string) {
  const result = await pool.query(
    `SELECT id, paper_id, status, answers_json AS answers, questions_snapshot AS questions
     FROM practice_attempts WHERE id = $1`,
    [id],
  );
  const attempt = result.rows[0];
  if (!attempt) return null;
  if (attempt.status === 'submitted') return getPracticeAttempt(id);
  const answers = AnswersSchema.parse(attempt.answers ?? {});
  const practiceResult = gradePractice(attempt.questions as PracticeQuestion[], answers);
  const updated = await pool.query(
    `UPDATE practice_attempts SET status = 'submitted', result_json = $2,
            updated_at = NOW(), submitted_at = NOW()
     WHERE id = $1
     RETURNING id, paper_id, status, answers_json AS answers, result_json AS result,
               questions_snapshot AS questions`,
    [id, JSON.stringify(practiceResult)],
  );
  const saved = updated.rows[0];
  return { ...saved, questions: saved.questions.map(publicQuestion) };
}

export async function getSentence(id: string) {
  const result = await pool.query<SentenceRow>(
    `WITH ordered AS (
       SELECT s.id, s.paper_id, s.source_text, s.source_hash,
              COALESCE(p.title,n.title) AS title, COALESCE(p.exam_level,'NEWS') AS exam_level, p.year,
              lag(s.source_text) OVER w AS previous_sentence,
              lead(s.source_text) OVER w AS next_sentence
       FROM sentences s LEFT JOIN papers p ON p.id = s.paper_id LEFT JOIN news_articles n ON n.id = s.article_id
       WHERE (p.status = 'published' OR n.status = 'published')
         AND (s.paper_id = (SELECT paper_id FROM sentences WHERE id = $1)
              OR s.article_id = (SELECT article_id FROM sentences WHERE id = $1))
       WINDOW w AS (PARTITION BY s.paper_id,s.article_id ORDER BY s.paragraph_index, s.sentence_index)
     )
     SELECT * FROM ordered WHERE id = $1`,
    [id],
  );
  const sentence = result.rows[0];
  if (!sentence) return null;
  const context = {
    title: sentence.title,
    previousSentence: sentence.previous_sentence,
    nextSentence: sentence.next_sentence,
  };
  return { ...sentence, context, context_hash: contextHash(context) };
}

export async function getCachedAnalysis(sentenceId: string, sourceHash: string, contextHashValue: string, source: string) {
  const result = await pool.query(
    `SELECT analysis_json FROM sentence_analyses
     WHERE sentence_id = $1 AND source_hash = $2 AND context_hash = $3
       AND prompt_version = ANY($4::text[]) AND model = $5 AND mode = $6 AND status = 'succeeded'
     ORDER BY (prompt_version = $7) DESC, updated_at DESC`,
    [sentenceId, sourceHash, contextHashValue, config.cachePromptVersions, config.model, config.mode, config.promptVersion],
  );
  for (const row of result.rows) {
    try { return validateAnalysis(source, row.analysis_json); }
    catch { /* Preserve old records, but never serve incomplete or placeholder analyses. */ }
  }
  return undefined;
}

export async function getSectionCachedAnalyses(paperId: string, sectionId: string, news = false) {
  // Compute neighbours across the entire paper before selecting the section,
  // keeping the same context and cache keys as an individual sentence request.
  const sentences = await pool.query<SentenceRow>(
    `WITH ordered AS (
       SELECT s.id, s.source_text, s.source_hash, COALESCE(s.section_id,s.article_id || '-body') AS section_id, COALESCE(p.title,n.title) AS title,
              lag(s.source_text) OVER w AS previous_sentence,
              lead(s.source_text) OVER w AS next_sentence
       FROM sentences s LEFT JOIN papers p ON p.id = s.paper_id LEFT JOIN news_articles n ON n.id = s.article_id
       WHERE (($3::boolean = FALSE AND s.paper_id = $1 AND p.status = 'published')
           OR ($3::boolean = TRUE AND s.article_id = $1 AND n.status = 'published'))
       WINDOW w AS (ORDER BY s.paragraph_index, s.sentence_index)
     ) SELECT * FROM ordered WHERE section_id = $2`,
    [paperId, sectionId, news],
  );
  if (!sentences.rows.length) return [];
  const candidates = await pool.query(
    `SELECT sentence_id, source_hash, context_hash, analysis_json
     FROM sentence_analyses
     WHERE sentence_id = ANY($1::text[]) AND prompt_version = ANY($2::text[])
       AND model = $3 AND mode = $4 AND status = 'succeeded'
     ORDER BY (prompt_version = $5) DESC, updated_at DESC`,
    [sentences.rows.map(row => row.id), config.cachePromptVersions, config.model, config.mode, config.promptVersion],
  );
  const byId = new Map(sentences.rows.map(row => [row.id, {
    ...row,
    contextHash: contextHash({ title: row.title, previousSentence: row.previous_sentence, nextSentence: row.next_sentence }),
  }]));
  const cached = new Map<string, { sentenceId: string; source: string; result: ReturnType<typeof validateAnalysis> }>();
  for (const row of candidates.rows) {
    const sentence = byId.get(row.sentence_id);
    if (!sentence || cached.has(sentence.id) || sentence.source_hash !== row.source_hash || sentence.contextHash !== row.context_hash) continue;
    try {
      cached.set(sentence.id, { sentenceId: sentence.id, source: sentence.source_text, result: validateAnalysis(sentence.source_text, row.analysis_json) });
    } catch { /* A prefetch has the same quality checks and fallback rules as a click. */ }
  }
  return [...cached.values()];
}

export async function enqueueAnalysis(sentence: {
  id: string; source_text: string; source_hash: string; context_hash: string; context: object;
}, priority = 10) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const gate = await client.query<{ allowed: boolean }>(
      'SELECT pg_try_advisory_xact_lock_shared($1::integer) AS allowed',
      [ANALYSIS_BATCH_LOCK_ID],
    );
    if (!gate.rows[0]?.allowed) {
      await client.query('ROLLBACK');
      throw new AnalysisPausedError();
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `analysis:${config.mode}:${config.model}:${config.promptVersion}`,
    ]);
    const key = [sentence.id, sentence.source_hash, sentence.context_hash, config.promptVersion, config.model, config.mode];
    const existing = await client.query(
      `SELECT id, status FROM analysis_jobs
       WHERE sentence_id = $1 AND source_hash = $2 AND context_hash = $3
         AND prompt_version = $4 AND model = $5 AND mode = $6
         AND status IN ('pending', 'running')`, key,
    );
    if (existing.rows[0]) {
      const updated = await client.query(
        `UPDATE analysis_jobs SET priority = GREATEST(priority, $2), updated_at = NOW()
         WHERE id = $1 RETURNING id, status`, [existing.rows[0].id, priority],
      );
      await client.query('COMMIT');
      return updated.rows[0] as { id: string; status: string };
    }
    const count = await client.query<{ count: number; background: number }>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'running'))::integer AS count,
              COUNT(*) FILTER (WHERE status IN ('pending', 'running') AND priority <= 1)::integer AS background
       FROM analysis_jobs
       WHERE mode = $1 AND model = $2 AND prompt_version = $3
         AND status IN ('pending', 'running')`,
      [config.mode, config.model, config.promptVersion],
    );
    const active = count.rows[0]?.count ?? 0;
    const background = count.rows[0]?.background ?? 0;
    if (active >= MAX_ACTIVE_ANALYSIS_JOBS && priority > 1) {
      // A user request must be able to enter a full queue. Evict only a
      // not-yet-started background row; running work is never interrupted.
      const evicted = await client.query(
        `DELETE FROM analysis_jobs
         WHERE id = (
           SELECT id FROM analysis_jobs
           WHERE mode = $1 AND model = $2 AND prompt_version = $3
             AND status = 'pending' AND priority <= 1
           ORDER BY created_at DESC
           FOR UPDATE SKIP LOCKED LIMIT 1
         ) RETURNING id`,
        [config.mode, config.model, config.promptVersion],
      );
      if (evicted.rowCount) {
        // The deleted row was part of the active count, so the new request
        // can take its place without exceeding the hard queue limit.
        count.rows[0].count = active - 1;
      }
    }
    const available = count.rows[0]?.count ?? active;
    if (available >= MAX_ACTIVE_ANALYSIS_JOBS || (priority <= 1 && background >= config.backfillTarget)) {
      await client.query('ROLLBACK');
      throw new AnalysisQueueFullError();
    }
    const result = await client.query(
      `INSERT INTO analysis_jobs
         (sentence_id, source_text, source_hash, context_hash, context_json,
          prompt_version, model, mode, status, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
       RETURNING id, status`,
      [sentence.id, sentence.source_text, sentence.source_hash, sentence.context_hash,
        JSON.stringify(sentence.context), config.promptVersion, config.model, config.mode, priority],
    );
    await client.query('COMMIT');
    return result.rows[0] as { id: string; status: string };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getJob(id: string) {
  const result = await pool.query(
    `SELECT j.id, j.sentence_id, j.mode, j.status, j.error_message, j.updated_at,
            j.source_text, j.attempts, j.next_attempt_at, a.analysis_json
     FROM analysis_jobs j
     LEFT JOIN sentence_analyses a ON j.status = 'succeeded' AND a.status = 'succeeded'
       AND a.sentence_id = j.sentence_id AND a.source_hash = j.source_hash
       AND a.context_hash = j.context_hash AND a.prompt_version = j.prompt_version
       AND a.model = j.model AND a.mode = j.mode
     WHERE j.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const { error_message, source_text, analysis_json, ...job } = row;
  let analysis;
  if (job.status === 'succeeded' && analysis_json) {
    try { analysis = validateAnalysis(source_text, analysis_json); }
    catch { /* The normal analysis endpoint will recover a missing/invalid cache. */ }
  }
  return { ...job, errorCode: job.status === 'failed' ? analysisErrorCode(error_message) : null, ...(analysis ? { result: analysis } : {}) };
}

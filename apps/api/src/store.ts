import { Pool } from 'pg';
import type { SentenceAnalysis } from '@cet-reading/contracts';
import { config } from './config.js';

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function listPapers() {
  const result = await pool.query(
    `SELECT id, exam_level, year, set_no, title
     FROM papers
     WHERE status = 'published'
     ORDER BY year DESC, exam_level, set_no`,
  );
  return result.rows;
}

export async function getPaper(id: string) {
  const result = await pool.query(
    `SELECT p.id, p.exam_level, p.year, p.set_no, p.title,
            json_agg(json_build_object(
              'id', s.id,
              'paragraphIndex', s.paragraph_index,
              'sentenceIndex', s.sentence_index,
              'source', s.source_text
            ) ORDER BY s.paragraph_index, s.sentence_index) AS sentences
     FROM papers p
     JOIN sentences s ON s.paper_id = p.id
     WHERE p.id = $1 AND p.status = 'published'
     GROUP BY p.id`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getSentence(id: string) {
  const result = await pool.query(
    `WITH ordered AS (
       SELECT s.id, s.paper_id, s.source_text, s.source_hash,
              p.title, p.exam_level, p.year,
              lag(s.source_text) OVER w AS previous_sentence,
              lead(s.source_text) OVER w AS next_sentence
       FROM sentences s
       JOIN papers p ON p.id = s.paper_id
       WINDOW w AS (PARTITION BY s.paper_id ORDER BY s.paragraph_index, s.sentence_index)
     )
     SELECT * FROM ordered WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getCachedAnalysis(sentenceId: string, sourceHash: string) {
  const result = await pool.query(
    `SELECT analysis_json, model, prompt_version
     FROM sentence_analyses
     WHERE sentence_id = $1 AND source_hash = $2
       AND prompt_version = $3 AND model = $4 AND status = 'succeeded'
     ORDER BY created_at DESC
     LIMIT 1`,
    [sentenceId, sourceHash, config.promptVersion, config.model],
  );
  return result.rows[0] ?? null;
}

export async function enqueueAnalysis(sentenceId: string, sourceHash: string) {
  const result = await pool.query(
    `INSERT INTO analysis_jobs
       (sentence_id, source_hash, prompt_version, model, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (sentence_id, source_hash, prompt_version, model)
     DO UPDATE SET status = CASE
                              WHEN analysis_jobs.status = 'failed' THEN 'pending'
                              ELSE analysis_jobs.status
                            END,
                   error_message = CASE
                                     WHEN analysis_jobs.status = 'failed' THEN NULL
                                     ELSE analysis_jobs.error_message
                                   END,
                   updated_at = NOW()
     RETURNING id, status`,
    [sentenceId, sourceHash, config.promptVersion, config.model],
  );
  return result.rows[0];
}

export async function getJob(id: string) {
  const result = await pool.query(
    `SELECT id, sentence_id, status, error_message, updated_at
     FROM analysis_jobs WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function saveAnalysis(
  sentenceId: string,
  sourceHash: string,
  analysis: SentenceAnalysis,
) {
  await pool.query(
    `INSERT INTO sentence_analyses
       (sentence_id, source_hash, prompt_version, model, analysis_json, status)
     VALUES ($1, $2, $3, $4, $5, 'succeeded')
     ON CONFLICT (sentence_id, source_hash, prompt_version, model)
     DO UPDATE SET analysis_json = EXCLUDED.analysis_json,
                   status = 'succeeded',
                   updated_at = NOW()`,
    [sentenceId, sourceHash, config.promptVersion, config.model, JSON.stringify(analysis)],
  );
}

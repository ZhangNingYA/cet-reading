import { Pool } from 'pg';
import { contextHash, type SentenceAnalysis } from '@cet-reading/contracts';
import { config } from './config.js';

export const pool = new Pool({ connectionString: config.databaseUrl });

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
    `SELECT id, exam_level, year, month, set_no, title, is_demo
     FROM papers WHERE status = 'published'
     ORDER BY year DESC, month DESC, exam_level, set_no`,
  );
  return result.rows;
}

export async function getPaper(id: string) {
  const result = await pool.query(
    `SELECT p.id, p.exam_level, p.year, p.month, p.set_no, p.title, p.is_demo,
            json_agg(json_build_object(
              'id', s.id, 'paragraphIndex', s.paragraph_index,
              'sentenceIndex', s.sentence_index, 'source', s.source_text
            ) ORDER BY s.paragraph_index, s.sentence_index) AS sentences
     FROM papers p JOIN sentences s ON s.paper_id = p.id
     WHERE p.id = $1 AND p.status = 'published'
     GROUP BY p.id`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getSentence(id: string) {
  const result = await pool.query<SentenceRow>(
    `WITH ordered AS (
       SELECT s.id, s.paper_id, s.source_text, s.source_hash,
              p.title, p.exam_level, p.year,
              lag(s.source_text) OVER w AS previous_sentence,
              lead(s.source_text) OVER w AS next_sentence
       FROM sentences s JOIN papers p ON p.id = s.paper_id
       WHERE p.status = 'published'
       WINDOW w AS (PARTITION BY s.paper_id ORDER BY s.paragraph_index, s.sentence_index)
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

export async function getCachedAnalysis(sentenceId: string, sourceHash: string, contextHashValue: string) {
  const result = await pool.query(
    `SELECT analysis_json FROM sentence_analyses
     WHERE sentence_id = $1 AND source_hash = $2 AND context_hash = $3
       AND prompt_version = $4 AND model = $5 AND mode = $6 AND status = 'succeeded'
     ORDER BY created_at DESC LIMIT 1`,
    [sentenceId, sourceHash, contextHashValue, config.promptVersion, config.model, config.mode],
  );
  return result.rows[0]?.analysis_json as SentenceAnalysis | undefined;
}

export async function enqueueAnalysis(sentence: {
  id: string; source_text: string; source_hash: string; context_hash: string; context: object;
}) {
  const result = await pool.query(
    `INSERT INTO analysis_jobs
       (sentence_id, source_text, source_hash, context_hash, context_json,
        prompt_version, model, mode, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     ON CONFLICT (sentence_id, source_hash, context_hash, prompt_version, model, mode)
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
    [sentence.id, sentence.source_text, sentence.source_hash, sentence.context_hash,
      JSON.stringify(sentence.context), config.promptVersion, config.model, config.mode],
  );
  return result.rows[0] as { id: string; status: string };
}

export async function getJob(id: string) {
  const result = await pool.query(
    `SELECT id, sentence_id, mode, status, error_message, updated_at
     FROM analysis_jobs WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

import type { Pool } from 'pg';
import type { RuntimeConfig } from '@cet-reading/contracts/config';
import { ANALYSIS_BATCH_LOCK_ID } from '@cet-reading/contracts/analysis-jobs';

export type AnalysisJob = {
  id: string;
  attempts: number;
  job_type: 'sentence' | 'question' | 'text';
  sentence_id: string | null;
  question_id: string | null;
  source_text: string;
  source_hash: string;
  context_hash: string;
  context_json: { title: string; previousSentence: string | null; nextSentence: string | null };
  question_json: {
    question_type: 'reading' | 'matching'; title: string; instructions: string; paragraphs: string[];
    prompt: string; options: Array<{ key: string; text: string }>; answer: string; explanation: string;
  } | { source_text: string; context_json: { title: string; previousSentence: string | null; nextSentence: string | null } } | null;
  created_at: Date;
};

type ClaimConfig = Pick<RuntimeConfig, 'mode' | 'model' | 'promptVersion' | 'leaseSeconds' | 'maxAnalysisAttempts'>;

export async function claimAnalysisJob(pool: Pool, config: ClaimConfig): Promise<AnalysisJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const gate = await client.query<{ allowed: boolean }>(
      'SELECT pg_try_advisory_xact_lock_shared($1::integer) AS allowed',
      [ANALYSIS_BATCH_LOCK_ID],
    );
    if (!gate.rows[0]?.allowed) {
      await client.query('ROLLBACK');
      return null;
    }
    // Quarantine old exhausted jobs without touching a worker's live lease.
    await client.query(
      `UPDATE analysis_jobs
       SET status = 'failed', error_message = COALESCE(error_message, $5),
           lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW()
       WHERE mode = $1 AND model = $2 AND prompt_version = $3
         AND attempts >= $4
         AND (status = 'pending' OR (status = 'running' AND
           (lease_expires_at IS NULL OR lease_expires_at < NOW())))`,
      [config.mode, config.model, config.promptVersion, config.maxAnalysisAttempts,
        `Transient retry limit reached after ${config.maxAnalysisAttempts} attempts`],
    );
    const result = await client.query<AnalysisJob>(
      `WITH candidate AS (
         SELECT j.id FROM analysis_jobs j
         LEFT JOIN sentences s ON s.id = j.sentence_id
         LEFT JOIN questions q ON q.id = j.question_id
         LEFT JOIN paper_sections ps ON ps.id = q.section_id
         LEFT JOIN analysis_paper_priorities pp ON pp.paper_id = COALESCE(s.paper_id, ps.paper_id)
         LEFT JOIN analysis_news_priorities np ON np.article_id = s.article_id
         WHERE mode = $1 AND model = $2 AND prompt_version = $3
           AND ((status = 'pending' AND next_attempt_at <= NOW())
             OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())))
           AND attempts < $5
         ORDER BY j.priority DESC, COALESCE(pp.priority, np.priority, 0) DESC,
                  COALESCE(pp.sort_order, np.sort_order, 2147483647), (j.attempts = 0) DESC,
                  (j.job_type='question') DESC, j.created_at DESC, j.id DESC
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1
       )
       UPDATE analysis_jobs j
       SET status = 'running', attempts = j.attempts + 1,
           started_at = COALESCE(j.started_at, NOW()),
           lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
           next_attempt_at = NOW(), updated_at = NOW()
       FROM candidate c
       WHERE j.id = c.id
       RETURNING j.id, j.attempts, j.sentence_id, j.source_text, j.source_hash,
                 j.job_type, j.question_id, j.context_hash, j.context_json, j.question_json, j.created_at`,
      [config.mode, config.model, config.promptVersion, config.leaseSeconds, config.maxAnalysisAttempts],
    );
    // Even when no job is ready, exhausted rows must leave the active queue.
    await client.query('COMMIT');
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

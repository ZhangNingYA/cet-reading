import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { hasWordTokens, validateAnalysis, validateQuestionAnalysis } from '@cet-reading/contracts';
import { config } from './config.js';

export function emptyQuestionProgress() {
  return {
    analysis_text_total: 0, analysis_text_cached: 0, analysis_text_current_cached: 0,
    analysis_text_pending: 0, analysis_text_running: 0, analysis_text_failed: 0,
    analysis_solving_total: 0, analysis_solving_cached: 0, analysis_solving_current_cached: 0,
    analysis_solving_pending: 0, analysis_solving_running: 0, analysis_solving_failed: 0,
  };
}

// The public list and admin use the same source hashes and validation as a reader click.
export async function getPaperQuestionProgress(database: Pool, paperIds?: string[]) {
  const progressByPaper = new Map<string, ReturnType<typeof emptyQuestionProgress>>();
  if (paperIds?.length === 0) return progressByPaper;
  const questionRows = await database.query<{
    paper_id: string; id: string; question_type: 'reading' | 'matching';
    title: string; instructions: string; paragraphs: string[]; prompt: string;
    options: Array<{ key: string; text: string }>; answer: string; explanation: string;
  }>(
    `SELECT p.id AS paper_id, q.id, ps.kind AS question_type, ps.title, ps.instructions,
            ps.paragraphs_json AS paragraphs, q.prompt, q.options_json AS options,
            q.answer_text AS answer, q.explanation
     FROM questions q JOIN paper_sections ps ON ps.id = q.section_id
     JOIN papers p ON p.id = ps.paper_id
     WHERE ($1::text[] IS NULL OR p.id = ANY($1::text[])) AND p.status = 'published'
       AND ps.kind IN ('reading', 'matching') AND NULLIF(q.answer_text, '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM shared_paper_sections shared
         WHERE shared.paper_id = p.id AND shared.section_id = ps.id
       )`,
    [paperIds ?? null],
  );
  type Candidate = {
    paperId: string; questionId: string; textKey: string; hash: string;
    kind: 'text' | 'solving'; validate: (value: unknown) => unknown;
  };
  const candidates: Candidate[] = [];
  const hashJson = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for (const question of questionRows.rows) {
    if (!progressByPaper.has(question.paper_id)) progressByPaper.set(question.paper_id, emptyQuestionProgress());
    const addText = (textKey: string, source: string) => {
      if (!source || !hasWordTokens(source)) return;
      candidates.push({
        paperId: question.paper_id, questionId: question.id, textKey, kind: 'text',
        hash: hashJson({ questionId: question.id, textKey, source }),
        validate: value => validateAnalysis(source, value),
      });
    };
    addText('prompt', question.prompt.replace(/^\s*\d+\s*[.)]\s*/, ''));
    if (question.question_type === 'reading') {
      for (const option of question.options ?? []) addText(`option:${option.key}`, option.text);
      candidates.push({
        paperId: question.paper_id, questionId: question.id, textKey: '', kind: 'solving',
        hash: hashJson({
          question_type: question.question_type, title: question.title, instructions: question.instructions,
          paragraphs: question.paragraphs, prompt: question.prompt, options: question.options,
          answer: question.answer, explanation: question.explanation,
        }),
        validate: value => validateQuestionAnalysis(value, {
          questionType: question.question_type, options: question.options,
          answer: question.answer, paragraphs: question.paragraphs,
        }),
      });
    }
  }
  const questionIds = questionRows.rows.map(question => question.id);
  if (!questionIds.length) return progressByPaper;
  const [cacheRows, jobRows] = await Promise.all([
    database.query<{ question_id: string; content_hash: string; prompt_version: string; analysis_json: unknown }>(
      `SELECT question_id, content_hash, prompt_version, analysis_json FROM question_analyses
       WHERE question_id = ANY($1::text[]) AND prompt_version = ANY($2::text[])
         AND model = $3 AND mode = $4 AND status = 'succeeded'
       ORDER BY (prompt_version = $5) DESC, updated_at DESC`,
      [questionIds, config.cachePromptVersions, config.model, config.mode, config.promptVersion],
    ),
    database.query<{
      job_type: 'question' | 'text'; question_id: string; text_key: string | null;
      source_hash: string; progress_status: 'pending' | 'running' | 'failed';
    }>(
      `SELECT job_type, question_id, text_key, source_hash,
              CASE WHEN status = 'running' AND lease_expires_at > NOW() THEN 'running'
                   WHEN status = 'failed' THEN 'failed' ELSE 'pending' END AS progress_status
       FROM analysis_jobs
       WHERE job_type IN ('question', 'text') AND question_id = ANY($1::text[])
         AND prompt_version = $2 AND model = $3 AND mode = $4 AND status IN ('pending', 'running', 'failed')
       ORDER BY (status IN ('pending', 'running')) DESC, updated_at DESC`,
      [questionIds, config.promptVersion, config.model, config.mode],
    ),
  ]);
  const caches = new Map<string, typeof cacheRows.rows>();
  for (const row of cacheRows.rows) {
    const key = `${row.question_id}\u0000${row.content_hash}`;
    const rows = caches.get(key) ?? [];
    rows.push(row);
    caches.set(key, rows);
  }
  const jobs = new Map<string, typeof jobRows.rows[number]>();
  for (const job of jobRows.rows) {
    const key = `${job.job_type}\u0000${job.question_id}\u0000${job.text_key ?? ''}\u0000${job.source_hash}`;
    if (!jobs.has(key)) jobs.set(key, job);
  }
  for (const candidate of candidates) {
    const progress = progressByPaper.get(candidate.paperId)!;
    const prefix = `analysis_${candidate.kind}` as const;
    progress[`${prefix}_total`] += 1;
    let cached = false;
    for (const row of caches.get(`${candidate.questionId}\u0000${candidate.hash}`) ?? []) {
      try { candidate.validate(row.analysis_json); } catch { continue; }
      progress[`${prefix}_cached`] += 1;
      if (row.prompt_version === config.promptVersion) progress[`${prefix}_current_cached`] += 1;
      cached = true;
      break;
    }
    if (cached) continue;
    const type = candidate.kind === 'solving' ? 'question' : 'text';
    const job = jobs.get(`${type}\u0000${candidate.questionId}\u0000${candidate.textKey}\u0000${candidate.hash}`);
    if (job) progress[`${prefix}_${job.progress_status}`] += 1;
  }
  return progressByPaper;
}

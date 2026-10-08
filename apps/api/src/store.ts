import { Pool } from 'pg';
import { AnswersSchema, contextHash, validateAnalysis, type Answers, type PracticeResult } from '@cet-reading/contracts';
import { config } from './config.js';
import { analysisErrorCode } from '@cet-reading/contracts/analysis-jobs';
import { presentPaper } from '@cet-reading/contracts/shared-reading';

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
    `SELECT id, exam_level, year, month, set_no, variant, title, is_demo,
            content_state, content_kind, description, reference_paper_id, source_url,
            EXISTS (SELECT 1 FROM paper_sections ps WHERE ps.paper_id = p.id) AS has_content
     FROM papers p WHERE status = 'published'
     ORDER BY year DESC, month DESC, exam_level, set_no`,
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

export async function enqueueAnalysis(sentence: {
  id: string; source_text: string; source_hash: string; context_hash: string; context: object;
}) {
  const result = await pool.query(
    `INSERT INTO analysis_jobs
       (sentence_id, source_text, source_hash, context_hash, context_json,
        prompt_version, model, mode, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     ON CONFLICT (sentence_id, source_hash, context_hash, prompt_version, model, mode)
       WHERE status IN ('pending', 'running')
     DO UPDATE SET updated_at = analysis_jobs.updated_at
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
  const row = result.rows[0];
  if (!row) return null;
  const { error_message, ...job } = row;
  return { ...job, errorCode: job.status === 'failed' ? analysisErrorCode(error_message) : null };
}

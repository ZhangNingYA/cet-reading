import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { registerArticleChat } from './article-chat.js';
import { loadArticleChatContext } from './article-chat-store.js';
import { getAdminPriority, listAdminSections, removeAdminPriority, setAdminPriority, InvalidPriorityTargetError } from './admin-priority.js';
import {
  getAdminOverview,
  getAdminJobDetail,
  getAdminSettings,
  clearAdminFailures,
  InvalidAdminSettingsError,
  listAdminAudit,
  listAdminPapers,
  reorderAdminPapers,
  retryAdminFailures,
  setBackfillPaused,
  updateAdminSettings,
} from './admin-store.js';
import { listNews, getNews } from './news-store.js';
import {
  deleteReadingProgress,
  getReadingProgress,
  isReadingProgressBoard,
  parseReadingProgressInput,
  saveReadingProgress,
} from './reading-progress-store.js';
import {
  createPracticeAttempt,
  enqueueAnalysis,
  enqueueQuestionAnalysis,
  getCachedAnalysis,
  getCachedQuestionAnalysis,
  getJob,
  getPaper,
  getPracticeAttempt,
  getQuestionForAnalysis,
  getQuestionTextForAnalysis,
  getCachedQuestionTextAnalysis,
  enqueueQuestionTextAnalysis,
  getSentence,
  getSectionCachedAnalyses,
  AnalysisQueueFullError,
  AnalysisPausedError,
  listPapers,
  pool,
  savePracticeAnswers,
  submitPracticeAttempt,
} from './store.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: config.corsOrigins,
});

registerArticleChat(app, { config, loadContext: loadArticleChatContext });

app.get('/healthz', async () => ({ status: 'ok' }));

function adminEnabled(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  if (config.adminEnabled) return true;
  reply.code(404).send({ error: 'admin_disabled' });
  return false;
}

app.get<{ Querystring: { jobType?: string; jobStatus?: string; page?: string; limit?: string } }>('/api/admin/analysis', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  const { jobType, jobStatus, page, limit } = request.query;
  const parsedPage = page === undefined ? 0 : Number(page);
  const parsedLimit = limit === undefined ? 20 : Number(limit);
  if ((jobType && !['sentence', 'text', 'question'].includes(jobType)) ||
      (jobStatus && !['active', 'pending', 'running', 'succeeded', 'failed'].includes(jobStatus)) ||
      !Number.isInteger(parsedPage) || parsedPage < 0 || parsedPage > 10000 ||
      !Number.isInteger(parsedLimit) || parsedLimit < 10 || parsedLimit > 50) {
    return reply.code(400).send({ error: 'invalid_job_filter' });
  }
  return getAdminOverview(jobType || undefined, jobStatus || undefined, parsedPage, parsedLimit);
});

app.get('/api/admin/analysis/settings', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  return { settings: await getAdminSettings() };
});

app.get<{ Params: { id: string } }>('/api/admin/analysis/jobs/:id', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id)) {
    return reply.code(400).send({ error: 'invalid_job_id' });
  }
  const detail = await getAdminJobDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'job_not_found' });
  return detail;
});

app.patch<{ Body: unknown }>('/api/admin/analysis/settings', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  try {
    return { settings: await updateAdminSettings(request.body, request.ip || 'admin-console') };
  } catch (error) {
    if (error instanceof InvalidAdminSettingsError) {
      return reply.code(400).send({ error: 'invalid_admin_settings', message: error.message });
    }
    throw error;
  }
});

app.post('/api/admin/analysis/backfill/pause', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  return { settings: await setBackfillPaused(true) };
});

app.post('/api/admin/analysis/backfill/resume', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  return { settings: await setBackfillPaused(false) };
});

app.get('/api/admin/analysis/papers', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  return { papers: await listAdminPapers() };
});

app.get<{ Params: { id: string } }>('/api/admin/analysis/papers/:id/sections', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  return { sections: await listAdminSections(request.params.id) };
});

app.get('/api/admin/analysis/priority', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  return { priority: await getAdminPriority() };
});

app.post<{ Body: unknown }>('/api/admin/analysis/priority', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  try { return await setAdminPriority(request.body, request.ip); }
  catch (error) {
    if (error instanceof InvalidPriorityTargetError) return reply.code(400).send({ error: 'invalid_priority_target', message: error.message });
    throw error;
  }
});

app.delete<{ Params: { revision: string } }>('/api/admin/analysis/priority/:revision', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  try { return await removeAdminPriority(request.params.revision, request.ip || 'admin-console'); }
  catch (error) {
    if (error instanceof InvalidPriorityTargetError) return reply.code(400).send({ error: 'invalid_priority_target', message: error.message });
    throw error;
  }
});

app.post<{ Body: { items?: unknown } }>('/api/admin/analysis/papers/reorder', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  try { return { papers: await reorderAdminPapers(request.body?.items, request.ip || 'admin-console') }; }
  catch (error) { if (error instanceof InvalidAdminSettingsError) return reply.code(400).send({ error: 'invalid_paper_order', message: error.message }); throw error; }
});

app.post<{ Body: { errorCode?: string; limit?: number; jobId?: string; jobType?: string } }>('/api/admin/analysis/retry', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  try { return retryAdminFailures(request.body?.errorCode, request.body?.limit, request.ip || 'admin-console', request.body?.jobId, request.body?.jobType); }
  catch (error) { if (error instanceof InvalidAdminSettingsError) return reply.code(400).send({ error: 'invalid_retry_filter', message: error.message }); throw error; }
});

app.post<{ Body: { jobType?: string } }>('/api/admin/analysis/clear-failures', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  try {
    return await clearAdminFailures(request.body?.jobType, request.ip || 'admin-console');
  } catch (error) {
    if (error instanceof InvalidAdminSettingsError) return reply.code(400).send({ error: 'invalid_failure_filter', message: error.message });
    throw error;
  }
});

app.get<{ Querystring: { limit?: string } }>('/api/admin/analysis/audit', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  return { entries: await listAdminAudit(Number(request.query.limit || 50)) };
});

app.get<{ Querystring: { before?: string } }>('/api/news', async (request, reply) => {
  reply.header('Cache-Control','no-store');
  if (request.query.before && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(request.query.before)) return reply.code(400).send({ error:'invalid_cursor' });
  if (request.query.before && Number.isNaN(Date.parse(request.query.before))) return reply.code(400).send({ error:'invalid_cursor' });
  return listNews(request.query.before);
});
app.get<{ Params: { id: string } }>('/api/news/:id', async (request, reply) => {
  const article = await getNews(request.params.id);
  if (!article) return reply.code(404).send({ error:'article_not_found' });
  return article;
});
app.get<{ Params: { id:string }; Querystring: { mode?:string } }>('/api/news/:id/analyses', async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  if (request.query.mode!=='intensive') return reply.code(400).send({ error:'analysis_requires_intensive_mode' });
  return { analyses:await getSectionCachedAnalyses(request.params.id,`${request.params.id}-body`,true) };
});

// The public library only needs paper metadata. Progress requires several
// full-database aggregation queries and belongs on the admin progress page.
app.get('/api/papers', async (_request, reply) => {
  reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return { papers: await listPapers(false) };
});

app.get<{ Params: { board: string } }>('/api/reading-progress/:board', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!isReadingProgressBoard(request.params.board)) return reply.code(404).send({ error: 'reading_progress_board_not_found' });
  return { progress: await getReadingProgress(request.params.board) };
});

app.put<{ Params: { board: string }; Body: unknown }>('/api/reading-progress/:board', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!isReadingProgressBoard(request.params.board)) return reply.code(404).send({ error: 'reading_progress_board_not_found' });
  const progress = parseReadingProgressInput(request.params.board, request.body);
  if (!progress) return reply.code(400).send({ error: 'invalid_reading_progress' });
  const saved = await saveReadingProgress(request.params.board, progress);
  if (!saved) return reply.code(404).send({ error: 'reading_progress_target_not_found' });
  return { progress: saved };
});

app.delete<{ Params: { board: string } }>('/api/reading-progress/:board', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!isReadingProgressBoard(request.params.board)) return reply.code(404).send({ error: 'reading_progress_board_not_found' });
  await deleteReadingProgress(request.params.board);
  return { ok: true };
});

app.get<{ Params: { id: string } }>('/api/papers/:id', async (request, reply) => {
  const paper = await getPaper(request.params.id);
  if (!paper) return reply.code(404).send({ error: 'paper_not_found' });
  return paper;
});

app.get<{ Params: { id: string }; Querystring: { mode?: string; section?: string } }>('/api/papers/:id/analyses', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (request.query.mode !== 'intensive') return reply.code(400).send({ error: 'analysis_requires_intensive_mode' });
  if (!request.query.section) return reply.code(400).send({ error: 'section_required' });
  return { analyses: await getSectionCachedAnalyses(request.params.id, request.query.section) };
});

app.post<{ Params: { id: string }; Querystring: { mode?: string; regenerate?: string; interactive?: string } }>('/api/sentences/:id/analyze', async (request, reply) => {
  if (request.query.mode !== 'intensive') return reply.code(400).send({ error: 'analysis_requires_intensive_mode' });
  if (request.query.regenerate !== undefined && !['true', 'false'].includes(request.query.regenerate)) {
    return reply.code(400).send({ error: 'invalid_regeneration_option' });
  }
  if (request.query.interactive !== undefined && request.query.interactive !== 'true') {
    return reply.code(400).send({ error: 'invalid_priority_option' });
  }
  const sentence = await getSentence(request.params.id);
  if (!sentence) return reply.code(404).send({ error: 'sentence_not_found' });

  if (request.query.regenerate !== 'true') {
    const cached = await getCachedAnalysis(sentence.id, sentence.source_hash, sentence.context_hash, sentence.source_text);
    if (cached) {
      return { status: 'ready', sentenceId: sentence.id, result: cached, mode: config.mode, cached: true };
    }
  }

  try {
    const job = await enqueueAnalysis(sentence, request.query.interactive === 'true' ? 100 : 10);
    return reply.code(202).send({ status: 'generating', jobId: job.id, mode: config.mode });
  } catch (error) {
    if (error instanceof AnalysisPausedError) {
      return reply.code(503).header('Retry-After', '30').send({ error: 'analysis_temporarily_paused', retryAfterSeconds: 30 });
    }
    if (error instanceof AnalysisQueueFullError) {
      return reply.code(429).header('Retry-After', '30').send({ error: 'analysis_queue_full', retryAfterSeconds: 30 });
    }
    throw error;
  }
});

app.post<{ Params: { id: string }; Querystring: { mode?: string; regenerate?: string } }>('/api/questions/:id/analyze', async (request, reply) => {
  if (request.query.mode !== 'question') return reply.code(400).send({ error: 'analysis_requires_question_mode' });
  if (request.query.regenerate !== undefined && !['true', 'false'].includes(request.query.regenerate)) {
    return reply.code(400).send({ error: 'invalid_regeneration_option' });
  }
  const input = await getQuestionForAnalysis(request.params.id);
  if (!input) return reply.code(404).send({ error: 'question_not_found' });
  if (request.query.regenerate !== 'true') {
    const cached = await getCachedQuestionAnalysis(input);
    if (cached) return { status: 'ready', questionId: input.id, result: cached, mode: config.mode, cached: true };
  }
  try {
    const job = await enqueueQuestionAnalysis(input, 100);
    return reply.code(202).send({ status: 'generating', jobId: job.id, mode: config.mode });
  } catch (error) {
    if (error instanceof AnalysisPausedError) return reply.code(503).header('Retry-After', '30').send({ error: 'analysis_temporarily_paused', retryAfterSeconds: 30 });
    if (error instanceof AnalysisQueueFullError) return reply.code(429).header('Retry-After', '30').send({ error: 'analysis_queue_full', retryAfterSeconds: 30 });
    throw error;
  }
});

app.post<{ Params: { id: string }; Querystring: { mode?: string; textKey?: string; regenerate?: string } }>('/api/question-texts/:id/analyze', async (request, reply) => {
  if (request.query.mode !== 'intensive' || !request.query.textKey) return reply.code(400).send({ error: 'invalid_question_text_request' });
  if (request.query.regenerate !== undefined && !['true', 'false'].includes(request.query.regenerate)) return reply.code(400).send({ error: 'invalid_regeneration_option' });
  const input = await getQuestionTextForAnalysis(request.params.id, request.query.textKey);
  if (!input) return reply.code(404).send({ error: 'question_text_not_found' });
  if (request.query.regenerate !== 'true') {
    const cached = await getCachedQuestionTextAnalysis(input);
    if (cached) return { status: 'ready', questionId: input.questionId, textKey: input.textKey, result: cached, mode: config.mode, cached: true };
  }
  try {
    const job = await enqueueQuestionTextAnalysis(input, 100);
    return reply.code(202).send({ status: 'generating', jobId: job.id, mode: config.mode });
  } catch (error) {
    if (error instanceof AnalysisPausedError) return reply.code(503).header('Retry-After', '30').send({ error: 'analysis_temporarily_paused', retryAfterSeconds: 30 });
    if (error instanceof AnalysisQueueFullError) return reply.code(429).header('Retry-After', '30').send({ error: 'analysis_queue_full', retryAfterSeconds: 30 });
    throw error;
  }
});

app.post<{ Params: { id: string } }>('/api/papers/:id/attempts', async (request, reply) => {
  const attempt = await createPracticeAttempt(request.params.id);
  if (!attempt) return reply.code(400).send({ error: 'practice_unavailable' });
  return reply.code(201).send(attempt);
});

app.get<{ Params: { id: string } }>('/api/attempts/:id', async (request, reply) => {
  const attempt = await getPracticeAttempt(request.params.id);
  if (!attempt) return reply.code(404).send({ error: 'attempt_not_found' });
  return attempt;
});

app.patch<{ Params: { id: string }; Body: { answers?: unknown } }>('/api/attempts/:id/answers', async (request, reply) => {
  try {
    const attempt = await savePracticeAnswers(request.params.id, request.body?.answers ?? {});
    if (!attempt) return reply.code(404).send({ error: 'attempt_not_found_or_submitted' });
    return attempt;
  } catch {
    return reply.code(400).send({ error: 'invalid_answers' });
  }
});

app.post<{ Params: { id: string } }>('/api/attempts/:id/submit', async (request, reply) => {
  try {
    const attempt = await submitPracticeAttempt(request.params.id);
    if (!attempt) return reply.code(404).send({ error: 'attempt_not_found' });
    return attempt;
  } catch {
    return reply.code(400).send({ error: 'invalid_attempt' });
  }
});

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  const job = await getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'job_not_found' });
  return job;
});

app.addHook('onClose', async () => pool.end());

await app.listen({ port: config.port, host: '0.0.0.0' });

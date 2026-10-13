import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import {
  getAdminOverview,
  getAdminSettings,
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

app.get('/healthz', async () => ({ status: 'ok' }));

function adminEnabled(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  if (config.adminEnabled) return true;
  reply.code(404).send({ error: 'admin_disabled' });
  return false;
}

app.get<{ Querystring: { jobType?: string; jobStatus?: string } }>('/api/admin/analysis', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  const { jobType, jobStatus } = request.query;
  if ((jobType && !['sentence', 'text', 'question'].includes(jobType)) ||
      (jobStatus && !['active', 'pending', 'running', 'succeeded', 'failed'].includes(jobStatus))) {
    return reply.code(400).send({ error: 'invalid_job_filter' });
  }
  return getAdminOverview(jobType || undefined, jobStatus || undefined);
});

app.get('/api/admin/analysis/settings', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!adminEnabled(reply)) return;
  return { settings: await getAdminSettings() };
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

app.get('/api/papers', async () => ({ papers: await listPapers() }));

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

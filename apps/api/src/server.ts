import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import {
  createPracticeAttempt,
  enqueueAnalysis,
  getCachedAnalysis,
  getJob,
  getPaper,
  getPracticeAttempt,
  getSentence,
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

app.get('/api/papers', async () => ({ papers: await listPapers() }));

app.get<{ Params: { id: string } }>('/api/papers/:id', async (request, reply) => {
  const paper = await getPaper(request.params.id);
  if (!paper) return reply.code(404).send({ error: 'paper_not_found' });
  return paper;
});

app.post<{ Params: { id: string }; Querystring: { mode?: string; regenerate?: string } }>('/api/sentences/:id/analyze', async (request, reply) => {
  if (request.query.mode !== 'intensive') return reply.code(400).send({ error: 'analysis_requires_intensive_mode' });
  if (request.query.regenerate !== undefined && !['true', 'false'].includes(request.query.regenerate)) {
    return reply.code(400).send({ error: 'invalid_regeneration_option' });
  }
  const sentence = await getSentence(request.params.id);
  if (!sentence) return reply.code(404).send({ error: 'sentence_not_found' });

  if (request.query.regenerate !== 'true') {
    const cached = await getCachedAnalysis(sentence.id, sentence.source_hash, sentence.context_hash);
    if (cached) {
      return { status: 'ready', sentenceId: sentence.id, result: cached, mode: config.mode, cached: true };
    }
  }

  const job = await enqueueAnalysis(sentence);
  return reply.code(202).send({ status: 'generating', jobId: job.id, mode: config.mode });
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
  const job = await getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'job_not_found' });
  return job;
});

app.addHook('onClose', async () => pool.end());

await app.listen({ port: config.port, host: '0.0.0.0' });

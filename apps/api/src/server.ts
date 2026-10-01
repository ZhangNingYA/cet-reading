import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import {
  enqueueAnalysis,
  getCachedAnalysis,
  getJob,
  getPaper,
  getSentence,
  listPapers,
  pool,
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

app.post<{ Params: { id: string } }>('/api/sentences/:id/analyze', async (request, reply) => {
  const sentence = await getSentence(request.params.id);
  if (!sentence) return reply.code(404).send({ error: 'sentence_not_found' });

  const cached = await getCachedAnalysis(sentence.id, sentence.source_hash, sentence.context_hash);
  if (cached) {
    return { status: 'ready', sentenceId: sentence.id, result: cached, mode: config.mode, cached: true };
  }

  const job = await enqueueAnalysis(sentence);
  return reply.code(202).send({ status: 'generating', jobId: job.id, mode: config.mode });
});

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
  const job = await getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'job_not_found' });
  return job;
});

app.addHook('onClose', async () => pool.end());

await app.listen({ port: config.port, host: '0.0.0.0' });

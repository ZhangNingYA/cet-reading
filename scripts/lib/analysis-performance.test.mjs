import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { buildAnalysis, contextHash, sourceHash } from '@cet-reading/contracts';
import { readConfig } from '@cet-reading/contracts/config';
import { source, raw } from './fixtures/analysis.mjs';

const { runJobQueue } = await tsImport('../../apps/worker/src/job-queue.ts', import.meta.url);
const { getSectionCachedAnalyses, getJob, pool } = await tsImport('../../apps/api/src/store.ts', import.meta.url);

test('a slow sentence does not block the second slot, and queued work starts when either slot frees', async t => {
  const stop = new AbortController();
  const gates = [1, 2, 3].map(() => Promise.withResolvers());
  const second = Promise.withResolvers();
  const third = Promise.withResolvers();
  const pending = [1, 2, 3];
  const started = []; let active = 0; let peak = 0;
  t.after(() => { stop.abort(); gates.forEach(gate => gate.resolve()); });
  const queue = runJobQueue({
    concurrency: 2, signal: stop.signal,
    claim: async () => pending.shift() ?? null,
    process: async job => {
      started.push(job); peak = Math.max(peak, ++active);
      if (job === 2) second.resolve();
      if (job === 3) third.resolve();
      await gates[job - 1].promise; active--;
    },
  });
  await second.promise;
  assert.deepEqual(started, [1, 2]);
  gates[1].resolve();
  await third.promise;
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(peak, 2);
  stop.abort(); gates.forEach(gate => gate.resolve());
  await queue;
  assert.equal(active, 0, 'Shutdown waits for claimed work without dropping results');
});

test('an idle queue accepts later work, and an unexpected processing error is propagated', async () => {
  const stop = new AbortController();
  const idle = Promise.withResolvers();
  const started = Promise.withResolvers();
  const pending = [];
  const queue = runJobQueue({
    concurrency: 2, signal: stop.signal, idleMs: 5,
    claim: async () => { idle.resolve(); return pending.shift() ?? null; },
    process: async () => { started.resolve(); stop.abort(); },
  });
  await idle.promise; pending.push(1);
  await started.promise; await queue;
  let claimed = false;
  await assert.rejects(runJobQueue({
    concurrency: 2, signal: new AbortController().signal,
    claim: async () => claimed ? null : (claimed = true, 1),
    process: async () => { throw new Error('test worker failure'); },
  }), /test worker failure/);
});

test('prefetch skips stale and invalid results while retaining a valid older cache', async t => {
  const valid = buildAnalysis(source, raw());
  const invalid = structuredClone(valid);
  invalid.grammar.clauses[0].explanation = '句子主要成分';
  const context = { title: 'A paper', previousSentence: 'The preceding section ends here.', nextSentence: null };
  let query = 0;
  t.mock.method(pool, 'query', async () => ++query === 1 ? { rows: [{
    id: 's1', source_text: source, source_hash: sourceHash(source), title: context.title,
    previous_sentence: context.previousSentence, next_sentence: context.nextSentence,
  }] } : { rows: [
    { sentence_id: 's1', source_hash: 'changed-source', context_hash: contextHash(context), analysis_json: valid },
    { sentence_id: 's1', source_hash: sourceHash(source), context_hash: 'changed-context', analysis_json: valid },
    { sentence_id: 's1', source_hash: sourceHash(source), context_hash: contextHash(context), analysis_json: invalid },
    { sentence_id: 's1', source_hash: sourceHash(source), context_hash: contextHash(context), analysis_json: valid },
  ] });
  assert.deepEqual(await getSectionCachedAnalyses('paper', 'section'), [{ sentenceId: 's1', source, result: valid }]);
});

test('completed jobs return only fully validated results without exposing internal fields', async t => {
  const valid = buildAnalysis(source, raw());
  const row = { id: 'job', status: 'succeeded', source_text: source, error_message: null, analysis_json: valid };
  t.mock.method(pool, 'query', async () => ({ rows: [row] }));
  assert.deepEqual(await getJob('job'), { id: 'job', status: 'succeeded', errorCode: null, result: valid });
  row.analysis_json = structuredClone(valid);
  row.analysis_json.grammar.components = [];
  assert.deepEqual(await getJob('job'), { id: 'job', status: 'succeeded', errorCode: null });
});

test('worker concurrency is bounded independently of the model, prompt and generation deadline', () => {
  const baseline = readConfig({});
  const sequential = readConfig({ WORKER_CONCURRENCY: '1' });
  assert.equal(baseline.workerConcurrency, 1);
  assert.deepEqual({ ...sequential, workerConcurrency: 1 }, baseline);
  assert.throws(() => readConfig({ WORKER_CONCURRENCY: '5' }));
  assert.throws(() => readConfig({ WORKER_CONCURRENCY: '0' }));
});

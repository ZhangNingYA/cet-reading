import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { buildAnalysis } from '@cet-reading/contracts';
import { source, raw } from './fixtures/analysis.mjs';

const { AnalysisPausedError, AnalysisQueueFullError, enqueueAnalysis, getCachedAnalysis, getJob, pool } = await tsImport('../../apps/api/src/store.ts', import.meta.url);
function badCache() {
  const cached = buildAnalysis(source, raw());
  cached.grammar.clauses[0].explanation = '句子主要成分';
  return cached;
}

test('skips placeholder caches and reuses a valid earlier result', async t => {
  const valid = buildAnalysis(source, raw());
  t.mock.method(pool, 'query', async () => ({ rows: [{ analysis_json: badCache() }, { analysis_json: valid }] }));
  assert.deepEqual(await getCachedAnalysis('sentence-1', 'source-hash', 'context-hash', source), valid);
});

test('treats only invalid cached results as a miss without deleting their history', async t => {
  let queries = 0;
  t.mock.method(pool, 'query', async sql => {
    queries++;
    assert.match(sql.trim(), /^SELECT/);
    return { rows: [{ analysis_json: badCache() }] };
  });
  assert.equal(await getCachedAnalysis('sentence-1', 'source-hash', 'context-hash', source), undefined);
  assert.equal(queries, 1);
});

test('rejects public generation while the paper batch holds the shared AI gate', async t => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return String(sql).includes('pg_try_advisory_xact_lock_shared')
        ? { rows: [{ allowed: false }] }
        : { rows: [] };
    },
    release() { released = true; },
  };
  t.mock.method(pool, 'connect', async () => client);
  await assert.rejects(enqueueAnalysis({
    id: 'sentence-1', source_text: source, source_hash: 'source-hash',
    context_hash: 'context-hash', context: { title: 'Test', previousSentence: null, nextSentence: null },
  }), AnalysisPausedError);
  assert.equal(calls.some(call => call.sql.includes('pg_try_advisory_xact_lock_shared')), true);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
  assert.equal(released, true);
});

test('a user request evicts one pending background job when the eight-slot queue is full', async t => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      const statement = String(sql);
      calls.push(statement);
      if (statement.includes('pg_try_advisory_xact_lock_shared')) return { rows: [{ allowed: true }] };
      if (statement.includes('SELECT id, status')) return { rows: [] };
      if (statement.includes('COUNT(*) FILTER')) return { rows: [{ count: 8, background: 8 }] };
      if (statement.includes('DELETE FROM analysis_jobs')) return { rowCount: 1, rows: [{ id: 'background-job' }] };
      if (statement.includes('INSERT INTO analysis_jobs')) return { rows: [{ id: 'user-job', status: 'pending' }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  t.mock.method(pool, 'connect', async () => client);
  const result = await enqueueAnalysis({
    id: 'sentence-1', source_text: source, source_hash: 'source-hash',
    context_hash: 'context-hash', context: { title: 'Test', previousSentence: null, nextSentence: null },
  }, 100);
  assert.deepEqual(result, { id: 'user-job', status: 'pending' });
  assert.equal(calls.some(statement => statement.includes("status = 'pending' AND priority <= 1 AND attempts = 0")), true);
  assert.equal(released, true);
});

test('a full queue with no unstarted background jobs rejects admission without deleting history', async t => {
  const calls = [];
  const client = {
    async query(sql) {
      const statement = String(sql);
      calls.push(statement);
      if (statement.includes('pg_try_advisory_xact_lock_shared')) return { rows: [{ allowed: true }] };
      if (statement.includes('COUNT(*) FILTER')) return { rows: [{ count: 8, background: 4 }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  t.mock.method(pool, 'connect', async () => client);
  await assert.rejects(enqueueAnalysis({
    id: 'sentence-1', source_text: source, source_hash: 'source-hash',
    context_hash: 'context-hash', context: {},
  }, 100), AnalysisQueueFullError);
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
  assert.equal(calls.some(statement => statement.includes('INSERT INTO analysis_jobs')), false);
});

test('exposes safe job failure categories without returning the internal error', async t => {
  for (const [message, code] of [
    ['This operation was aborted', 'timeout'],
    ['AI request failed: 503', 'service_unavailable'],
    ['AI did not explain word token 17', 'invalid_result'],
    ['Private internal error with an upstream URL', 'generation_failed'],
  ]) {
    t.mock.method(pool, 'query', async () => ({ rows: [{ id: 'job-1', status: 'failed', error_message: message }] }));
    assert.deepEqual(await getJob('job-1'), { id: 'job-1', status: 'failed', errorCode: code });
  }
});

test('preserves pending, running and successful job states without a failure code', async t => {
  for (const status of ['pending', 'running', 'succeeded']) {
    t.mock.method(pool, 'query', async () => ({ rows: [{ id: 'job-1', status, error_message: null }] }));
    assert.deepEqual(await getJob('job-1'), { id: 'job-1', status, errorCode: null });
  }
  t.mock.method(pool, 'query', async () => ({ rows: [] }));
  assert.equal(await getJob('missing'), null);
});

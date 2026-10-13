import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { tsImport } from 'tsx/esm/api';

const { retryAdminFailures, InvalidAdminSettingsError } = await tsImport('../../apps/api/src/admin-store.ts', import.meta.url);
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

function clientMock(t, { candidates = [first, second], active = 8, evicted = 1 } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT j.id FROM analysis_jobs j JOIN')) return { rows: candidates.map(id => ({ id })) };
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: active }] };
      if (sql.includes('DELETE FROM analysis_jobs')) return { rows: [], rowCount: evicted };
      if (sql.startsWith('UPDATE analysis_jobs')) return { rows: params[0].map(id => ({ id })), rowCount: params[0].length };
      return { rows: [] };
    },
    release() { released = true; },
  };
  t.mock.method(Pool.prototype, 'connect', async () => client);
  return { calls, released: () => released };
}

test('a retry respects capacity and only replaces unstarted background tasks', async t => {
  const { calls, released } = clientMock(t);
  assert.deepEqual(await retryAdminFailures(undefined, 500), { retried: 1 });
  const update = calls.find(call => call.sql.startsWith('UPDATE analysis_jobs'));
  assert.deepEqual(update.params[0], [first]);
  const deletion = calls.find(call => call.sql.includes('DELETE FROM analysis_jobs'));
  assert.match(deletion.sql, /status='pending' AND priority<=1 AND attempts=0/);
  assert.equal(deletion.params[3], 2);
  assert.equal(calls.some(call => call.sql.includes('pg_advisory_xact_lock')), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
  assert.equal(released(), true);
});

test('single request retries carry the selected ID and type and take precedence over background work', async t => {
  const { calls } = clientMock(t, { candidates: [second], active: 7, evicted: 0 });
  assert.deepEqual(await retryAdminFailures(undefined, 1, 'admin-test', second, 'question'), { retried: 1 });
  const selection = calls.find(call => call.sql.includes('SELECT j.id FROM analysis_jobs j JOIN'));
  assert.deepEqual(selection.params.slice(5), [second, 'question']);
  assert.deepEqual(calls.find(call => call.sql.startsWith('UPDATE analysis_jobs')).params, [[second]]);
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM analysis_jobs')), false);
});

test('a queue full of running or already attempted work leaves failed tasks untouched', async t => {
  const { calls } = clientMock(t, { active: 8, evicted: 0 });
  assert.deepEqual(await retryAdminFailures(undefined), { retried: 0 });
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE analysis_jobs')), false);
});

test('a reduced queue capacity must recover free slots before admitting retries', async t => {
  const { calls } = clientMock(t, { active: 10, evicted: 2 });
  assert.deepEqual(await retryAdminFailures(undefined), { retried: 0 });
  assert.equal(calls.find(call => call.sql.includes('DELETE FROM analysis_jobs')).params[3], 4);
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE analysis_jobs')), false);
});

test('no matching failures leaves background work alone and invalid selectors are rejected', async t => {
  const { calls } = clientMock(t, { candidates: [] });
  assert.deepEqual(await retryAdminFailures(undefined), { retried: 0 });
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM analysis_jobs')), false);
  await assert.rejects(retryAdminFailures(undefined, 1, 'test', 'invalid'), InvalidAdminSettingsError);
  await assert.rejects(retryAdminFailures(undefined, 1, 'test', first, 'invalid'), InvalidAdminSettingsError);
});

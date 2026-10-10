import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { claimAnalysisJob } = await tsImport('../../apps/worker/src/claim-job.ts', import.meta.url);
const config = { mode: 'ai', model: 'test-model', promptVersion: 'test-v1', leaseSeconds: 210, maxAnalysisAttempts: 3 };

test('exhausted jobs leave the queue even when no other job is ready', async () => {
  let stored = { status: 'pending', attempts: 13 };
  let transaction;
  let released = false;
  const client = {
    async query(sql) {
      const statement = String(sql).trim();
      if (statement === 'BEGIN') transaction = { ...stored };
      else if (statement === 'COMMIT') stored = transaction;
      else if (statement === 'ROLLBACK') transaction = undefined;
      else if (statement.includes('pg_try_advisory_xact_lock_shared')) return { rows: [{ allowed: true }] };
      else if (statement.startsWith('UPDATE analysis_jobs')) transaction.status = 'failed';
      else if (statement.startsWith('WITH candidate')) return { rows: [] };
      else throw new Error(`Unexpected SQL: ${statement}`);
      return { rows: [] };
    },
    release() { released = true; },
  };
  assert.equal(await claimAnalysisJob({ connect: async () => client }, config), null);
  assert.equal(stored.status, 'failed', 'Quarantine must survive the empty claim transaction');
  assert.equal(stored.attempts, 13, 'The exhausted job must not make another model request');
  assert.equal(released, true);
});

test('a batch pause leaves jobs unchanged and releases the connection', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      calls.push(String(sql));
      return { rows: sql.includes('pg_try_advisory_xact_lock_shared') ? [{ allowed: false }] : [] };
    },
    release() { released = true; },
  };
  assert.equal(await claimAnalysisJob({ connect: async () => client }, config), null);
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.some(sql => sql.includes('UPDATE analysis_jobs')), false);
  assert.equal(released, true);
});

test('claim errors roll back quarantine so a partial transaction cannot escape', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (sql.includes('pg_try_advisory_xact_lock_shared')) return { rows: [{ allowed: true }] };
      if (sql.includes('WITH candidate')) throw new Error('Database claim failed');
      return { rows: [] };
    },
    release() { released = true; },
  };
  await assert.rejects(claimAnalysisJob({ connect: async () => client }, config), /Database claim failed/);
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
  assert.equal(released, true);
});

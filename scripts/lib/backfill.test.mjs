import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { fillBackgroundQueue } = await tsImport('../../apps/worker/src/backfill.ts', import.meta.url);
const { contextHash } = await tsImport('../../packages/contracts/src/index.ts', import.meta.url);

const config = {
  mode: 'ai', model: 'gpt-test', promptVersion: 'prompt-v1',
  backfillEnabled: true, backfillTarget: 1,
};

const candidate = (id, sentenceIndex) => ({
  id, owner_id: 'paper-1', source_text: `Sentence ${sentenceIndex}.`, source_hash: `source-${id}`,
  paper_id: 'paper-1', article_id: null, title: 'Paper', previous_sentence: null,
  next_sentence: null, paragraph_index: 0, sentence_index: sentenceIndex,
});

test('backfill queues one missing sentence and advances its cursor without skipping the next one', async t => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (String(sql).includes('SELECT id, status FROM analysis_jobs')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      const text = String(sql);
      if (text.includes('COUNT(*) FILTER')) return { rows: [{ total: 0, background: 0 }] };
      if (text.includes('WITH ordered')) return { rows: [candidate('s1', 0), candidate('s2', 1)] };
      if (text.includes('FROM sentence_analyses')) return { rows: [] };
      if (text.includes('FROM analysis_jobs')) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    },
    async connect() { return client; },
  };
  const result = await fillBackgroundQueue(pool, config);
  assert.equal(result.queued, 1);
  assert.deepEqual(result.nextCursor, { owner_id: 'paper-1', paragraph_index: 0, sentence_index: 0 });
  assert.equal(result.scanHasMore, false);
  assert.equal(calls.some(sql => sql.includes('INSERT INTO analysis_jobs')), true);
  t.mock.reset();
});

test('backfill immediately continues past a full page with no queueable candidates', async () => {
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`cached-${index}`, index));
  const currentContextHash = contextHash({ title: 'Paper', previousSentence: null, nextSentence: null });
  const pool = {
    async query(sql) {
      const text = String(sql);
      if (text.includes('COUNT(*) FILTER')) return { rows: [{ total: 0, background: 0 }] };
      if (text.includes('WITH ordered')) return { rows: candidates };
      if (text.includes('FROM sentence_analyses')) return { rows: [] };
      if (text.includes('FROM analysis_jobs')) {
        return { rows: candidates.map(row => ({
          sentence_id: row.id,
          source_hash: row.source_hash,
          context_hash: currentContextHash,
          status: 'failed',
        })) };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };

  const result = await fillBackgroundQueue(pool, config);
  assert.equal(result.queued, 0);
  assert.equal(result.scanHasMore, true);
  assert.deepEqual(result.nextCursor, { owner_id: 'paper-1', paragraph_index: 0, sentence_index: 49 });
});

test('four running background jobs leave capacity for four waiting jobs', async () => {
  const counts = { total: 4, background: 4 };
  let inserts = 0;
  const client = {
    async query(sql, params) {
      const statement = String(sql);
      if (statement.includes('pg_advisory_xact_lock')) {
        assert.equal(params[0], 'analysis:ai:gpt-test:prompt-v1', 'Admission shares the API capacity lock');
      }
      if (statement.includes('COUNT(*) FILTER')) return { rows: [{ ...counts }] };
      if (statement.includes('INSERT INTO analysis_jobs')) {
        inserts++;
        counts.total++;
        counts.background++;
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      const statement = String(sql);
      if (statement.includes('COUNT(*) FILTER')) return { rows: [{ ...counts }] };
      if (statement.includes('WITH ordered')) return { rows: Array.from({ length: 10 }, (_, i) => candidate(`s${i}`, i)) };
      return { rows: [] };
    },
    async connect() { return client; },
  };
  const result = await fillBackgroundQueue(pool, { ...config, backfillTarget: 8 });
  assert.equal(result.queued, 4);
  assert.equal(inserts, 4);
  assert.equal(counts.total, 8);
  assert.equal(result.nextCursor.sentence_index, 3);
  assert.equal((await fillBackgroundQueue(pool, { ...config, backfillTarget: 8 })).queued, 0);
  assert.equal(inserts, 4, 'The next scan must not overfill the queue');
});

test('background admission respects user jobs arriving after the scan counted capacity', async () => {
  let inserts = 0;
  const client = {
    async query(sql) {
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total: 8, background: 4 }] };
      if (sql.includes('INSERT INTO analysis_jobs')) inserts++;
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total: 4, background: 4 }] };
      if (sql.includes('WITH ordered')) return { rows: [candidate('s1', 0)] };
      return { rows: [] };
    },
    async connect() { return client; },
  };
  assert.equal((await fillBackgroundQueue(pool, { ...config, backfillTarget: 8 })).queued, 0);
  assert.equal(inserts, 0, 'A stale scan must not bypass the hard queue limit');
});

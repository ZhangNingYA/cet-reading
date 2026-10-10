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

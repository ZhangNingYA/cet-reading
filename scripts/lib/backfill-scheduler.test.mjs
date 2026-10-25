import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { runBackfillScheduler } = await tsImport('../../apps/worker/src/backfill.ts', import.meta.url);
const { contextHash } = await tsImport('../../packages/contracts/src/index.ts', import.meta.url);
const config = {
  mode: 'ai', model: 'gpt-test', promptVersion: 'v1', cachePromptVersions: ['v1'],
  backfillEnabled: true, backfillTarget: 1, workerConcurrency: 1, backfillIntervalMs: 20_000,
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = index => String(index).padStart(4, '0');

function database(sizes = [0, 0, 0]) {
  const state = {
    sizes, scans: [0, 0, 0], cursors: [[], [], []], inserts: 0,
    paused: false, occupied: 0, missing: false, priorityBlocked: false, priorityPolls: 0, fail: false,
  };
  const sentence = index => ({
    id: `s${id(index)}`, owner_id: 'paper-1', source_text: 'A sentence.', source_hash: 'hash',
    paper_id: 'paper-1', article_id: null, section_id: 'section-1', title: 'Paper',
    previous_sentence: null, next_sentence: null, paragraph_index: 0, sentence_index: index,
    news_batch_at: null, news_published_at: null,
  });
  const text = index => ({ question_id: `q${id(index)}`, text_key: 'prompt', source_text: 'A question?', title: 'Paper' });
  const question = index => ({
    question_id: `q${id(index)}`, question_type: 'reading', title: 'Paper', instructions: 'Choose.',
    paragraphs: ['A paragraph.'], prompt: 'A question?', options: [{ key: 'A', text: 'Answer.' }],
    answer: 'A', explanation: 'Explanation.',
  });
  const db = {
    async query(sql, params = []) {
      if (sql.includes('FROM analysis_runtime_settings')) return { rows: [{
        worker_concurrency: 1, queue_capacity: 8, background_target: 1,
        backfill_paused: state.paused, prompt_override: '',
      }] };
      if (sql.includes('pg_try_advisory_xact_lock_shared')) {
        state.priorityPolls++;
        return { rows: [{ allowed: !state.priorityBlocked }] };
      }
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total: state.occupied, background: state.occupied }] };
      const stream = sql.includes('WITH ordered') ? 0 : sql.includes('WITH visible_questions') ? 1 : sql.includes('FROM questions q') ? 2 : -1;
      if (stream !== -1) {
        state.scans[stream]++;
        if (state.fail) throw new Error('scan unavailable');
        const after = stream === 0 ? (params.length > 1 ? params[5] : -1) : (params[0] ? Number(params[0].slice(1)) : -1);
        state.cursors[stream].push(after);
        const end = Math.min(state.sizes[stream], after + 1 + params.at(-1));
        return { rows: Array.from({ length: Math.max(0, end - after - 1) }, (_, i) => [sentence, text, question][stream](after + 1 + i)) };
      }
      if (sql.includes('FROM analysis_jobs') && !sql.includes('SELECT id, status')) {
        if (state.missing) return { rows: [] };
        return { rows: params[0].map(key => {
          const index = Number(key.slice(1));
          const common = { status: 'failed', backfill_retry_count: 1, error_message: 'Already retried.' };
          if (sql.includes("job_type = 'text'")) {
            const row = text(index);
            return { ...common, question_id: key, text_key: 'prompt', source_hash: hash({ questionId: key, textKey: 'prompt', source: row.source_text }) };
          }
          if (sql.includes("job_type = 'question'")) {
            const { question_id, ...content } = question(index);
            return { ...common, question_id, source_hash: hash(content) };
          }
          return { ...common, sentence_id: key, source_hash: 'hash', context_hash: contextHash({ title: 'Paper', previousSentence: null, nextSentence: null }) };
        }) };
      }
      if (sql.includes('INSERT INTO analysis_jobs')) { state.inserts++; state.occupied++; }
      return { rows: [] };
    },
    async connect() { return db; },
    release() {},
  };
  return { state, db };
}

async function start(t, sizes) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { state, db } = database(sizes);
  const stop = new AbortController();
  const scheduler = runBackfillScheduler(db, config, stop.signal);
  t.after(async () => { stop.abort(); await scheduler; });
  await setImmediate();
  const tick = async ms => { t.mock.timers.tick(ms); await setImmediate(); };
  return { state, tick, stop, scheduler };
}

test('different scan lengths finish one pass without restarting shorter streams or spinning over cached pages', async t => {
  const { state, tick } = await start(t, [50, 100, 150]);
  assert.deepEqual(state.scans, [1, 1, 1]);
  await setImmediate();
  assert.deepEqual(state.scans, [1, 1, 1], 'An unproductive full page must yield');
  for (let i = 0; i < 3; i++) await tick(1000);
  assert.deepEqual(state.scans, [2, 3, 4]);
  assert.deepEqual(state.cursors, [[-1, 49], [-1, 49, 99], [-1, 49, 99, 149]]);
  await tick(19_999);
  assert.deepEqual(state.scans, [2, 3, 4], 'A complete pass must sleep before restarting');
  await tick(1);
  assert.deepEqual(state.scans, [3, 4, 5]);
});

test('idle passes back off to five minutes while priority checks keep running', async t => {
  const { state, tick } = await start(t);
  for (const delay of [20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
    const scans = [...state.scans];
    const polls = state.priorityPolls;
    await tick(3000);
    assert.ok(state.priorityPolls > polls);
    assert.deepEqual(state.scans, scans);
    await tick(delay - 3001);
    assert.deepEqual(state.scans, scans);
    await tick(1);
    assert.deepEqual(state.scans, scans.map(value => value + 1));
  }
});

test('new content is queued when the idle rescan wakes up', async t => {
  const { state, tick } = await start(t);
  state.sizes[0] = 1;
  state.missing = true;
  await tick(19_999);
  assert.equal(state.inserts, 0);
  await tick(1);
  assert.equal(state.inserts, 1);
});

test('pause and resume interrupt idle backoff and restart discovery', async t => {
  const { state, tick } = await start(t);
  await tick(20_000); // The next full scan is now 40s away.
  state.paused = true;
  await tick(3000);
  const scans = [...state.scans];
  state.paused = false;
  await tick(3000);
  assert.deepEqual(state.scans, scans.map(value => value + 1));
});

test('full capacity preserves unfinished cursors until slots free up', async t => {
  const { state, tick } = await start(t, [100, 0, 0]);
  state.occupied = 1;
  await tick(1000);
  assert.deepEqual(state.cursors[0], [-1]);
  state.occupied = 0;
  await tick(20_000);
  assert.deepEqual(state.cursors[0], [-1, 49]);
});

test('priority work blocks background scans even during a scheduled rescan', async t => {
  const { state, tick } = await start(t);
  state.priorityBlocked = true;
  await tick(20_000);
  assert.deepEqual(state.scans, [1, 1, 1]);
  state.priorityBlocked = false;
  await tick(3000);
  assert.deepEqual(state.scans, [2, 2, 2]);
});

test('scan errors wait before retrying, and abort cancels a sleeping scheduler', async t => {
  const { state, tick, stop, scheduler } = await start(t, [100, 0, 0]);
  state.fail = true;
  await tick(1000);
  const scans = [...state.scans];
  await tick(19_999);
  assert.deepEqual(state.scans, scans);
  stop.abort();
  await scheduler;
  await tick(60_000);
  assert.deepEqual(state.scans, scans);
});

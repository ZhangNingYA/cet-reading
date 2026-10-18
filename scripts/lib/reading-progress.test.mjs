import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const { READING_PROGRESS_BOARDS, isReadingProgressBoard, parseReadingProgressInput } =
  await tsImport('../../apps/api/src/reading-progress-store.ts', import.meta.url);
const { createReadingProgressStore } = await tsImport('../../apps/web/src/scripts/reading-progress.ts', import.meta.url);

test('reading progress is limited to one row for each of the four library boards', () => {
  assert.deepEqual(READING_PROGRESS_BOARDS, ['cet4', 'cet6', 'postgraduate', 'news']);
  for (const board of READING_PROGRESS_BOARDS) assert.equal(isReadingProgressBoard(board), true);
  assert.equal(isReadingProgressBoard('admin'), false);
});

test('reading progress input keeps valid positions and rejects invalid modes or oversized fields', () => {
  assert.deepEqual(parseReadingProgressInput('cet6', {
    itemId: 'cet6-2020-12-1', mode: 'intensive', sectionId: 'section-1', sentenceId: 'sentence-1',
    sentenceNumber: 3, sentencePreview: 'A sentence.',
  }), {
    itemId: 'cet6-2020-12-1', mode: 'intensive', sectionId: 'section-1', sentenceId: 'sentence-1',
    sentenceNumber: 3, sentencePreview: 'A sentence.',
  });
  assert.equal(parseReadingProgressInput('news', { itemId: 'article-1', mode: 'practice' }), null);
  assert.equal(parseReadingProgressInput('cet4', { itemId: 'paper', mode: 'intensive', sentenceNumber: 0 }), null);
  assert.equal(parseReadingProgressInput('cet4', { itemId: 'paper', mode: 'intensive', sectionTitle: 'x'.repeat(301) }), null);
});

test('fresh databases and existing deployments apply the same reading progress schema', () => {
  const migration = readFileSync('db/migrations/026_reading_progress.sql', 'utf8');
  assert.equal(readFileSync('db/init/026_reading_progress.sql', 'utf8'), migration);
  assert.match(migration, /board TEXT PRIMARY KEY CHECK \(board IN \('cet4', 'cet6', 'postgraduate', 'news'\)\)/);
  assert.match(readFileSync('apps/api/src/reading-progress-store.ts', 'utf8'), /ON CONFLICT \(board\) DO UPDATE/);
  assert.match(readFileSync('scripts/deploy-server.sh', 'utf8'), /db\/migrations\/026_reading_progress\.sql/);
});

test('the server value wins over a browser-local position and is mirrored for offline fallback', async (t) => {
  const storage = new Map([['legacy', JSON.stringify({ paperId: 'old-paper', mode: 'intensive' })]]);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {} } });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  });
  const shared = { itemId: 'shared-paper', mode: 'intensive', sectionId: 'section-2' };
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'GET'
    ? new Response(JSON.stringify({ progress: shared }), { headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ progress: options.body ? JSON.parse(options.body) : null }), { headers: { 'Content-Type': 'application/json' } }));
  const store = createReadingProgressStore('/api', 'cet4', 'legacy');
  assert.deepEqual(await store.load(), shared);
  assert.equal(JSON.parse(storage.get('legacy')).paperId, 'shared-paper');
});

test('an empty server slot imports the old position once, then saves future positions remotely', async (t) => {
  const storage = new Map([['legacy', JSON.stringify({ paperId: 'old-paper', mode: 'intensive', sectionId: 'old-section' })]]);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {} } });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    const progress = options.method === 'GET' ? null : { ...JSON.parse(options.body), updatedAt: '2026-10-18T00:00:00.000Z' };
    return new Response(JSON.stringify({ progress }), { headers: { 'Content-Type': 'application/json' } });
  });
  const store = createReadingProgressStore('https://example.test', 'cet6', 'legacy');
  assert.equal((await store.load()).itemId, 'old-paper');
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'https://example.test/api/reading-progress/cet6');
  store.save({ itemId: 'new-paper', mode: 'intensive', sectionId: 'section-3' });
  await store.flush();
  assert.equal(calls.at(-1).method, 'PUT');
  assert.equal(calls.at(-1).body.itemId, 'new-paper');
});

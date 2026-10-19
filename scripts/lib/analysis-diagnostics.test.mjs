import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { source, raw } from './fixtures/analysis.mjs';
const { generateAnalysis } = await tsImport('../../apps/worker/src/ai-analysis.ts', import.meta.url);
const { ModelRequestTrace, TRACE_TEXT_LIMIT } = await tsImport('../../apps/worker/src/model-request-trace.ts', import.meta.url);
const { createAnalysisTraceRecorder } = await tsImport('../../apps/worker/src/analysis-trace-store.ts', import.meta.url);
const { getAdminJobDetail } = await tsImport('../../apps/api/src/admin-store.ts', import.meta.url);
const input = { source_text: source, context_json: { title: 'Diagnostic test', previousSentence: null, nextSentence: null } };
const config = { apiUrl: 'https://model.test/v1', apiKey: 'test-private-key', model: 'test-model', requestTimeoutMs: 1000 };
const reply = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json', 'x-request-id': 'provider-test-id' } });
function observe() { const traces = new Map(); return { traces, onRequestTrace: async trace => traces.set(trace.id, structuredClone(trace)) }; }

test('retains the exact rejected answer and repair answer with separate send/response/validation times', async t => {
  const bad = raw(); bad.grammar.components[0].tokenStart = 3; bad.grammar.components[0].tokenEnd = 3;
  const contents = [JSON.stringify(bad), JSON.stringify(raw())]; let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => reply(contents[calls++]));
  const capture = observe(); await generateAnalysis(input, { ...config, ...capture });
  assert.equal(calls, 2);
  const traces = [...capture.traces.values()]; assert.equal(traces.length, 2);
  for (const [index, trace] of traces.entries()) {
    assert.equal(trace.responseText, contents[index]); assert.equal(trace.round, index + 1);
    assert.equal(trace.purpose, index ? 'repair' : 'initial'); assert.equal(trace.httpStatus, 200);
    assert.equal(trace.providerRequestId, 'provider-test-id'); assert.equal(trace.finishReason, 'stop');
    for (const name of ['sentAt', 'responseAt', 'firstContentAt', 'completedAt', 'validatedAt']) assert(Number.isFinite(Date.parse(trace[name])));
    assert(Date.parse(trace.sentAt) <= Date.parse(trace.responseAt)); assert(Date.parse(trace.completedAt) <= Date.parse(trace.validatedAt));
    assert(JSON.parse(trace.requestText).messages.some(message => message.content.includes(source)));
  }
  assert.equal(traces[0].validationStatus, 'failed'); assert.match(traces[0].validationError, /field=grammar.components\[0\]/);
  assert.equal(traces[1].validationStatus, 'passed'); assert.equal(traces[1].validationError, null);
});

test('keeps HTTP failure bodies and network retry history while redacting echoed credentials', async t => {
  let calls = 0; const capture = observe();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${config.apiKey}`);
    return ++calls === 1 ? new Response(JSON.stringify({ error: `busy; ${config.apiKey}; Bearer another-secret-token` }), { status: 503, headers: { 'retry-after': '0' } }) : reply(JSON.stringify(raw()));
  });
  await generateAnalysis(input, { ...config, ...capture });
  const [failed, successful] = [...capture.traces.values()];
  assert.equal(failed.httpStatus, 503); assert.equal(failed.validationStatus, 'not_run'); assert.match(failed.responseBody, /busy/);
  assert.equal(successful.transportAttempt, 2); assert.equal(successful.round, 1); assert.equal(successful.purpose, 'initial');
  const stored = JSON.stringify([...capture.traces.values()]); assert(!stored.includes(config.apiKey)); assert(!stored.includes('another-secret-token')); assert(stored.includes('已隐藏密钥'));
});

test('saves partially received model output when a stream times out', async t => {
  const capture = observe(); const partial = '{"translation":"已经返回的部分';
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n`));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(generateAnalysis(input, { ...config, requestTimeoutMs: 30, ...capture }), /timed out/);
  const [trace] = capture.traces.values(); assert.equal(capture.traces.size, 1);
  assert.equal(trace.responseText, partial); assert(trace.firstContentAt); assert(trace.completedAt); assert.match(trace.errorMessage, /timed out/); assert.equal(trace.validationStatus, 'not_run');
});

test('records validation paths without changing the returned model result or failing generation when recording is unavailable', async t => {
  const bad = raw(); delete bad.translation; const capture = observe(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => reply(JSON.stringify(++calls === 1 ? bad : raw())));
  await generateAnalysis(input, { ...config, ...capture });
  assert([...capture.traces.values()][0].validationIssues.some(issue => issue.path === 'translation'));
  t.mock.method(console, 'warn', () => {}); calls = 1;
  const result = await generateAnalysis(input, { ...config, onRequestTrace: async () => { throw new Error('database unavailable'); } });
  assert.equal(result.translation, raw().translation); assert.equal(calls, 2);
});

test('bounds stored diagnostic text and marks truncation explicitly', async () => {
  const capture = observe(); const trace = new ModelRequestTrace('model', 1, 1, 'a'.repeat(TRACE_TEXT_LIMIT + 1), config.apiKey, capture.onRequestTrace);
  trace.append('b'.repeat(TRACE_TEXT_LIMIT + 10)); await trace.finish();
  const [stored] = capture.traces.values(); assert.equal(stored.requestText.length, TRACE_TEXT_LIMIT); assert.equal(stored.responseText.length, TRACE_TEXT_LIMIT); assert.equal(stored.responseChars, TRACE_TEXT_LIMIT + 10); assert(stored.requestTruncated && stored.responseTruncated);
});

test('updates the same physical request record and preserves separate execution runs', async () => {
  const calls = []; const db = { query: async (sql, values) => { calls.push({ sql, values }); } };
  const job = { id: 'job-id', attempts: 2 }; const firstRun = createAnalysisTraceRecorder(db, job), secondRun = createAnalysisTraceRecorder(db, job);
  const trace = new ModelRequestTrace('model', 1, 1, '{}', ''); await firstRun(trace.data); await firstRun({ ...trace.data, completedAt: new Date().toISOString() }); await secondRun(trace.data);
  assert.equal(calls[0].values[0], calls[1].values[0]); assert.equal(calls[0].values[2], calls[1].values[2]); assert.notEqual(calls[0].values[2], calls[2].values[2]); assert.equal(calls[0].values[3], 2); assert.match(calls[0].sql, /ON CONFLICT \(id\) DO UPDATE/);
});

test('admin details contain the full original sentence and strictly scoped request records, with no fabricated legacy raw answer', async t => {
  const original = 'The full original sentence. '.repeat(30); const queries = [];
  const db = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes('FROM analysis_jobs j')) return { rows: [{ id: 'job-id', status: 'failed', job_type: 'sentence', attempts: 1, source_text: original, context_json: { title: 'News' }, question_json: null, model: 'test-model', mode: 'ai', prompt_version: 'test', title: 'News', created_at: new Date(), error_message: 'Grammar range [13, 13) must contain a source word and stay inside the 32 source tokens' }] };
    assert.match(sql, /FROM analysis_request_traces/); assert.deepEqual(values, ['job-id']); return { rows: [] };
  } };
  const detail = await getAdminJobDetail('job-id', db); assert.equal(detail.source, original); assert.equal(detail.requests.length, 0); assert.equal(detail.requestsHasMore, false); assert(detail.errorMessage.includes('[13, 13)')); assert.match(queries[0].sql, /j.mode=\$2 AND j.model=\$3 AND j.prompt_version=\$4/);
});

test('does not expose request traces for a missing or differently configured job', async t => {
  let calls = 0; const db = { query: async () => { calls++; return { rows: [] }; } }; assert.equal(await getAdminJobDetail('missing-job', db), null); assert.equal(calls, 1);
});

test('fresh and existing databases share the idempotent trace migration with linked retention', () => {
  const migration = readFileSync('db/migrations/027_analysis_request_traces.sql', 'utf8');
  assert.equal(migration, readFileSync('db/init/027_analysis_request_traces.sql', 'utf8')); assert.match(migration, /REFERENCES analysis_jobs\(id\) ON DELETE CASCADE/); assert.match(migration, /CREATE TABLE IF NOT EXISTS/); assert.match(readFileSync('scripts/deploy-server.sh', 'utf8'), /db\/migrations\/027_analysis_request_traces.sql/);
});

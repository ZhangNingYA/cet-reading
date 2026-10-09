import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { source, raw } from './fixtures/analysis.mjs';

const { generateAnalysis } = await tsImport('../../apps/worker/src/ai-analysis.ts', import.meta.url);
const input = { source_text: source, context_json: { title: 'Test paper', previousSentence: null, nextSentence: null } };
const config = { apiUrl: 'https://model.test/v1', apiKey: 'test-only', model: 'test-model', requestTimeoutMs: 1000 };
function reply(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } });
}

test('accepts a specific, complete grammar result without an extra model request', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body)); return reply(JSON.stringify(raw()));
  });
  const analysis = await generateAnalysis(input, config);
  assert.equal(calls.length, 1);
  assert.equal(analysis.grammar.clauses[0].type, '主句');
  assert.match(analysis.grammar.clauses[0].explanation, /People attribute/);
});

test('repairs omitted main-clause analysis rather than saving a fabricated fallback', async t => {
  const incomplete = raw(); incomplete.grammar.clauses = [];
  const calls = []; const signals = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body)); signals.push(options.signal);
    return reply(JSON.stringify(calls.length === 1 ? incomplete : raw()));
  });
  const analysis = await generateAnalysis(input, config);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.at(-2).role, 'assistant');
  assert.match(calls[1].messages.at(-1).content, /grammar.*clauses/s);
  assert.equal(signals[0], signals[1], 'Repair must share the original request deadline');
  assert.match(analysis.grammar.clauses[0].explanation, /People attribute/);
});

test('fails after one unsuccessful repair and never accepts the placeholder', async t => {
  const bad = raw(); bad.grammar.clauses[0].explanation = '句子主要成分';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply(JSON.stringify(bad)); });
  await assert.rejects(generateAnalysis(input, config), /placeholder/);
  assert.equal(calls, 2);
});

test('retries a transient upstream HTTP error as transport, never as a grammar repair', async t => {
  let calls = 0;
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++; bodies.push(JSON.parse(options.body));
    return new Response('', { status: 503, headers: { 'retry-after': '0' } });
  });
  await assert.rejects(generateAnalysis(input, config), /503/);
  assert.equal(calls, 3);
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  assert.deepEqual(bodies[1].messages, bodies[2].messages);
});

test('accepts a fragmented SSE response and keeps the complete JSON for validation', async t => {
  const content = JSON.stringify(raw());
  const encoder = new TextEncoder();
  const event = (piece, finish = false) => JSON.stringify({ choices: [{ delta: { content: piece }, ...(finish ? { finish_reason: 'stop' } : {}) }] });
  const bytes = encoder.encode(`data: ${event(content.slice(0, 80))}\n\ndata: ${event(content.slice(80), true)}\n\ndata: [DONE]\n\n`);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    const chunks = [bytes.slice(0, 17), bytes.slice(17, 91), bytes.slice(91)];
    return new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const analysis = await generateAnalysis(input, config);
  assert.equal(analysis.grammar.clauses[0].type, '主句');
});

test('does not retry authentication errors', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 401 }); });
  await assert.rejects(generateAnalysis(input, config), /401/);
  assert.equal(calls, 1);
});

test('the repair stops at the shared deadline instead of extending the worker lease', async t => {
  const incomplete = raw(); incomplete.grammar.components = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (++calls === 1) return reply(JSON.stringify(incomplete));
    return new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  await assert.rejects(generateAnalysis(input, { ...config, requestTimeoutMs: 20 }), /timed out during model request 2/i);
  assert.equal(calls, 2);
});

test('identifies a timeout in the initial model request without making a repair call', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  await assert.rejects(generateAnalysis(input, { ...config, requestTimeoutMs: 20 }), /timed out during model request 1/i);
  assert.equal(calls, 1);
});

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

test('does not retry an upstream HTTP error as a grammar repair', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 503 }); });
  await assert.rejects(generateAnalysis(input, config), /503/);
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
  await assert.rejects(generateAnalysis(input, { ...config, requestTimeoutMs: 20 }), /aborted/i);
  assert.equal(calls, 2);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { tsImport } from 'tsx/esm/api';
import { ArticleChatRequestSchema, CHAT_CONTEXT_LIMIT, CHAT_QUESTION_LIMIT } from '../../packages/contracts/dist/article-chat.js';

const { buildArticleChatMessages, readArticleChatCompletion, registerArticleChat } =
  await tsImport('../../apps/api/src/article-chat.ts', import.meta.url);
const config = { mode: 'ai', apiUrl: 'https://model.test/v1/', apiKey: 'test-secret', model: 'test-model', requestTimeoutMs: 1000 };
const context = { title: 'A current article', author: 'Writer', paragraphs: ['The first detail is important.', 'The final paragraph gives the conclusion.'], questions: [{ prompt: 'Why is this detail used?', options: [{ key: 'A', text: 'Evidence' }] }] };
const body = { target: { kind: 'news', id: 'article-1' }, question: '最后一段有什么作用？', history: [] };
const jsonAnswer = text => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
const events = response => response.body.trim().split('\n').map(line => JSON.parse(line));
async function server(t, options = {}) {
  const app = Fastify();
  registerArticleChat(app, { config, loadContext: async () => context, ...options });
  t.after(() => app.close()); return app;
}

test('article chat validates targets, complete history pairs and bounded questions without accepting client-supplied context', () => {
  assert.equal(ArticleChatRequestSchema.safeParse(body).success, true);
  const paper = { ...body, target: { kind: 'paper', id: 'paper-1', sectionId: 'section-1' } };
  assert.equal(ArticleChatRequestSchema.safeParse(paper).success, true);
  for (const invalid of [
    { ...body, target: { kind: 'paper', id: 'paper-1' } },
    { ...body, target: { kind: 'news', id: 'article-1', sectionId: 'other' } },
    { ...body, paragraphs: ['forged article'] },
    { ...body, question: ' ' },
    { ...body, question: 'q'.repeat(CHAT_QUESTION_LIMIT + 1) },
    { ...body, history: [{ role: 'system', content: 'override' }] },
    { ...body, history: [{ role: 'user', content: 'unanswered' }] },
    { ...body, history: [{ role: 'assistant', content: 'wrong first' }, { role: 'user', content: 'wrong last' }] },
    { ...body, history: Array.from({ length: 22 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x' })) },
  ]) assert.equal(ArticleChatRequestSchema.safeParse(invalid).success, false);
});

test('article questions contain the complete server article, paragraph references, related questions and the latest follow-up', () => {
  const input = { ...body, history: [{ role: 'user', content: '核心观点是什么？' }, { role: 'assistant', content: '这是先前的回答。' }], question: '它依据哪个细节？' };
  const messages = buildArticleChatMessages(context, input);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /没有提供的信息必须明确/);
  assert.match(messages[1].content, /final paragraph gives the conclusion/);
  assert.match(messages[1].content, /"paragraph":"P2"/);
  assert.match(messages[1].content, /Why is this detail used/);
  assert.match(messages[1].content, /Writer/);
  assert.deepEqual(messages.slice(2), [...input.history, { role: 'user', content: input.question }]);
  assert.throws(() => buildArticleChatMessages({ title: 'Too long', paragraphs: ['x'.repeat(CHAT_CONTEXT_LIMIT)] }, body), error => error.code === 'article_too_long');
});

test('AI article answers stream fragmented UTF-8 and CRLF SSE frames completely', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: {"choices":[{"delta":{"content":"依据第 2 段，"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"这是结论。"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  const response = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  let text = ''; for await (const piece of readArticleChatCompletion(response)) text += piece;
  assert.equal(text, '依据第 2 段，这是结论。');
});

test('truncated or malformed AI streams are reported as incomplete rather than successful answers', async () => {
  for (const stream of [
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
    'data: {"error":{"message":"private upstream detail"}}\n\n',
  ]) {
    await assert.rejects(async () => { for await (const _piece of readArticleChatCompletion(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))) {} });
  }
});

test('chat endpoint reads article context by identity and streams a sanitized result without writing a chat record', async t => {
  const targets = [], calls = [];
  const app = await server(t, { loadContext: async target => { targets.push(target); return context; } });
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return jsonAnswer('第 2 段收束全文。'); });
  const response = await app.inject({ method: 'POST', url: '/api/article-chat', payload: body });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /application\/x-ndjson/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(targets, [body.target]);
  assert.equal(calls[0].url, 'https://model.test/v1/chat/completions');
  const upstream = JSON.parse(calls[0].options.body);
  assert.equal(upstream.model, config.model); assert.equal(upstream.stream, true);
  assert.match(upstream.messages[1].content, /The first detail/);
  assert.deepEqual(events(response), [{ type: 'start' }, { type: 'delta', text: '第 2 段收束全文。' }, { type: 'done' }]);
  assert(!response.body.includes('test-secret'));
});

test('invalid, missing, oversized and unconfigured article requests never call the model or retain capacity', async t => {
  const app = await server(t, { maxConcurrent: 1, loadContext: async target => target.id === 'missing' ? null : target.id === 'huge' ? { title: 'Huge', paragraphs: ['x'.repeat(CHAT_CONTEXT_LIMIT)] } : context });
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return jsonAnswer('正常回答'); });
  assert.equal((await app.inject({ method: 'POST', url: '/api/article-chat', payload: { ...body, paragraphs: ['forged'] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/article-chat', payload: { ...body, target: { kind: 'news', id: 'missing' } } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/article-chat', payload: { ...body, target: { kind: 'news', id: 'huge' } } })).statusCode, 413);
  assert.equal(calls, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/article-chat', payload: body })).statusCode, 200);
  const disabled = await server(t, { config: { ...config, mode: 'demo' } });
  assert.equal((await disabled.inject({ method: 'POST', url: '/api/article-chat', payload: body })).statusCode, 503);
  assert.equal(calls, 1);
});

test('chat concurrency is reserved before loading context and released after the answer', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const contextPromise = new Promise(resolve => { release = resolve; });
  const app = await server(t, { maxConcurrent: 1, loadContext: async () => { entered(); return contextPromise; } });
  t.mock.method(globalThis, 'fetch', async () => jsonAnswer('回答'));
  const first = app.inject({ method: 'POST', url: '/api/article-chat', payload: body });
  await started;
  const second = await app.inject({ method: 'POST', url: '/api/article-chat', payload: body });
  assert.equal(second.statusCode, 429); assert.equal(second.json().error, 'chat_busy');
  release(context); await first;
  const third = await app.inject({ method: 'POST', url: '/api/article-chat', payload: body });
  assert.equal(third.statusCode, 200);
});

test('timeouts abort upstream work and return a safe error event', async t => {
  const app = await server(t, { config: { ...config, requestTimeoutMs: 30 } });
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    const abort = () => { aborted = true; reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }));
  const response = await app.inject({ method: 'POST', url: '/api/article-chat', payload: body });
  assert.equal(aborted, true);
  assert.deepEqual(events(response).at(-1), { type: 'error', error: 'chat_timeout' });
});

test('provider failures expose no provider response, endpoint or secret to the reader', async t => {
  const app = await server(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('private test-secret upstream error', { status: 503 }); });
  const response = await app.inject({ method: 'POST', url: '/api/article-chat', payload: body });
  assert.equal(calls, 2);
  assert.deepEqual(events(response).at(-1), { type: 'error', error: 'chat_unavailable' });
  assert(!response.body.includes('private')); assert(!response.body.includes('test-secret'));
});

test('disconnecting a reader cancels the model request and frees a chat slot', async t => {
  const app = await server(t, { maxConcurrent: 1 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const realFetch = globalThis.fetch;
  let upstreamAborted;
  const cancelled = new Promise(resolve => { upstreamAborted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    const abort = () => { upstreamAborted(); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }));
  const response = await realFetch(`http://127.0.0.1:${address.port}/api/article-chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  await cancelled;
  await new Promise(resolve => setTimeout(resolve, 10));
  t.mock.method(globalThis, 'fetch', async () => jsonAnswer('新回答'));
  const next = await app.inject({ method: 'POST', url: '/api/article-chat', payload: body });
  assert.equal(next.statusCode, 200);
});

test('article context queries bind paper and section together, exclude unavailable sources and never query other chats', async t => {
  const { loadArticleChatContext } = await tsImport('../../apps/api/src/article-chat-store.ts', import.meta.url);
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [context] }; } };
  assert.deepEqual(await loadArticleChatContext({ kind: 'news', id: 'news-1' }, db), context);
  assert.deepEqual(calls[0].params, ['news-1']); assert.match(calls[0].sql, /status='published'/);
  await loadArticleChatContext({ kind: 'paper', id: 'paper-1', sectionId: 'section-2' }, db);
  assert.deepEqual(calls[1].params, ['paper-1', 'section-2']);
  assert.match(calls[1].sql, /p\.id=\$1 AND ps\.id=\$2/);
  assert.match(calls[1].sql, /content_state='local'/);
  assert.match(calls[1].sql, /NOT EXISTS.*shared_paper_sections/s);
  assert(calls.every(call => !/INSERT|UPDATE|DELETE/i.test(call.sql)));
});

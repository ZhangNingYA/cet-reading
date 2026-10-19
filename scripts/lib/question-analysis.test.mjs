import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { generateQuestionAnalysis } = await tsImport('../../apps/worker/src/ai-analysis.ts', import.meta.url);
const { validateQuestionAnalysis } = await tsImport('../../packages/contracts/src/index.ts', import.meta.url);
const config = { apiUrl: 'https://model.test/v1', apiKey: 'test-only', model: 'test-model', requestTimeoutMs: 1000 };
const paragraph = 'Digital access can help fans connect to the live experience.';
const base = {
  question_type: 'reading', title: 'A passage', instructions: 'Choose the best answer.',
  paragraphs: [paragraph], prompt: 'What helps fans connect with the live experience?',
  options: [{ key: 'A', text: 'More digital access.' }, { key: 'B', text: 'Fewer races.' }],
  answer: 'A', explanation: 'The passage supports A.',
};
function result(overrides = {}) {
  return {
    questionType: 'reading', questionTranslation: '什么有助于车迷联系现场体验？', focus: '定位帮助观众接近赛事体验的措施。',
    options: [
      { key: 'A', translation: '更多数字化接触。', analysis: '原文明确说数字化接触有助于车迷联系现场体验。', correct: true },
      { key: 'B', translation: '更少的比赛。', analysis: '原文没有说减少比赛；这是无中生有。', correct: false },
    ],
    correctAnswer: 'A',
    evidence: [{ location: '第一段', excerpt: 'Digital access can help fans connect to the live experience.', explanation: 'connect to 对应题干的 connect with。' }],
    reasoning: '题干询问帮助建立现场联系的措施，原文数字化接触直接对应。', traps: ['不要把题干中的体验误当成比赛数量。'], steps: ['圈出 connect', '定位 live experience', '核对选项与原文措施'],
    ...overrides,
  };
}
function reply(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } });
}

test('uses the detailed-reading strategy and includes the article, prompt, all options and reference answer', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    request = JSON.parse(options.body);
    return reply(JSON.stringify(result()));
  });
  const traces = new Map();
  const analysis = await generateQuestionAnalysis(base, { ...config, onRequestTrace: async trace => traces.set(trace.id, trace) });
  assert.equal(traces.size, 1);
  assert.equal([...traces.values()][0].responseText, JSON.stringify(result()));
  assert.equal([...traces.values()][0].validationStatus, 'passed');
  const material = JSON.parse(request.messages.at(-1).content);
  assert.match(material.task, /仔细阅读/);
  assert.deepEqual(material.material.paragraphs, base.paragraphs);
  assert.equal(material.material.question, base.prompt);
  assert.deepEqual(material.material.options, base.options);
  assert.equal(material.material.referenceAnswer, base.answer);
  assert.equal(analysis.correctAnswer, 'A');
});

test('uses a distinct paragraph-matching strategy', async t => {
  let request;
  const matching = { ...base, question_type: 'matching', paragraphs: [`[A] ${paragraph}`, '[B] A different paragraph.'], options: [{ key: 'A', text: '段落 A' }, { key: 'B', text: '段落 B' }] };
  const matchingResult = result({ questionType: 'matching', options: [
    { key: 'A', translation: '段落 A', analysis: 'A 段含有对应信息。', correct: true },
    { key: 'B', translation: '段落 B', analysis: 'B 段没有对应信息。', correct: false },
  ] });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    request = JSON.parse(options.body);
    return reply(JSON.stringify(matchingResult));
  });
  await generateQuestionAnalysis(matching, config);
  const material = JSON.parse(request.messages.at(-1).content);
  assert.match(material.task, /段落匹配/);
  assert.match(material.task, /相近段落/);
  assert.equal(material.material.options[0].text, paragraph);
});

test('repairs an answer mismatch and accepts only the reference answer with source evidence', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return reply(JSON.stringify(calls.length === 1 ? result({ correctAnswer: 'B' }) : result()));
  });
  const analysis = await generateQuestionAnalysis(base, config);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /correctAnswer/);
  assert.equal(analysis.options.filter(option => option.correct).length, 1);
});

test('accepts source-quoted evidence when PDF paragraph whitespace differs', () => {
  const quoted = result();
  quoted.evidence[0].excerpt = 'Digital access can help fans connect to the live experience.';
  const paragraphWithLineWrap = 'Digital access can help fans connect to the live\nexperience.';
  assert.doesNotThrow(() => validateQuestionAnalysis(quoted, {
    questionType: 'reading', options: base.options, answer: base.answer, paragraphs: [paragraphWithLineWrap],
  }));
});

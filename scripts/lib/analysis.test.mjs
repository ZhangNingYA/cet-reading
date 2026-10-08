import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalysis, validateAnalysis } from '@cet-reading/contracts';
import { readConfig } from '@cet-reading/contracts/config';
import { source, tokens, raw } from './fixtures/analysis.mjs';
const word = {
  kind: 'word', expression: 'attribute', meaning: '把……归因于', usage: '此处用作及物动词。',
  ranges: [{ tokenStart: 1, tokenEnd: 2 }],
};
const phrase = {
  kind: 'phrase', expression: 'attribute … to …', meaning: '把……归因于……', usage: 'attribute A to B。',
  ranges: [{ tokenStart: 1, tokenEnd: 2 }, { tokenStart: 3, tokenEnd: 4 }],
};

test('supports both selected words and discontinuous collocations tied to source tokens', () => {
  const analysis = buildAnalysis(source, raw([word, phrase]));
  assert.deepEqual(analysis.vocabulary, [word, phrase]);
  assert.deepEqual(validateAnalysis(source, analysis), analysis);
});

test('accepts no key vocabulary and reads old cached analyses without the new field', () => {
  const analysis = buildAnalysis(source, raw());
  assert.deepEqual(analysis.vocabulary, []);
  const { vocabulary, ...legacy } = analysis;
  assert.deepEqual(validateAnalysis(source, legacy), legacy);
  const incomplete = raw();
  delete incomplete.vocabulary;
  assert.throws(() => buildAnalysis(source, incomplete), /vocabulary/);
});

test('rejects fabricated token positions, overlapping ranges and mislabeled words/phrases', () => {
  for (const invalid of [
    { ...phrase, ranges: [{ tokenStart: 1, tokenEnd: 100 }] },
    { ...phrase, ranges: [{ tokenStart: 3, tokenEnd: 2 }] },
    { ...phrase, ranges: [{ tokenStart: 1, tokenEnd: 4 }, { tokenStart: 3, tokenEnd: 4 }] },
    { ...phrase, ranges: [{ tokenStart: 1, tokenEnd: 2 }] },
    { ...word, ranges: [{ tokenStart: 1, tokenEnd: 4 }] },
  ]) {
    assert.throws(() => buildAnalysis(source, raw([invalid])), /Vocabulary/);
    const cached = { ...buildAnalysis(source, raw()), vocabulary: [invalid] };
    assert.throws(() => validateAnalysis(source, cached), /Vocabulary/);
  }
});

test('rejects an empty token range used for an implied grammar component', () => {
  const analysis = raw([word]);
  analysis.grammar.components = [{ role: 'subject', tokenStart: 0, tokenEnd: 0, explanation: '省略的主语。' }];
  assert.throws(() => buildAnalysis(source, analysis), /tokenEnd/);
});

test('requires actual grammar analysis instead of silently inventing a main clause or predicate', () => {
  for (const field of ['clauses', 'components']) {
    const incomplete = raw();
    incomplete.grammar[field] = [];
    assert.throws(() => buildAnalysis(source, incomplete), new RegExp(field));
  }
});

test('rejects generic grammar explanations in both new answers and old cached results', () => {
  for (const [field, explanation] of [
    ['clauses', '句子主要成分'], ['clauses', ' 句子主要成分。 '],
    ['components', '句子主干'], ['components', '主语部分'], ['components', '作用'],
  ]) {
    const answer = raw(); answer.grammar[field][0].explanation = explanation;
    assert.throws(() => buildAnalysis(source, answer), /placeholder/);
    const cached = buildAnalysis(source, raw()); cached.grammar[field][0].explanation = explanation;
    assert.throws(() => validateAnalysis(source, cached), /placeholder/);
  }
});

test('rejects grammar ranges outside the source or containing only punctuation, including cached results', () => {
  for (const range of [
    { tokenStart: 0, tokenEnd: tokens.length + 1 },
    { tokenStart: tokens.length - 1, tokenEnd: tokens.length },
    { tokenStart: 3, tokenEnd: 2 },
  ]) {
    const answer = raw(); Object.assign(answer.grammar.clauses[0], range);
    assert.throws(() => buildAnalysis(source, answer), /Grammar range/);
    const cached = buildAnalysis(source, raw()); Object.assign(cached.grammar.clauses[0], range);
    assert.throws(() => validateAnalysis(source, cached), /Grammar range/);
  }
});

test('versions grammar prompts while allowing validated results from both earlier versions', () => {
  const config = readConfig({ AI_DRY_RUN: 'true', PROMPT_VERSION: 'custom-v2' });
  assert.equal(config.promptVersion, 'custom-v2-vocabulary-v1-grammar-v2');
  assert.deepEqual(config.cachePromptVersions, [config.promptVersion, 'custom-v2-vocabulary-v1', 'custom-v2']);
});

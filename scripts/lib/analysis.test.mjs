import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalysis, tokenize, validateAnalysis } from '@cet-reading/contracts';
import { readConfig } from '@cet-reading/contracts/config';

const source = 'People attribute success to hard work.';
const tokens = tokenize(source);
function raw(vocabulary = []) {
  return {
    translation: '人们把成功归因于努力。',
    pattern: 'attribute A to B',
    grammar: {
      sentenceType: '简单句', tense: '一般现在时', voice: '主动语态',
      clauses: [], components: [],
    },
    words: tokens.filter(token => token.kind === 'word').map(token => ({
      index: token.index, lemma: token.text.toLowerCase(), pos: 'n.', contextMeaning: '语境词义',
    })),
    vocabulary,
    keyPoints: ['把某事归因于某原因。'],
  };
}
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

test('versions new prompts while retaining the configured old version for cache lookup', () => {
  const config = readConfig({ AI_DRY_RUN: 'true', PROMPT_VERSION: 'custom-v2' });
  assert.equal(config.promptVersion, 'custom-v2-vocabulary-v1');
  assert.equal(config.legacyPromptVersion, 'custom-v2');
});

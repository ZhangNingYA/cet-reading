import assert from 'node:assert/strict';
import test from 'node:test';
import { presentPaper } from '../../packages/contracts/dist/shared-reading.js';
import { readPaperSources, splitStudyParagraph } from './paper-sources.mjs';

function paperView(id) {
  const source = readPaperSources().find(({ paper }) => paper.id === id).paper;
  return {
    ...source,
    sections: source.sections.map(({ study_paragraphs, questions, ...section }) => ({
      ...section, questions: questions.map(({ answer, explanation, points, ...question }) => question),
    })),
    sentences: source.sections.flatMap(section => section.study_paragraphs.flatMap((paragraph, index) =>
      splitStudyParagraph(paragraph).map((source, sentenceIndex) => ({
        id: `${section.id}-sentence-${index + 1}-${sentenceIndex + 1}`,
        sectionId: section.id, paragraphIndex: index, sentenceIndex, source,
      })),
    )),
  };
}

test('shared March readings expose only a reference while keeping each paper’s writing and translation', () => {
  const original = paperView('cet4-2023-03-1');
  for (const id of ['cet4-2023-03-2', 'cet4-2023-03-3']) {
    const stored = paperView(id), snapshot = structuredClone(stored);
    const shown = presentPaper(stored, original);
    assert.deepEqual(stored, snapshot, 'Stored content must remain intact for existing attempts and caches');
    assert.deepEqual(shown.sections[0], stored.sections[0]);
    assert.deepEqual(shown.sections[5], stored.sections[5]);
    for (const section of shown.sections.slice(1, 5)) {
      assert.equal(section.instructions, '');
      assert.deepEqual(section.paragraphs, []);
      assert.deepEqual(section.questions, []);
      assert.equal(section.reference.paperId, original.id);
      assert.equal(section.reference.title, original.title);
    }
    assert.deepEqual(shown.sentences, stored.sentences.filter(sentence => sentence.sectionId === stored.sections[0].id));
    assert.equal(shown.sections.flatMap(section => section.questions).length, 2);
  }
});

test('a changed reading stays visible even if the paper refers to another set', () => {
  const original = paperView('cet4-2023-03-1');
  const stored = paperView('cet4-2023-03-2');
  stored.sections[3].paragraphs[0] += ' A different passage.';
  const shown = presentPaper(stored, original);
  assert.deepEqual(shown.sections[3], stored.sections[3]);
  assert(shown.sentences.some(sentence => sentence.sectionId === stored.sections[3].id));
  stored.sections[4].questions[0].prompt = 'A different question about this passage.';
  assert.deepEqual(presentPaper(stored, original).sections[4], stored.sections[4]);
});

test('independent papers and unavailable or mismatched references retain their full contents', () => {
  const original = paperView('cet4-2023-03-1');
  const independent = paperView('cet4-2023-06-2');
  assert.strictEqual(presentPaper(independent, original), independent);
  const shared = paperView('cet4-2023-03-2');
  assert.strictEqual(presentPaper(shared, null), shared);
  assert.strictEqual(presentPaper(shared, independent), shared);
  assert.strictEqual(presentPaper(original, original), original);
});

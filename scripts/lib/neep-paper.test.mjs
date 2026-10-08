import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { ImportPaperSchema, QuestionSchema, SectionImageSchema } from '../../packages/contracts/dist/exam.js';

const paper = JSON.parse(readFileSync(new URL('../../data/papers/neep/2024-12/neep-2024-12-english-1.json', import.meta.url), 'utf8'));

test('English I retains its original 52 questions, distinct tasks and 100-point distribution', () => {
  ImportPaperSchema.parse(paper);
  assert.deepEqual(paper.sections.map(section => section.kind), ['cloze', 'reading', 'reading', 'reading', 'reading', 'matching', 'translation', 'writing', 'writing']);
  const questions = paper.sections.flatMap(section => section.questions);
  assert.deepEqual(questions.map(question => Number(question.id.split('-q-')[1])), Array.from({ length: 52 }, (_, index) => index + 1));
  assert.equal(questions.filter(question => question.type === 'choice').length, 45);
  assert.equal(questions.filter(question => question.type === 'text').length, 7);
  assert.equal(questions.reduce((sum, question) => sum + question.points, 0), 100);
  assert.equal(questions.filter(question => question.type === 'choice').reduce((sum, question) => sum + question.points, 0), 60);
  assert(paper.sections[0].questions.every(question => question.points === 0.5 && question.options.length === 4));
  assert.deepEqual(paper.sections.slice(1, 5).map(section => section.paragraphs.length), [7, 7, 8, 5]);
});

test('translation targets belong to the complete English passage and writing keeps the original picture', () => {
  const translation = paper.sections[6];
  for (const question of translation.questions) {
    assert(translation.paragraphs.some(paragraph => paragraph.includes(question.prompt.replace(/^\d+\.\s*/, ''))));
    assert.equal(question.answer, null);
  }
  assert.deepEqual(translation.study_paragraphs, translation.paragraphs);
  assert(paper.sections[5].paragraphs[2].includes('whatever artifacts find their way to public museums'));
  assert(translation.paragraphs[4].includes('herbivores—to the best food resources'));
  const [image] = paper.sections[8].images;
  assert(existsSync(new URL(`../../apps/web/public${image.src}`, import.meta.url)));
  assert(image.alt.includes('406') && image.alt.includes('532') && image.alt.includes('670'));
});

test('question values accept half points and picture sources stay within paper assets', () => {
  const question = paper.sections[0].questions[0];
  assert.equal(QuestionSchema.parse(question).points, 0.5);
  for (const points of [0, -0.5, 0.1]) assert.throws(() => QuestionSchema.parse({ ...question, points }));
  for (const src of ['https://example.com/picture.jpg', '/papers/../../secret.jpg', '/papers/picture.svg']) {
    assert.throws(() => SectionImageSchema.parse({ src, alt: '题图' }));
  }
});

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { ImportPaperSchema } from '@cet-reading/contracts';

const dataDirectory = new URL('../data/papers/', import.meta.url);
const quote = (value) => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => quote(JSON.stringify(value));
const insert = (table, columns, values, updates) =>
  `INSERT INTO ${table} (${columns.join(',')}) VALUES (${values.join(',')}) ON CONFLICT (id) DO UPDATE SET ${updates.map(column => `${column}=EXCLUDED.${column}`).join(',')};`;
const statements = ['-- Generated from data/papers/*.json; upserts preserve saved attempts and analyses.', 'BEGIN;'];
let sentenceCount = 0;
const files = readdirSync(dataDirectory).filter(name => name.endsWith('.json')).sort();

for (const file of files) {
  const paper = ImportPaperSchema.parse(JSON.parse(readFileSync(new URL(file, dataDirectory), 'utf8')));
  const paperColumns = ['id', 'exam_level', 'year', 'month', 'set_no', 'variant', 'title', 'is_demo', 'status', 'content_state', 'source_url', 'content_kind', 'description', 'reference_paper_id'];
  const paperValues = [quote(paper.id), quote(paper.exam_level), paper.year, paper.month, paper.set_no,
    quote(paper.variant), quote(paper.title), paper.is_demo ? 'TRUE' : 'FALSE', quote('published'),
    quote(paper.content_state), quote(paper.source_url), quote(paper.content_kind), quote(paper.description), quote(paper.reference_paper_id)];
  statements.push(insert('papers', paperColumns, paperValues, paperColumns.slice(1)));

  for (const [sectionIndex, section] of paper.sections.entries()) {
    statements.push(insert('paper_sections',
      ['id', 'paper_id', 'position', 'kind', 'title', 'instructions', 'paragraphs_json', 'study_paragraphs_json'],
      [quote(section.id), quote(paper.id), sectionIndex, quote(section.kind), quote(section.title), quote(section.instructions), json(section.paragraphs), json(section.study_paragraphs)],
      ['position', 'kind', 'title', 'instructions', 'paragraphs_json', 'study_paragraphs_json']));
    for (const [questionIndex, question] of section.questions.entries()) {
      statements.push(insert('questions',
        ['id', 'section_id', 'position', 'type', 'prompt', 'options_json', 'answer_text', 'explanation', 'points'],
        [quote(question.id), quote(section.id), questionIndex, quote(question.type), quote(question.prompt), json(question.options), quote(question.answer), quote(question.explanation), question.points],
        ['position', 'type', 'prompt', 'options_json', 'answer_text', 'explanation', 'points']));
    }
    for (const [paragraphIndex, paragraph] of section.study_paragraphs.entries()) {
      const sentences = paragraph.trim().split(/(?<=[.!?])\s+(?=[A-Z\["“])/u);
      for (const [sentenceIndex, source] of sentences.entries()) {
        const id = `${section.id}-sentence-${paragraphIndex + 1}-${sentenceIndex + 1}`;
        statements.push(insert('sentences',
          ['id', 'paper_id', 'paragraph_index', 'sentence_index', 'source_text', 'section_id'],
          [quote(id), quote(paper.id), sectionIndex * 100 + paragraphIndex, sentenceIndex, quote(source), quote(section.id)],
          ['paragraph_index', 'sentence_index', 'source_text', 'section_id']));
        sentenceCount += 1;
      }
    }
  }
}
statements.push('COMMIT;');
const sql = statements.join('\n') + '\n';
for (const directory of ['init', 'migrations']) {
  const path = new URL(`../db/${directory}/006_seed_original_papers.sql`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== sql) throw new Error(`${path.pathname} is out of date; run npm run seed:generate`);
  } else writeFileSync(path, sql);
}
console.log(`Paper seed ${process.argv.includes('--check') ? 'checked' : 'generated'}: ${files.length} papers, ${sentenceCount} study sentences.`);

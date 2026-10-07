import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const paperDirectory = fileURLToPath(new URL('../../data/papers/', import.meta.url));

export function readPaperSources(directory = paperDirectory) {
  const paths = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(child);
    }
  }
  visit(directory);
  if (!paths.length) throw new Error('No paper JSON files found in data/papers');

  const identifiers = { paper: new Map(), section: new Map(), question: new Map() };
  return paths.sort().map(path => {
    const file = relative(directory, path);
    const paper = JSON.parse(readFileSync(path, 'utf8'));
    const records = [
      ['paper', paper.id],
      ...(paper.sections ?? []).flatMap(section => [
        ['section', section.id],
        ...(section.questions ?? []).map(question => ['question', question.id]),
      ]),
    ];
    for (const [kind, id] of records) {
      const previous = identifiers[kind].get(id);
      if (previous) throw new Error(`Duplicate ${kind} ID ${id} in ${previous} and ${file}`);
      identifiers[kind].set(id, file);
    }
    return { file, paper };
  });
}

export function splitStudyParagraph(paragraph) {
  // A quote starts a sentence only when text follows it; a closing quote stays with its sentence.
  return paragraph.trim().split(/(?<=[.!?])\s+(?=[A-Z\[]|["“]+[A-Za-z])|(?<=[.!?]["”])\s+(?=[A-Z\[]|["“]+[A-Za-z])/u);
}

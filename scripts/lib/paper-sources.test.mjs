import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { readPaperSources } from './paper-sources.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cet-paper-sources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writePaper(directory, file, paper) {
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(paper));
}

test('discovers multiple exam folders in a stable order and ignores other files', t => {
  const directory = fixture(t);
  writePaper(directory, 'cet6/2027-06/paper.json', { id: 'cet6-new', sections: [] });
  writePaper(directory, 'cet4/2026-06/paper.json', { id: 'cet4-old', sections: [] });
  writeFileSync(join(directory, 'README.md'), 'Paper data');
  writeFileSync(join(directory, 'cet4/2026-06/source.pdf'), 'not JSON');
  assert.deepEqual(readPaperSources(directory).map(({ paper }) => paper.id), ['cet4-old', 'cet6-new']);
});

test('rejects duplicate IDs before conflicting data can be written to the database', t => {
  for (const kind of ['paper', 'section', 'question']) {
    const directory = fixture(t);
    const paper = number => ({
      id: kind === 'paper' ? 'duplicate' : `paper-${number}`,
      sections: [{
        id: kind === 'section' ? 'duplicate' : `section-${number}`,
        questions: [{ id: kind === 'question' ? 'duplicate' : `question-${number}` }],
      }],
    });
    writePaper(directory, 'cet4/2026-06/first.json', paper(1));
    writePaper(directory, 'cet4/2026-06/second.json', paper(2));
    assert.throws(() => readPaperSources(directory), new RegExp(`Duplicate ${kind} ID duplicate`));
  }
});

test('rejects an empty paper directory', t => {
  assert.throws(() => readPaperSources(fixture(t)), /No paper JSON files/);
});

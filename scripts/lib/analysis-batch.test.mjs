import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { loadPaperSentences, parseOptions } = await tsImport('../../apps/worker/src/analyze-paper.ts', import.meta.url);

test('parses a resumable batch target and safe options', () => {
  assert.deepEqual(parseOptions(['--paper', 'cet4-2023-12-3', '--dry-run', '--wait-timeout-seconds', '900', '--concurrency', '1']), {
    paperId: 'cet4-2023-12-3', dryRun: true, waitTimeoutSeconds: 900, concurrency: 1,
  });
  assert.deepEqual(parseOptions(['cet6-2024-06-1']), {
    paperId: 'cet6-2024-06-1', dryRun: false, waitTimeoutSeconds: 300, concurrency: 2,
  });
  assert.equal(parseOptions(['--help']), null);
  assert.deepEqual(parseOptions([]), { paperId: undefined, dryRun: false, waitTimeoutSeconds: 300, concurrency: 2 });
});

test('rejects ambiguous targets, unknown options and unsafe wait bounds', () => {
  assert.throws(() => parseOptions(['paper-a', 'paper-b']), /exactly one paper/);
  assert.throws(() => parseOptions(['--paper']), /needs a published paper ID/);
  assert.throws(() => parseOptions(['paper-a', '--unknown']), /Unknown option/);
  assert.throws(() => parseOptions(['paper-a', '--wait-timeout-seconds', '10']), /30 to 3600/);
  assert.throws(() => parseOptions(['paper-a', '--concurrency', '3']), /1 to 2/);
});

test('manual batch plans exclude sections hidden as shared readings', async () => {
  let statement = '';
  const pool = {
    async query(sql) {
      statement = String(sql);
      return { rows: [] };
    },
  };
  assert.deepEqual(await loadPaperSentences(pool, 'paper-1'), []);
  assert.match(statement, /FROM shared_paper_sections shared/);
  assert.match(statement, /shared\.section_id = s\.section_id/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { buildAnalysis } from '@cet-reading/contracts';
import { source, raw } from './fixtures/analysis.mjs';

const { getCachedAnalysis, pool } = await tsImport('../../apps/api/src/store.ts', import.meta.url);
function badCache() {
  const cached = buildAnalysis(source, raw());
  cached.grammar.clauses[0].explanation = '句子主要成分';
  return cached;
}

test('skips placeholder caches and reuses a valid earlier result', async t => {
  const valid = buildAnalysis(source, raw());
  t.mock.method(pool, 'query', async () => ({ rows: [{ analysis_json: badCache() }, { analysis_json: valid }] }));
  assert.deepEqual(await getCachedAnalysis('sentence-1', 'source-hash', 'context-hash', source), valid);
});

test('treats only invalid cached results as a miss without deleting their history', async t => {
  let queries = 0;
  t.mock.method(pool, 'query', async sql => {
    queries++;
    assert.match(sql.trim(), /^SELECT/);
    return { rows: [{ analysis_json: badCache() }] };
  });
  assert.equal(await getCachedAnalysis('sentence-1', 'source-hash', 'context-hash', source), undefined);
  assert.equal(queries, 1);
});

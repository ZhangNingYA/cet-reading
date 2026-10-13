import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { loadPriorityCandidates, inspectPriorityCandidates, fillPriorityQueue, readPriorityTarget, ADMIN_PRIORITY } =
  await tsImport('../../packages/contracts/src/analysis-priority.ts', import.meta.url);
const { buildAnalysis, contextHash, validateAnalysis } = await tsImport('../../packages/contracts/src/index.ts', import.meta.url);
const { raw, source } = await import('./fixtures/analysis.mjs');
const config = { mode: 'ai', model: 'test-model', promptVersion: 'v2', cachePromptVersions: ['v2','v1'] };
const paragraph = 'Digital access can help fans connect to the live experience.';
const question = (id = 'q1', kind = 'reading') => ({
  id, section_id: 'section-1', question_type: kind, title: 'Passage One', instructions: 'Choose the best answer.',
  paragraphs: [paragraph], prompt: '51. What helps fans connect with the live experience?',
  options: [{ key: 'A', text: 'More digital access.' }, { key: 'B', text: 'Fewer races.' }],
  answer: 'A', explanation: 'The passage supports A.',
});
const result = {
  questionType: 'reading', questionTranslation: '什么有助于车迷联系现场体验？', focus: '定位帮助观众接近赛事体验的措施。',
  options: [
    { key: 'A', translation: '更多数字化接触。', analysis: '原文明确说数字化接触有助于车迷联系现场体验。', correct: true },
    { key: 'B', translation: '更少的比赛。', analysis: '原文没有说减少比赛。', correct: false },
  ],
  correctAnswer: 'A', evidence: [{ location: '第一段', excerpt: paragraph, explanation: 'connect to 对应题干。' }],
  reasoning: '原文数字化接触直接对应。', traps: ['不要误读体验。'], steps: ['定位原文', '核对选项'],
};
const target = { revision: 'target-1', paperId: 'paper-1', sectionId: 'section-1', type: 'question', finishedAt: null };
function mockDatabase({ questions = [question()], caches = [], sentenceCaches = [], jobs = [], active = 4, evicted = 0, selected = target, allowed = true } = {}) {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_xact_lock_shared')) return { rows: [{ allowed }] };
      if (sql.includes('FROM analysis_priority_target t')) return { rows: selected ? [selected] : [] };
      if (sql.includes('SELECT q.id,q.section_id')) return { rows: questions };
      if (sql.includes('WITH ordered')) return { rows: [] };
      if (sql.includes('FROM question_analyses')) return { rows: caches };
      if (sql.includes('FROM sentence_analyses')) return { rows: sentenceCaches };
      if (sql.includes('SELECT id,job_type')) return { rows: jobs };
      if (sql.includes('COUNT(*)::integer count')) return { rows: [{ count: active }] };
      if (sql.includes('DELETE FROM analysis_jobs')) return { rows: [], rowCount: evicted };
      return { rows: [] };
    },
    release() {},
    async connect() { return db; },
  };
  return { db, calls };
}
const runtime = async () => ({ queueCapacity: 4, backfillPaused: false });

test('paper/section targets use reader cache hashes and exclude unsupported solving tasks', async () => {
  const q = question();
  const { db, calls } = mockDatabase({ questions: [q, question('matching','matching')] });
  const candidates = await loadPriorityCandidates(db, { paperId: 'paper-1', sectionId: 'section-1' });
  assert.equal(candidates.filter(c => c.type === 'question').length, 1);
  assert.equal(candidates.filter(c => c.type === 'text').length, 4);
  const solving = candidates.find(c => c.type === 'question');
  const content = Object.fromEntries(['question_type','title','instructions','paragraphs','prompt','options','answer','explanation'].map(k => [k,q[k]]));
  assert.equal(solving.sourceHash, createHash('sha256').update(JSON.stringify(content)).digest('hex'));
  const prompt = candidates.find(c => c.type === 'text' && c.questionId === 'q1');
  assert.equal(prompt.source, 'What helps fans connect with the live experience?');
  assert.equal(prompt.sourceHash, createHash('sha256').update(JSON.stringify({ questionId: 'q1', textKey: 'prompt', source: prompt.source })).digest('hex'));
  const selection = calls.find(c => c.sql.includes('SELECT q.id,q.section_id'));
  assert.deepEqual(selection.params, ['paper-1','section-1']);
  assert.match(selection.sql, /shared\.section_id=ps\.id/);
});

test('priority targets are read in FIFO rank order and pending jobs inherit that rank', async () => {
  const initial = mockDatabase({ selected: { ...target, queuePriority: 187 } });
  await readPriorityTarget(initial.db);
  assert.match(initial.calls[0].sql, /WHERE t\.finished_at IS NULL[\s\S]*ORDER BY t\.queue_priority DESC, t\.created_at ASC/);

  const { db, calls } = mockDatabase({ selected: { ...target, queuePriority: 187 }, active: 0 });
  assert.deepEqual(await fillPriorityQueue(db,config,runtime), { active: true, queued: 1 });
  const inserted = calls.find(call => call.sql.includes('INSERT INTO analysis_jobs'));
  assert.equal(inserted.params[12], 187);
});

test('compatible valid caches are reused while stale or invalid results remain queueable', async () => {
  const initial = mockDatabase();
  const candidates = await loadPriorityCandidates(initial.db, target);
  const candidate = candidates[0];
  const { db } = mockDatabase({ caches: [
    { question_id: 'q1', content_hash: candidate.sourceHash, analysis_json: { ...result, correctAnswer: 'B' } },
    { question_id: 'q1', content_hash: candidate.sourceHash, analysis_json: result },
  ] });
  assert.equal((await inspectPriorityCandidates(db,candidates,config))[0].state,'cached');
  const stale = mockDatabase({ caches: [{ question_id: 'q1', content_hash: 'old-source', analysis_json: result }] });
  assert.equal((await inspectPriorityCandidates(stale.db,candidates,config))[0].state,'missing');
});

test('sentence priority reuses the stored context hash despite JSONB object key order', async () => {
  const context = { title:'Paper',previousSentence:null,nextSentence:null };
  const currentHash = contextHash(context);
  const candidate = {
    type:'sentence',sectionId:'section-1',sentenceId:'s1',questionId:null,textKey:null,
    source,sourceHash:'source-1',contextHash:currentHash,context,question:null,
    validate:value=>validateAnalysis(source,value),
  };
  const { db } = mockDatabase({ sentenceCaches:[{
    sentence_id:'s1',source_hash:'source-1',context_hash:currentHash,
    context_json:{nextSentence:null,title:'Paper',previousSentence:null},
    analysis_json:buildAnalysis(source,raw()),
  }] });
  assert.equal((await inspectPriorityCandidates(db,[candidate],config))[0].state,'cached');
});

test('priority admission replaces only unstarted background work and stays within capacity', async () => {
  const { db, calls } = mockDatabase({ questions: [question(),question('q2')], active: 4, evicted: 1 });
  assert.deepEqual(await fillPriorityQueue(db,config,runtime), { active: true, queued: 1 });
  const inserted = calls.filter(c => c.sql.includes('INSERT INTO analysis_jobs'));
  assert.equal(inserted.length,1);
  assert.equal(inserted[0].params[0],'question');
  assert.equal(inserted[0].params[12],ADMIN_PRIORITY);
  assert.match(calls.find(c => c.sql.includes('DELETE FROM analysis_jobs')).sql,/status='pending' AND priority<=1 AND attempts=0/);
  assert.ok(calls.some(c => c.sql.includes('pg_advisory_xact_lock') && c.params[0] === 'analysis:ai:test-model:v2'));
});

test('a protected full queue waits without admitting extra work', async () => {
  const { db, calls } = mockDatabase({ active: 6, evicted: 2 });
  assert.deepEqual(await fillPriorityQueue(db,config,runtime), { active: true, queued: 0 });
  assert.equal(calls.some(c => c.sql.includes('INSERT INTO analysis_jobs')),false);
});

test('an existing queued task is promoted and deduplicated', async () => {
  const initial = mockDatabase();
  const [c] = await loadPriorityCandidates(initial.db,target);
  const { db, calls } = mockDatabase({ jobs: [{
    id: 'job-1', job_type: 'question', sentence_id: null, question_id: 'q1', text_key: null,
    source_hash: c.sourceHash, context_hash: c.contextHash, state: 'pending',
  }] });
  assert.deepEqual(await fillPriorityQueue(db,config,runtime), { active: true, queued: 0 });
  assert.deepEqual(calls.find(call => call.sql.includes('SET priority=GREATEST')).params,[['job-1'],ADMIN_PRIORITY]);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO analysis_jobs')),false);
});

test('a failed selected task is not endlessly regenerated and completed targets finish', async () => {
  const initial = mockDatabase();
  const [c] = await loadPriorityCandidates(initial.db,target);
  const failed = mockDatabase({ jobs: [{
    id: 'job-1', job_type: 'question', sentence_id: null, question_id: 'q1', text_key: null,
    source_hash: c.sourceHash, context_hash: c.contextHash, state: 'failed',
  }] });
  assert.deepEqual(await fillPriorityQueue(failed.db,config,runtime), { active: false, queued: 0 });
  const cached = mockDatabase({ caches: [{ question_id:'q1', content_hash:c.sourceHash, analysis_json:result }] });
  assert.deepEqual(await fillPriorityQueue(cached.db,config,runtime), { active:false, queued:0 });
  assert.ok(cached.calls.some(call => call.sql.includes('SET finished_at=NOW()')));
});

test('pause and batch locks prevent generation while retaining the selection', async () => {
  const paused = mockDatabase();
  assert.deepEqual(await fillPriorityQueue(paused.db,config,async () => ({ queueCapacity:4,backfillPaused:true })), { active:true,queued:0 });
  assert.equal(paused.calls.some(call => call.sql.includes('INSERT INTO analysis_jobs')),false);
  const blocked = mockDatabase({ allowed:false });
  assert.deepEqual(await fillPriorityQueue(blocked.db,config,runtime), { active:true,queued:0 });
  assert.ok(blocked.calls.some(call => call.sql==='ROLLBACK'));
});

test('a new selection retries older failures once, even if admission initially waits', async () => {
  const initial = mockDatabase();
  const [c] = await loadPriorityCandidates(initial.db,target);
  const oldJob = {
    id:'failed-1',job_type:'question',sentence_id:null,question_id:'q1',text_key:null,
    source_hash:c.sourceHash,context_hash:c.contextHash,state:'failed',updated_at:'2026-10-13T00:00:00Z',
  };
  const selected = { ...target, selectedAt:'2026-10-13T01:00:00Z' };
  const full = mockDatabase({ selected,jobs:[oldJob],active:4 });
  assert.deepEqual(await fillPriorityQueue(full.db,config,runtime),{active:true,queued:0});
  const free = mockDatabase({ selected,jobs:[oldJob],active:3 });
  assert.deepEqual(await fillPriorityQueue(free.db,config,runtime),{active:true,queued:1});
  assert.ok(free.calls.some(c=>c.sql.includes("status='pending',priority=$2,attempts=0")));
  const laterFailure = mockDatabase({ selected,jobs:[{...oldJob,updated_at:'2026-10-13T02:00:00Z'}],active:3 });
  assert.deepEqual(await fillPriorityQueue(laterFailure.db,config,runtime),{active:false,queued:0});
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { Pool } from 'pg';
import { buildAnalysis } from '@cet-reading/contracts';
import { source, raw } from './fixtures/analysis.mjs';

const { config } = await tsImport('../../apps/api/src/config.ts', import.meta.url);
const { listPapers, pool } = await tsImport('../../apps/api/src/store.ts', import.meta.url);
const { getAdminOverview, listAdminPapers } = await tsImport('../../apps/api/src/admin-store.ts', import.meta.url);
const { getPaperQuestionProgress } = await tsImport('../../apps/api/src/analysis-progress.ts', import.meta.url);
const { paperProgressEntries } = await tsImport('../../apps/web/src/scripts/analysis-progress.ts', import.meta.url);

function question(id, kind = 'reading') {
  return {
    paper_id: 'paper', id, question_type: kind, title: 'Reading', instructions: 'Choose the answer.',
    paragraphs: [source], prompt: `51. ${source}`,
    options: [{ key: 'A', text: source }, { key: 'B', text: source }],
    answer: 'A', explanation: 'The passage supports A.',
  };
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash = (id, textKey) => hash({ questionId: id, textKey, source });
const solvingHash = q => hash(Object.fromEntries(
  ['question_type', 'title', 'instructions', 'paragraphs', 'prompt', 'options', 'answer', 'explanation']
    .map(key => [key, q[key]]),
));
const solving = {
  questionType: 'reading', questionTranslation: '人们把成功归因于什么？', focus: '定位原文中的归因关系。',
  options: [
    { key: 'A', translation: '努力。', analysis: '原文把成功归因于努力。', correct: true },
    { key: 'B', translation: '其他因素。', analysis: '原文没有提到其他因素。', correct: false },
  ],
  correctAnswer: 'A', evidence: [{ location: '第一段', excerpt: source, explanation: 'attribute success to 对应归因关系。' }],
  reasoning: '定位原文中的 hard work 并核对选项。', traps: ['不能选择未被原文支持的因素。'], steps: ['圈出归因', '定位原文', '核对选项'],
};

function mockQuestionProgress(t, { questions, caches = [], jobs = [], fallback = () => ({ rows: [] }) }) {
  t.mock.method(Pool.prototype, 'query', async (sql, params) => {
    if (sql.includes('FROM questions q JOIN paper_sections ps')) {
      assert.match(sql, /shared\.section_id = ps\.id/);
      assert.match(sql, /NULLIF\(q.answer_text, ''\) IS NOT NULL/);
      return { rows: questions };
    }
    if (sql.includes('FROM question_analyses')) {
      assert.deepEqual(params[1], config.cachePromptVersions);
      return { rows: caches };
    }
    if (sql.includes('SELECT job_type, question_id, text_key, source_hash')) {
      assert.match(sql, /lease_expires_at > NOW\(\)/);
      return { rows: jobs };
    }
    return fallback(sql, params);
  });
}

test('counts valid compatible text and solving caches once; ignores stale and invalid results and cached jobs', async t => {
  const q = question('q1');
  const valid = buildAnalysis(source, raw());
  const invalid = { ...valid, translation: '' };
  mockQuestionProgress(t, {
    questions: [q, question('q2'), question('matching', 'matching')],
    caches: [
      { question_id: 'q1', content_hash: textHash('q1', 'prompt'), prompt_version: config.promptVersion, analysis_json: invalid },
      { question_id: 'q1', content_hash: textHash('q1', 'prompt'), prompt_version: config.cachePromptVersions[1], analysis_json: valid },
      { question_id: 'q1', content_hash: textHash('q1', 'prompt'), prompt_version: config.cachePromptVersions[2], analysis_json: valid },
      { question_id: 'q1', content_hash: textHash('q1', 'option:A'), prompt_version: config.promptVersion, analysis_json: valid },
      { question_id: 'q1', content_hash: solvingHash(q), prompt_version: config.promptVersion, analysis_json: solving },
      { question_id: 'q2', content_hash: 'stale-content', prompt_version: config.promptVersion, analysis_json: valid },
    ],
    jobs: [
      { job_type: 'text', question_id: 'q1', text_key: 'prompt', source_hash: textHash('q1', 'prompt'), progress_status: 'pending' },
      { job_type: 'text', question_id: 'q1', text_key: 'option:B', source_hash: textHash('q1', 'option:B'), progress_status: 'failed' },
      { job_type: 'text', question_id: 'q2', text_key: 'prompt', source_hash: textHash('q2', 'prompt'), progress_status: 'running' },
      { job_type: 'text', question_id: 'q2', text_key: 'option:A', source_hash: textHash('q2', 'option:A'), progress_status: 'pending' },
      { job_type: 'text', question_id: 'q2', text_key: 'option:A', source_hash: textHash('q2', 'option:A'), progress_status: 'failed' },
      { job_type: 'text', question_id: 'q2', text_key: 'option:B', source_hash: 'stale-content', progress_status: 'running' },
      { job_type: 'question', question_id: 'q2', text_key: null, source_hash: solvingHash(question('q2')), progress_status: 'pending' },
    ],
  });
  assert.deepEqual((await getPaperQuestionProgress(pool, ['paper'])).get('paper'), {
    analysis_text_total: 7, analysis_text_cached: 2, analysis_text_current_cached: 1,
    analysis_text_pending: 1, analysis_text_running: 1, analysis_text_failed: 1,
    analysis_solving_total: 2, analysis_solving_cached: 1, analysis_solving_current_cached: 1,
    analysis_solving_pending: 1, analysis_solving_running: 0, analysis_solving_failed: 0,
  });
});

test('public progress and admin retain a paper with complete articles but missing question analyses', async t => {
  mockQuestionProgress(t, {
    questions: [question('q1')],
    fallback: sql => ({ rows: sql.includes("'news'::text source_type") ? [] : [{
      id: 'paper', total: 10, cached: 10, analysis_total: 10, analysis_cached: 10,
      source_type: 'paper', source_id: 'paper', priority: 0, sort_order: 0,
    }] }),
  });
  const publicPaper = (await listPapers())[0];
  const adminPaper = (await listAdminPapers())[0];
  assert.equal(publicPaper.analysis_text_total, 3);
  assert.equal(publicPaper.analysis_solving_total, 1);
  assert.equal(adminPaper.total, 14);
  assert.equal(adminPaper.cached, 10);
  assert.equal(adminPaper.sentence_total, 10);
  assert.equal(adminPaper.analysis_text_total, publicPaper.analysis_text_total);
  assert.equal(adminPaper.analysis_solving_total, publicPaper.analysis_solving_total);
});

test('admin hides a paper only after all three kinds have reusable caches', async t => {
  const q = question('q1');
  mockQuestionProgress(t, {
    questions: [q],
    caches: [
      ...['prompt', 'option:A', 'option:B'].map(key => ({
        question_id: q.id, content_hash: textHash(q.id, key), prompt_version: config.promptVersion, analysis_json: buildAnalysis(source, raw()),
      })),
      { question_id: q.id, content_hash: solvingHash(q), prompt_version: config.promptVersion, analysis_json: solving },
    ],
    fallback: sql => ({ rows: sql.includes("'news'::text source_type") ? [] : [{ id: 'paper', total: 10, cached: 10 }] }),
  });
  assert.deepEqual(await listAdminPapers(), []);
});

test('admin overview includes type totals and safe request details without unused reporting queries', async t => {
  const created = new Date('2026-10-13T01:00:00Z');
  mockQuestionProgress(t, {
    questions: [question('q1')],
    caches: [{ question_id: 'q1', content_hash: textHash('q1', 'prompt'), prompt_version: config.cachePromptVersions[1], analysis_json: buildAnalysis(source, raw()) }],
    fallback: (sql, params) => {
      if (sql.includes('GROUP BY job_type')) return { rows: [
        { job_type: 'text', pending: 2, running: 1, failed: 3, oldest_pending: created, oldest_running: created },
        { job_type: 'question', pending: 1, running: 0, failed: 0, oldest_pending: created, oldest_running: null },
      ] };
      if (sql.includes('paper_total')) return { rows: [{ total: 10, cached: 8, current_cached: 6, paper_total: 10, news_total: 0 }] };
      if (sql.includes('SELECT j.id, j.job_type')) {
        assert.deepEqual(params.slice(3), ['text', 'pending']);
        assert.match(sql, /j\.job_type=\$4/);
        return { rows: [{
        id: 'job', job_type: 'text', text_key: 'prompt', status: 'pending', attempts: 1,
        title: 'Test paper', source_text: source, question_id: 'q1', sentence_id: null,
        error_message: 'AI request failed: private upstream URL', created_at: created,
        }] };
      }
      return { rows: [] };
    },
  });
  const result = await getAdminOverview('text', 'pending');
  assert.equal(result.queue.pending, 3);
  assert.equal(result.queue.running, 1);
  assert.equal(result.queue.byType.text.pending, 2);
  assert.equal(result.queue.byType.question.pending, 1);
  assert.equal(result.cache, undefined);
  assert.equal(result.metrics, undefined);
  assert.equal(result.workers, undefined);
  assert.equal(result.jobs[0].type, 'text');
  assert.equal(result.jobs[0].errorCode, 'service_unavailable');
  assert.equal(JSON.stringify(result).includes('private upstream'), false);
});

test('list labels show each type and its active states even without article sentences', () => {
  assert.deepEqual(paperProgressEntries({
    analysis_text_total: 5, analysis_text_cached: 2, analysis_text_pending: 1, analysis_text_running: 1, analysis_text_failed: 1,
    analysis_solving_total: 1, analysis_solving_cached: 0,
  }), ['题面精读 2/5（40.0%） · 1 条排队 · 1 条生成中 · 1 条失败', '做题精读 0/1（0.0%）']);
  assert.deepEqual(paperProgressEntries({}), []);
});

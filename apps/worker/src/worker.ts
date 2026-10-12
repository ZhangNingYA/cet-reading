import 'dotenv/config';
import { hostname } from 'node:os';
import { Pool, type PoolClient } from 'pg';
import {
  AIAnalysisSchema,
  buildAnalysis,
  tokenize,
  validateQuestionAnalysis,
  type QuestionAnalysis,
  type AIAnalysis,
} from '@cet-reading/contracts';
import { readConfig } from '@cet-reading/contracts/config';
import { generateAnalysis, generateQuestionAnalysis, type QuestionAnalysisInput } from './ai-analysis.js';
import { analysisErrorCode } from '@cet-reading/contracts/analysis-jobs';
import { runJobQueue } from './job-queue.js';
import { runBackfillScheduler } from './backfill.js';
import { isRetryableAnalysisError, retryDelaySeconds, shouldRetryAnalysis } from './retry-policy.js';
import { claimAnalysisJob, type AnalysisJob } from './claim-job.js';
import { readRuntimeSettings } from './runtime-settings.js';

const config = readConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

function demoRaw(source: string): AIAnalysis {
  const tokens = tokenize(source);
  const words = tokens.filter((token) => token.kind === 'word');
  return AIAnalysisSchema.parse({
    translation: source.startsWith('Although')
      ? '虽然这个计划成本很高，但它还是成功了。'
      : '这个结果鼓励团队继续开展研究。',
    pattern: source.startsWith('Although') ? 'Although + 让步状语从句，主句' : '主语 + 谓语 + 宾语 + 不定式补语',
    grammar: {
      sentenceType: source.startsWith('Although') ? '复合句' : '简单句',
      tense: '一般过去时',
      voice: '主动语态',
      clauses: [{ tokenStart: 0, tokenEnd: tokens.length, type: '主句', explanation: '演示结果：整句作为主句展示，接入 AI 后按原句分析。' }],
      components: [
        { tokenStart: 0, tokenEnd: Math.min(2, tokens.length), role: 'subject', explanation: '演示范围：前两个词暂作为主语展示。' },
        { tokenStart: Math.min(2, tokens.length - 1), tokenEnd: tokens.length, role: 'predicate', explanation: '演示范围：后续词暂作为谓语及补充成分展示。' },
      ],
    },
    words: words.map((word) => ({
      index: word.index,
      lemma: word.text.toLowerCase(),
      pos: '词汇',
      contextMeaning: word.text.toLowerCase() === 'although' ? '虽然，尽管' : '演示语境释义',
    })),
    vocabulary: [],
    keyPoints: ['当前为演示模式；接入真实 AI 后会替换为正式精读。'],
  });
}

function demoQuestionRaw(job: QuestionAnalysisInput): QuestionAnalysis {
  const answer = job.answer;
  return validateQuestionAnalysis({
    questionType: job.question_type,
    questionTranslation: '当前为演示模式，接入真实 AI 后生成题干翻译。',
    focus: job.question_type === 'matching' ? '定位题干与段落之间的同义信息。' : '根据原文证据定位并排除干扰项。',
    options: job.options.map(option => ({
      key: option.key,
      translation: '当前为演示模式，接入真实 AI 后生成选项翻译。',
      analysis: option.key === answer ? '参考答案选项。接入真实 AI 后补充原文证据。' : '非参考答案选项。接入真实 AI 后补充具体干扰分析。',
      correct: option.key === answer,
    })),
    correctAnswer: answer,
    evidence: [{ location: '原文', excerpt: job.paragraphs[0] ?? '暂无文章材料', explanation: '当前为演示模式，接入真实 AI 后定位具体原文证据。' }],
    reasoning: job.explanation || '当前为演示模式，接入真实 AI 后生成完整解题推理。',
    traps: ['当前为演示模式，接入真实 AI 后补充干扰项分析。'],
    steps: ['先读题干', '回到原文定位证据', '比较全部选项并确认答案'],
  }, {
    questionType: job.question_type, options: job.options, answer: job.answer, paragraphs: job.paragraphs,
  });
}

async function processJob(job: AnalysisJob, runtime: Awaited<ReturnType<typeof readRuntimeSettings>>) {
  const startedAt = Date.now();
  const client: PoolClient = await pool.connect();
  try {
    const analysis = job.job_type === 'question'
      ? (config.mode === 'demo'
        ? demoQuestionRaw(job.question_json as QuestionAnalysisInput)
        : await generateQuestionAnalysis(job.question_json as QuestionAnalysisInput, { ...config, promptOverride: runtime.promptOverride }))
      : job.job_type === 'text'
        ? (config.mode === 'demo'
          ? buildAnalysis(job.source_text, demoRaw(job.source_text))
          : await generateAnalysis({ source_text: job.source_text, context_json: job.context_json }, { ...config, promptOverride: runtime.promptOverride }))
        : (config.mode === 'demo'
        ? buildAnalysis(job.source_text, demoRaw(job.source_text))
        : await generateAnalysis(job, { ...config, promptOverride: runtime.promptOverride }));
    await client.query('BEGIN');
    const finished = await client.query(
      `UPDATE analysis_jobs SET status = 'succeeded', error_message = NULL,
       lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND attempts = $2 AND status = 'running' RETURNING id`,
      [job.id, job.attempts],
    );
    // A worker whose lease was reclaimed must not overwrite a newer result.
    if (!finished.rowCount) { await client.query('ROLLBACK'); return; }
    if (job.job_type === 'question' || job.job_type === 'text') {
      await client.query(
      `INSERT INTO question_analyses
         (question_id, content_hash, prompt_version, model, mode, analysis_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'succeeded')
       ON CONFLICT (question_id, content_hash, prompt_version, model, mode)
       DO UPDATE SET analysis_json = EXCLUDED.analysis_json, status = 'succeeded', updated_at = NOW()`,
      [job.question_id, job.source_hash, config.promptVersion, config.model, config.mode, JSON.stringify(analysis)],
      );
    } else await client.query(
      `INSERT INTO sentence_analyses
         (sentence_id, source_hash, context_hash, context_json, prompt_version,
          model, mode, analysis_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded')
       ON CONFLICT (sentence_id, source_hash, context_hash, prompt_version, model, mode)
       DO UPDATE SET analysis_json = EXCLUDED.analysis_json,
                     status = 'succeeded', updated_at = NOW()`,
      [job.sentence_id, job.source_hash, job.context_hash, JSON.stringify(job.context_json),
        config.promptVersion, config.model, config.mode, JSON.stringify(analysis)],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({
      event: 'analysis_succeeded', jobId: job.id, sentenceId: job.sentence_id, questionId: job.question_id,
      attempt: job.attempts, queueMs: startedAt - job.created_at.getTime(),
      durationMs: Date.now() - startedAt,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = analysisErrorCode(message);
    const retryable = isRetryableAnalysisError(message);
    const retrying = shouldRetryAnalysis(job.attempts, retryable, config.maxAnalysisAttempts);
    const delaySeconds = retryDelaySeconds(job.attempts);
    const finalMessage = retryable && !retrying
      ? `Transient retry limit reached after ${config.maxAnalysisAttempts} attempts: ${message}`
      : message;
    console.error(JSON.stringify({
      event: 'analysis_failed', jobId: job.id, sentenceId: job.sentence_id, questionId: job.question_id,
      attempt: job.attempts, errorCode,
      durationMs: Date.now() - startedAt,
      modelRequest: message.match(/model request (\d+)/)?.[1] ?? null,
      retrying,
      quarantined: retryable && !retrying,
    }));
    await client.query('ROLLBACK').catch(() => undefined);
    if (retrying) {
      await client.query(
        `UPDATE analysis_jobs SET status = 'pending', error_message = $2,
         lease_expires_at = NULL, finished_at = NULL,
         next_attempt_at = NOW() + ($4 * INTERVAL '1 second'), updated_at = NOW()
         WHERE id = $1 AND attempts = $3 AND status = 'running'`,
        [job.id, message, job.attempts, delaySeconds],
      );
    } else {
      await client.query(
        `UPDATE analysis_jobs SET status = 'failed', error_message = $2,
         lease_expires_at = NULL, finished_at = NOW(), next_attempt_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND attempts = $3 AND status = 'running'`,
        [job.id, finalMessage, job.attempts],
      );
    }
  } finally {
    client.release();
  }
}

async function main() {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let runtime = await readRuntimeSettings(pool, config);
  let runtimeReadAt = Date.now();
  let activeJobs = 0;
  const workerId = `${hostname()}-${process.pid}`;
  const heartbeat = async () => {
    await pool.query(
      `INSERT INTO analysis_worker_heartbeats (worker_id, hostname, pid, active_jobs, concurrency, started_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (worker_id) DO UPDATE SET active_jobs=EXCLUDED.active_jobs,
         concurrency=EXCLUDED.concurrency, last_seen_at=NOW()`,
      [workerId, hostname(), process.pid, activeJobs, runtime.workerConcurrency],
    );
  };
  await heartbeat().catch(error => process.stderr.write(`Worker heartbeat unavailable: ${error instanceof Error ? error.message : String(error)}\n`));
  const heartbeatTimer = setInterval(() => { void heartbeat().catch(error => process.stderr.write(`Worker heartbeat: ${error instanceof Error ? error.message : String(error)}\n`)); }, 5_000);
  const getConcurrency = async () => {
    if (Date.now() - runtimeReadAt < 1_500) return runtime.workerConcurrency;
    runtime = await readRuntimeSettings(pool, config);
    runtimeReadAt = Date.now();
    return runtime.workerConcurrency;
  };
  process.stdout.write(`Worker started (${config.mode}, ${config.model}, concurrency=${runtime.workerConcurrency})\n`);
  const backfillStop = new AbortController();
  const backfill = runBackfillScheduler(pool, config, backfillStop.signal);
  const processTracked = async (job: AnalysisJob) => {
    activeJobs += 1;
    try { await processJob(job, runtime); }
    finally { activeJobs -= 1; }
  };
  try {
    await runJobQueue({ claim: () => claimAnalysisJob(pool, config), process: processTracked, getConcurrency, signal: shutdown.signal });
  } finally {
    clearInterval(heartbeatTimer);
    await pool.query(`DELETE FROM analysis_worker_heartbeats WHERE worker_id = $1`, [workerId]).catch(() => undefined);
    backfillStop.abort();
    await backfill.catch(error => process.stderr.write(`Background analysis scheduler stopped: ${error instanceof Error ? error.message : String(error)}\n`));
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

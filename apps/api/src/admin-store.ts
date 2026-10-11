import { RuntimeSettingsPatchSchema, RuntimeSettingsSchema, type RuntimeSettings, type RuntimeSettingsPatch } from '@cet-reading/contracts/config';
import { config } from './config.js';
import { pool } from './store.js';
import { readRuntimeSettings } from './runtime-settings.js';

export class InvalidAdminSettingsError extends Error {
  constructor(message = 'Invalid analysis runtime settings') {
    super(message);
    this.name = 'InvalidAdminSettingsError';
  }
}

function asIso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function getAdminSettings() {
  return readRuntimeSettings(pool, config);
}

export async function updateAdminSettings(value: unknown): Promise<RuntimeSettings> {
  const patch = RuntimeSettingsPatchSchema.safeParse(value);
  if (!patch.success) throw new InvalidAdminSettingsError(patch.error.issues[0]?.message);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await readRuntimeSettings(client, config);
    const next = RuntimeSettingsSchema.safeParse({ ...current, ...patch.data } satisfies RuntimeSettingsPatch);
    if (!next.success) throw new InvalidAdminSettingsError(next.error.issues[0]?.message);
    if (next.data.queueCapacity < next.data.workerConcurrency) {
      throw new InvalidAdminSettingsError('queueCapacity must be at least workerConcurrency');
    }
    await client.query(
      `UPDATE analysis_runtime_settings
       SET worker_concurrency = $1, queue_capacity = $2,
           background_target = $3, backfill_paused = $4, updated_at = NOW()
       WHERE id = TRUE`,
      [next.data.workerConcurrency, next.data.queueCapacity,
        next.data.backgroundTarget, next.data.backfillPaused],
    );
    await client.query('NOTIFY analysis_runtime_settings');
    await client.query('COMMIT');
    return next.data;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setBackfillPaused(paused: boolean) {
  return updateAdminSettings({ backfillPaused: paused });
}

export async function getAdminOverview() {
  const settings = await getAdminSettings();
  const params = [config.mode, config.model, config.promptVersion];
  const [queue, recent, cache] = await Promise.all([
    pool.query<{
      pending: number;
      running: number;
      failed: number;
      oldest_pending: Date | null;
      oldest_running: Date | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
         COUNT(*) FILTER (WHERE status = 'running')::integer AS running,
         COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
         MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending,
         MIN(started_at) FILTER (WHERE status = 'running') AS oldest_running
       FROM analysis_jobs
       WHERE mode = $1 AND model = $2 AND prompt_version = $3`,
      params,
    ),
    pool.query<{
      success_1h: number;
      failed_1h: number;
      success_6h: number;
      failed_6h: number;
      queue_p50: number | null;
      queue_p90: number | null;
      generation_p50: number | null;
      generation_p90: number | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'succeeded' AND finished_at >= NOW() - INTERVAL '1 hour')::integer AS success_1h,
         COUNT(*) FILTER (WHERE status = 'failed' AND finished_at >= NOW() - INTERVAL '1 hour')::integer AS failed_1h,
         COUNT(*) FILTER (WHERE status = 'succeeded' AND finished_at >= NOW() - INTERVAL '6 hours')::integer AS success_6h,
         COUNT(*) FILTER (WHERE status = 'failed' AND finished_at >= NOW() - INTERVAL '6 hours')::integer AS failed_6h,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_at - created_at)))
           FILTER (WHERE status = 'succeeded' AND finished_at >= NOW() - INTERVAL '24 hours') AS queue_p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_at - created_at)))
           FILTER (WHERE status = 'succeeded' AND finished_at >= NOW() - INTERVAL '24 hours') AS queue_p90,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)))
           FILTER (WHERE status = 'succeeded' AND finished_at >= NOW() - INTERVAL '24 hours') AS generation_p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)))
           FILTER (WHERE status = 'succeeded' AND finished_at >= NOW() - INTERVAL '24 hours') AS generation_p90
       FROM analysis_jobs
       WHERE mode = $1 AND model = $2 AND prompt_version = $3
         AND finished_at IS NOT NULL`,
      params,
    ),
    pool.query<{ total: number; cached: number }>(
      `WITH ordered AS (
         SELECT s.id, s.paper_id, s.section_id, s.source_hash,
                jsonb_build_object(
                  'title', p.title,
                  'previousSentence', lag(s.source_text) OVER w,
                  'nextSentence', lead(s.source_text) OVER w
                ) AS context_json
         FROM sentences s JOIN papers p ON p.id = s.paper_id
         WHERE p.status = 'published'
         WINDOW w AS (PARTITION BY s.paper_id ORDER BY s.paragraph_index, s.sentence_index)
       ), visible AS (
         SELECT o.* FROM ordered o
         WHERE NOT EXISTS (
           SELECT 1 FROM shared_paper_sections shared
           WHERE shared.paper_id = o.paper_id AND shared.section_id = o.section_id
         )
       ), cached AS (
         SELECT COUNT(DISTINCT v.id)::integer AS cached
         FROM visible v JOIN sentence_analyses a
           ON a.sentence_id = v.id AND a.source_hash = v.source_hash
          AND a.context_json = v.context_json
          AND a.prompt_version = $1 AND a.model = $2 AND a.mode = $3
          AND a.status = 'succeeded'
       )
       SELECT (SELECT COUNT(*)::integer FROM visible) AS total,
              (SELECT cached FROM cached) AS cached`,
      params,
    ),
  ]);
  const queueRow = queue.rows[0] ?? { pending: 0, running: 0, failed: 0, oldest_pending: null, oldest_running: null };
  const recentRow = recent.rows[0] ?? {
    success_1h: 0, failed_1h: 0, success_6h: 0, failed_6h: 0,
    queue_p50: null, queue_p90: null, generation_p50: null, generation_p90: null,
  };
  const cacheRow = cache.rows[0] ?? { total: 0, cached: 0 };
  return {
    observedAt: new Date().toISOString(),
    model: config.model,
    mode: config.mode,
    promptVersion: config.promptVersion,
    settings,
    queue: {
      pending: queueRow.pending,
      running: queueRow.running,
      failed: queueRow.failed,
      active: queueRow.pending + queueRow.running,
      capacity: settings.queueCapacity,
      oldestPendingAt: asIso(queueRow.oldest_pending),
      oldestRunningAt: asIso(queueRow.oldest_running),
    },
    metrics: {
      successLastHour: recentRow.success_1h,
      failedLastHour: recentRow.failed_1h,
      successLastSixHours: recentRow.success_6h,
      failedLastSixHours: recentRow.failed_6h,
      queueP50Seconds: recentRow.queue_p50 == null ? null : Number(recentRow.queue_p50),
      queueP90Seconds: recentRow.queue_p90 == null ? null : Number(recentRow.queue_p90),
      generationP50Seconds: recentRow.generation_p50 == null ? null : Number(recentRow.generation_p50),
      generationP90Seconds: recentRow.generation_p90 == null ? null : Number(recentRow.generation_p90),
    },
    cache: {
      total: cacheRow.total,
      cached: cacheRow.cached,
      rate: cacheRow.total ? Number((cacheRow.cached * 100 / cacheRow.total).toFixed(2)) : 0,
    },
  };
}

import type { PriorityDatabase } from '@cet-reading/contracts/analysis-priority';
import { RuntimeSettingsSchema, type RuntimeConfig, type RuntimeSettings } from '@cet-reading/contracts/config';

type Queryable = PriorityDatabase;

function defaults(config: RuntimeConfig): RuntimeSettings {
  const workerConcurrency = config.workerConcurrency ?? 4;
  const configuredTarget = config.backfillTarget ?? 8;
  const queueCapacity = Math.max(workerConcurrency, Math.min(configuredTarget || 8, 32));
  return RuntimeSettingsSchema.parse({
    workerConcurrency,
    queueCapacity,
    backgroundTarget: Math.min(configuredTarget, queueCapacity),
    backfillPaused: false,
    promptOverride: '',
  });
}

export async function readRuntimeSettings(db: Queryable, config: RuntimeConfig): Promise<RuntimeSettings> {
  try {
    const result = await db.query<{
      worker_concurrency: number;
      queue_capacity: number;
      background_target: number;
      backfill_paused: boolean;
      prompt_override: string | null;
    }>(
      `SELECT worker_concurrency, queue_capacity, background_target, backfill_paused,
              COALESCE(prompt_override, '') AS prompt_override
       FROM analysis_runtime_settings WHERE id = TRUE`,
    );
    const row = result.rows[0];
    if (!row) return defaults(config);
    return RuntimeSettingsSchema.parse({
      workerConcurrency: row.worker_concurrency,
      queueCapacity: row.queue_capacity,
      backgroundTarget: row.background_target,
      backfillPaused: row.backfill_paused,
      promptOverride: row.prompt_override ?? '',
    });
  } catch (error) {
    // Keep old databases usable until the deployment migration has run.
    if (['42P01', '42703'].includes((error as { code?: string }).code ?? '')) return defaults(config);
    throw error;
  }
}

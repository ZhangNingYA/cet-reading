import {
  ADMIN_PRIORITY, fillPriorityQueue, inspectPriorityCandidates, loadPriorityCandidates,
  readPriorityTarget, summarizePriority, type PriorityType,
} from '@cet-reading/contracts/analysis-priority';
import { config } from './config.js';
import { pool } from './store.js';
import { readRuntimeSettings } from './runtime-settings.js';

export class InvalidPriorityTargetError extends Error {}

export async function getAdminPriority() {
  const target = await readPriorityTarget(pool);
  if (!target) return null;
  const states = await inspectPriorityCandidates(pool, await loadPriorityCandidates(pool, target), config);
  return { ...target, progress: summarizePriority(states) };
}

export async function listAdminSections(paperId: string) {
  const sections = await pool.query<{ id: string; title: string; kind: string }>(
    `SELECT ps.id,ps.title,ps.kind FROM paper_sections ps JOIN papers p ON p.id=ps.paper_id
     WHERE p.id=$1 AND p.status='published' AND NOT EXISTS (
       SELECT 1 FROM shared_paper_sections shared WHERE shared.paper_id=p.id AND shared.section_id=ps.id
     ) ORDER BY ps.position`, [paperId],
  );
  const states = await inspectPriorityCandidates(pool, await loadPriorityCandidates(pool, { paperId, sectionId: null }), config);
  return sections.rows.map(section => ({
    ...section,
    progress: Object.fromEntries((['sentence','text','question'] as PriorityType[]).map(type => [
      type, summarizePriority(states.filter(s => s.candidate.sectionId === section.id && s.candidate.type === type)),
    ])),
  })).filter(section => Object.values(section.progress).some(p => p.total > 0));
}

export async function setAdminPriority(value: unknown, actor = 'admin-console') {
  let target: { paperId: string; sectionId: string | null; type: PriorityType } | null = null;
  if (value !== null) {
    const input = value as { paperId?: unknown; sectionId?: unknown; type?: unknown };
    if (!input || typeof input.paperId !== 'string' || !input.paperId || input.paperId.length > 200 ||
        (input.sectionId != null && (typeof input.sectionId !== 'string' || !input.sectionId || input.sectionId.length > 250)) ||
        !['sentence','text','question'].includes(String(input.type))) {
      throw new InvalidPriorityTargetError('请选择试卷和精读类型。');
    }
    target = { paperId: input.paperId, sectionId: input.sectionId as string | null ?? null, type: input.type as PriorityType };
    if (!(await loadPriorityCandidates(pool, target)).length) {
      throw new InvalidPriorityTargetError('这部分没有可生成的精读内容。');
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`analysis:${config.mode}:${config.model}:${config.promptVersion}`]);
    const before = await readPriorityTarget(client, true);
    // Old queued work remains usable, but the newly selected part takes precedence.
    await client.query(
      `UPDATE analysis_jobs SET priority=1,updated_at=NOW()
       WHERE mode=$1 AND model=$2 AND prompt_version=$3 AND status='pending' AND priority=$4`,
      [config.mode,config.model,config.promptVersion,ADMIN_PRIORITY],
    );
    if (target) await client.query(
      `INSERT INTO analysis_priority_target (id,paper_id,section_id,job_type) VALUES (TRUE,$1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET paper_id=EXCLUDED.paper_id,section_id=EXCLUDED.section_id,
         job_type=EXCLUDED.job_type,revision=gen_random_uuid(),finished_at=NULL,updated_at=NOW()`,
      [target.paperId,target.sectionId,target.type],
    );
    else await client.query('DELETE FROM analysis_priority_target WHERE id=TRUE');
    await client.query(
      'INSERT INTO analysis_config_audit (actor,action,before_json,after_json) VALUES ($1,$2,$3::jsonb,$4::jsonb)',
      [actor,'analysis.priority_selected',JSON.stringify(before),JSON.stringify(target)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  const batch = target ? await fillPriorityQueue(pool, config, db => readRuntimeSettings(db, config)) : { queued: 0 };
  return { priority: await getAdminPriority(), queued: batch.queued };
}

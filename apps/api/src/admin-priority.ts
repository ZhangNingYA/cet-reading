import {
  ADMIN_PRIORITY, fillPriorityQueue, inspectPriorityCandidates, loadPriorityCandidates,
  readPriorityTarget, readPriorityTargets, summarizePriority, type PriorityType,
} from '@cet-reading/contracts/analysis-priority';
import { config } from './config.js';
import { pool } from './store.js';
import { readRuntimeSettings } from './runtime-settings.js';

export class InvalidPriorityTargetError extends Error {}

export async function getAdminPriority() {
  const targets = (await readPriorityTargets(pool)).filter(target => !target.finishedAt);
  return Promise.all(targets.map(async target => {
    const states = await inspectPriorityCandidates(pool, await loadPriorityCandidates(pool, target), config);
    return { ...target, progress: summarizePriority(states) };
  }));
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
    const before = await readPriorityTargets(client, true);
    if (target) {
      const existing = before.find(item => item.paperId === target.paperId && item.sectionId === target.sectionId && item.type === target.type && !item.finishedAt);
      if (!existing) {
        const activePriorities = before.filter(item => !item.finishedAt).map(item => item.queuePriority ?? ADMIN_PRIORITY);
        const nextPriority = activePriorities.length ? Math.max(2, Math.min(...activePriorities) - 1) : ADMIN_PRIORITY;
        await client.query(
          `INSERT INTO analysis_priority_target (paper_id,section_id,job_type,queue_priority)
           VALUES ($1,$2,$3,$4)`, [target.paperId,target.sectionId,target.type,nextPriority],
        );
      }
    } else {
      const jobPriorities = new Map<string, number>();
      for (const queued of before.filter(item => !item.finishedAt)) {
        const states = await inspectPriorityCandidates(client, await loadPriorityCandidates(client, queued), config);
        const queuedPriority = queued.queuePriority ?? ADMIN_PRIORITY;
        states.forEach(state => {
          if (state.jobId) jobPriorities.set(state.jobId, Math.max(jobPriorities.get(state.jobId) ?? 1, queuedPriority));
        });
      }
      const groups = new Map<number, string[]>();
      for (const [jobId, jobPriority] of jobPriorities) groups.set(jobPriority, [...(groups.get(jobPriority) ?? []), jobId]);
      for (const [jobPriority, jobIds] of groups) await client.query(
        `UPDATE analysis_jobs SET priority=1,updated_at=NOW()
         WHERE id=ANY($1::uuid[]) AND status='pending' AND priority=$2`, [jobIds,jobPriority],
      );
      await client.query('DELETE FROM analysis_priority_target WHERE finished_at IS NULL');
    }
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

export async function removeAdminPriority(revision: string, actor = 'admin-console') {
  if (!revision || revision.length > 100) throw new InvalidPriorityTargetError('无效的排队项。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`analysis:${config.mode}:${config.model}:${config.promptVersion}`]);
    const result = await client.query<{ paperId: string; sectionId: string | null; type: PriorityType; queuePriority: number }>(
      `SELECT paper_id AS "paperId",section_id AS "sectionId",job_type AS type,queue_priority AS "queuePriority"
       FROM analysis_priority_target WHERE revision=$1 AND finished_at IS NULL FOR UPDATE`, [revision],
    );
    const target = result.rows[0];
    if (target) {
      const candidates = await loadPriorityCandidates(client, target);
      const states = await inspectPriorityCandidates(client, candidates, config);
      const jobs = states.flatMap(state => state.jobId ? [state.jobId] : []);
      await client.query('DELETE FROM analysis_priority_target WHERE revision=$1', [revision]);
      const replacement = new Map<string, number>();
      for (const queued of (await readPriorityTargets(client)).filter(item => !item.finishedAt)) {
        const queuedStates = await inspectPriorityCandidates(client, await loadPriorityCandidates(client, queued), config);
        for (const state of queuedStates) if (state.jobId) {
          replacement.set(state.jobId, Math.max(replacement.get(state.jobId) ?? 1, queued.queuePriority ?? ADMIN_PRIORITY));
        }
      }
      for (const jobId of jobs) await client.query(
        `UPDATE analysis_jobs SET priority=$2,updated_at=NOW()
         WHERE id=$1 AND status='pending' AND priority=$3`,
        [jobId, replacement.get(jobId) ?? 1, target.queuePriority],
      );
    }
    await client.query(
      'INSERT INTO analysis_config_audit (actor,action,before_json,after_json) VALUES ($1,$2,$3::jsonb,$4::jsonb)',
      [actor,'analysis.priority_removed',JSON.stringify(target ?? null),'null'],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  const batch = await fillPriorityQueue(pool, config, db => readRuntimeSettings(db, config));
  return { priority: await getAdminPriority(), queued: batch.queued };
}

import { z } from 'zod';

export const NEWS_HOURS = [8, 11, 14, 17] as const;
export const NEWS_TIMEZONE = 'Asia/Shanghai';
export const NEWS_ARTICLES_PER_SLOT = 1;
// Bump when the candidate policy or history pool changes and an unfinished
// previous-day batch should receive one bounded supplement pass.
export const NEWS_RULE_VERSION = 'agent-topics-v3';
export const NEWS_CATEGORIES = ['agent_current', 'agent_history', 'general_realtime'] as const;
export const NEWS_SLOT_ROLES = ['agent', 'general_realtime'] as const;
export type NewsCategory = typeof NEWS_CATEGORIES[number];
export type NewsSlotRole = typeof NEWS_SLOT_ROLES[number];

export function newsSlotRole(slot: Date): NewsSlotRole {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: NEWS_TIMEZONE, hour: 'numeric', hour12: false }).format(slot));
  return hour === 17 ? 'general_realtime' : 'agent';
}

export function newsCategoryLabel(category: string) {
  return category === 'agent_current' ? 'Agent 最新' : category === 'agent_history' ? '历史推荐' : category === 'general_realtime' ? '实时要闻' : '旧文章';
}
export function newsDay(now: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NEWS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function newsSlot(day: string, hour: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !NEWS_HOURS.includes(hour as 8)) throw new Error('Use a YYYY-MM-DD date and an 08/11/14/17 Shanghai slot');
  const date = new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`);
  if (Number.isNaN(date.getTime()) || newsDay(date) !== day) throw new Error('Invalid news date');
  return date;
}
export function nextNewsSlot(now: Date) {
  const day = newsDay(now);
  for (const hour of NEWS_HOURS) {
    const slot = newsSlot(day, hour);
    if (slot > now) return slot;
  }
  return newsSlot(newsDay(new Date(now.getTime() + 86400000)), 8);
}
export function timely(published: string, cutoff: Date, hours: number) {
  const age = cutoff.getTime() - new Date(published).getTime();
  return Number.isFinite(age) && age >= 0 && age <= hours * 3600000;
}
export function splitNewsParagraph(paragraph: string): string[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  return [...segmenter.segment(paragraph)].map(item => item.segment.trim()).filter(Boolean);
}
export const NewsSelectionSchema = z.object({
  selections: z.array(z.object({
    candidateId: z.string().min(1),
    kind: z.enum(['curated', 'hot']),
    category: z.enum(NEWS_CATEGORIES),
    difficulty: z.enum(['CET6', 'NEEP', 'advanced']),
    difficultyReason: z.string().min(12).max(800),
    topic: z.string().min(1).max(80),
    keywords: z.array(z.string().trim().min(1).max(40)).min(3).max(8),
    eventKey: z.string().min(3).max(160),
    eventAt: z.string().datetime().nullable(),
    evidenceIds: z.array(z.string()).max(8),
    reason: z.string().min(12).max(800),
  }).strict()).max(NEWS_ARTICLES_PER_SLOT),
  shortfall: z.string().max(2000),
}).strict();
export type NewsSelection = z.infer<typeof NewsSelectionSchema>;

export function readNewsConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = z.object({
    NEWS_ENABLED: z.enum(['true', 'false']).default('false'),
    NEWS_MODEL: z.string().default(''),
    NEWS_MAX_ROUNDS: z.coerce.number().int().min(2).max(16).default(10),
  }).parse(env);
  return { enabled: value.NEWS_ENABLED === 'true', model: value.NEWS_MODEL.trim() || env.AI_MODEL || '', maxRounds: value.NEWS_MAX_ROUNDS };
}

// Legacy feed validation remains available for historical fixtures. The running
// collector uses the ordered learning curriculum and this technical selection policy.
export { LEARNING_SELECTOR_PROMPT as NEWS_SELECTOR_PROMPT } from './learning.js';

import { pool } from './store.js';

export const READING_PROGRESS_BOARDS = ['cet4', 'cet6', 'postgraduate', 'news'] as const;
export type ReadingProgressBoard = typeof READING_PROGRESS_BOARDS[number];
export type ReadingProgressInput = {
  itemId: string;
  mode: 'intensive' | 'practice';
  sectionId?: string;
  sentenceId?: string;
  sectionTitle?: string;
  sentenceNumber?: number;
  sentencePreview?: string;
};

const examLevels: Partial<Record<ReadingProgressBoard, string>> = {
  cet4: 'CET4',
  cet6: 'CET6',
  postgraduate: 'NEEP',
};

export function isReadingProgressBoard(value: string): value is ReadingProgressBoard {
  return (READING_PROGRESS_BOARDS as readonly string[]).includes(value);
}

function optionalText(value: unknown, limit: number): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}

export function parseReadingProgressInput(board: ReadingProgressBoard, value: unknown): ReadingProgressInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.itemId !== 'string' || !body.itemId.trim() || body.itemId.length > 180 || /[\u0000-\u001f]/.test(body.itemId)) return null;
  if (body.mode !== 'intensive' && body.mode !== 'practice') return null;
  if (board === 'news' && body.mode !== 'intensive') return null;

  const sectionId = optionalText(body.sectionId, 220);
  const sentenceId = optionalText(body.sentenceId, 260);
  const sectionTitle = optionalText(body.sectionTitle, 300);
  const sentencePreview = optionalText(body.sentencePreview, 2000);
  if ([sectionId, sentenceId, sectionTitle, sentencePreview].includes(null)) return null;
  if (body.sentenceNumber !== undefined && body.sentenceNumber !== null &&
      (!Number.isInteger(body.sentenceNumber) || Number(body.sentenceNumber) < 1 || Number(body.sentenceNumber) > 10000)) return null;

  return {
    itemId: body.itemId.trim(),
    mode: body.mode,
    ...(sectionId ? { sectionId } : {}),
    ...(sentenceId ? { sentenceId } : {}),
    ...(sectionTitle ? { sectionTitle } : {}),
    ...(body.sentenceNumber ? { sentenceNumber: Number(body.sentenceNumber) } : {}),
    ...(sentencePreview ? { sentencePreview } : {}),
  };
}

async function targetExists(board: ReadingProgressBoard, itemId: string) {
  if (board === 'news') {
    const result = await pool.query('SELECT 1 FROM news_articles WHERE id = $1 AND status = \'published\'', [itemId]);
    return result.rows.length > 0;
  }
  const result = await pool.query(
    `SELECT 1 FROM papers WHERE id = $1 AND exam_level = $2 AND status = 'published' AND content_state = 'local'`,
    [itemId, examLevels[board]],
  );
  return result.rows.length > 0;
}

async function sectionExists(board: ReadingProgressBoard, itemId: string, sectionId: string) {
  if (board === 'news') return sectionId === `${itemId}-body`;
  const result = await pool.query('SELECT 1 FROM paper_sections WHERE id = $1 AND paper_id = $2', [sectionId, itemId]);
  return result.rows.length > 0;
}

const selectProgress = `board, item_id AS "itemId", mode, section_id AS "sectionId",
  sentence_id AS "sentenceId", section_title AS "sectionTitle",
  sentence_number AS "sentenceNumber", sentence_preview AS "sentencePreview", updated_at AS "updatedAt"`;

export async function getReadingProgress(board: ReadingProgressBoard) {
  const result = await pool.query(`SELECT ${selectProgress} FROM reading_progress WHERE board = $1`, [board]);
  return result.rows[0] ?? null;
}

export async function saveReadingProgress(board: ReadingProgressBoard, progress: ReadingProgressInput) {
  if (!await targetExists(board, progress.itemId)) return null;
  if (progress.sectionId && !await sectionExists(board, progress.itemId, progress.sectionId)) return null;
  const result = await pool.query(
    `INSERT INTO reading_progress (board, item_id, mode, section_id, sentence_id, section_title, sentence_number, sentence_preview)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (board) DO UPDATE SET
       item_id = EXCLUDED.item_id, mode = EXCLUDED.mode, section_id = EXCLUDED.section_id,
       sentence_id = EXCLUDED.sentence_id, section_title = EXCLUDED.section_title,
       sentence_number = EXCLUDED.sentence_number, sentence_preview = EXCLUDED.sentence_preview,
       updated_at = NOW()
     RETURNING ${selectProgress}`,
    [board, progress.itemId, progress.mode, progress.sectionId ?? null, progress.sentenceId ?? null,
      progress.sectionTitle ?? null, progress.sentenceNumber ?? null, progress.sentencePreview ?? null],
  );
  return result.rows[0] ?? null;
}

export async function deleteReadingProgress(board: ReadingProgressBoard) {
  await pool.query('DELETE FROM reading_progress WHERE board = $1', [board]);
}

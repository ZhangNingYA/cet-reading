import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import type { Readable } from 'node:stream';
import { config } from './config.js';
import { pool } from './store.js';
import { ApprovalForbiddenError, ApprovalNotFoundError, ApprovalValidationError } from './approval-store.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LINK_LIFETIME = 15 * 60;
export type MediaPurpose = 'avatar' | 'application' | 'result';
type MediaRow = {
  id: string; owner_id: string; purpose: MediaPurpose; object_key: string; thumbnail_key: string;
  content_type: string; byte_size: number; width: number; height: number; state: string;
};
export class ApprovalMediaUnavailableError extends Error {}
export class ApprovalMediaBusyError extends Error {}

export interface ApprovalBlobStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Readable | Buffer>;
  delete(key: string): Promise<void>;
}

let storage: ApprovalBlobStorage | undefined;
export function useApprovalBlobStorageForTests(value: ApprovalBlobStorage) {
  if (!/^\/approval_(account|media|friends)_test_[a-z0-9_]+$/.test(new URL(process.env.TEST_DATABASE_URL || 'http://invalid/').pathname)) {
    throw new Error('Blob test adapter requires a dedicated approval test database');
  }
  storage = value;
}

function blobStorage(): ApprovalBlobStorage {
  if (storage) return storage;
  if (!config.azureStorageConnectionString) throw new ApprovalMediaUnavailableError('图片服务暂不可用，请稍后重试。');
  const container = BlobServiceClient.fromConnectionString(config.azureStorageConnectionString, {
    retryOptions: { maxTries: 2, tryTimeoutInMs: 20000 },
  }).getContainerClient(config.azureStorageContainer);
  storage = {
    async put(key, bytes) {
      await container.getBlockBlobClient(key).uploadData(bytes, {
        blobHTTPHeaders: { blobContentType: 'image/jpeg', blobCacheControl: 'private, max-age=900' },
      });
    },
    async read(key) {
      const response = await container.getBlobClient(key).download();
      if (!response.readableStreamBody) throw new ApprovalMediaUnavailableError('图片读取失败。');
      return response.readableStreamBody as Readable;
    },
    async delete(key) { await container.getBlobClient(key).deleteIfExists(); },
  };
  return storage;
}

// Image processing is bounded for the small production API container.
sharp.cache(false);
sharp.concurrency(1);
let processing = 0;
export async function uploadApprovalMedia(ownerId: string, rawPurpose: unknown, bytes: Buffer) {
  if (!['avatar', 'application', 'result'].includes(String(rawPurpose))) throw new ApprovalValidationError('图片用途不正确。');
  const purpose = rawPurpose as MediaPurpose;
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ApprovalValidationError('照片不能超过2MB。');
  const blob = blobStorage();
  if (processing >= 1) throw new ApprovalMediaBusyError('正在处理其他照片，请稍后重试。');
  processing += 1;
  const id = randomUUID();
  const objectKey = `approval/${ownerId}/${id}/photo.jpg`;
  const thumbnailKey = `approval/${ownerId}/${id}/thumb.jpg`;
  let attemptedUpload = false;
  try {
    const quota = await pool.query('SELECT count(*)::int AS count FROM approval_media_files WHERE owner_id=$1 AND state=\'pending\' AND created_at > NOW() - INTERVAL \'24 hours\'', [ownerId]);
    if (quota.rows[0].count >= 60) throw new ApprovalValidationError('待提交照片过多，请先提交或删除已有照片。');
    let photo: { data: Buffer; info: { width: number; height: number } };
    let thumbnail: Buffer;
    try {
      const input = sharp(bytes, { limitInputPixels: 20_000_000, animated: false, failOn: 'warning' });
      const metadata = await input.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) throw new Error('unsupported');
      const edge = purpose === 'avatar' ? 512 : 1920;
      photo = await input.rotate().resize(edge, edge, { fit: purpose === 'avatar' ? 'cover' : 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 82, mozjpeg: false }).toBuffer({ resolveWithObject: true });
      thumbnail = await sharp(photo.data).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    } catch { throw new ApprovalValidationError('请选择有效的JPG、PNG或WebP照片（最多2000万像素）。'); }
    if (photo.data.length > (purpose === 'avatar' ? 262144 : MAX_IMAGE_BYTES)) throw new ApprovalValidationError('照片处理后仍过大，请换一张照片。');
    attemptedUpload = true;
    await blob.put(objectKey, photo.data);
    await blob.put(thumbnailKey, thumbnail);
    await pool.query(
      `INSERT INTO approval_media_files (id, owner_id, purpose, object_key, thumbnail_key, byte_size, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, ownerId, purpose, objectKey, thumbnailKey, photo.data.length, photo.info.width, photo.info.height],
    );
    return { id, width: photo.info.width, height: photo.info.height, byteSize: photo.data.length };
  } catch (error) {
    if (attemptedUpload) await Promise.allSettled([blob.delete(objectKey), blob.delete(thumbnailKey)]);
    if (error instanceof ApprovalValidationError) throw error;
    throw new ApprovalMediaUnavailableError('照片保存失败，请稍后重试。');
  } finally { processing -= 1; }
}

export function validateMediaIds(raw: unknown) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 9 || raw.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(raw).size !== raw.length) {
    throw new ApprovalValidationError('每组最多9张照片，照片标识不能重复。');
  }
  return raw as string[];
}

export async function bindApprovalPhotos(client: PoolClient, requestId: string, ownerId: string, purpose: 'application' | 'result', ids: string[], eventId?: string) {
  if (!ids.length) return;
  const files = await client.query<MediaRow>(
    `SELECT * FROM approval_media_files WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids],
  );
  if (files.rows.length !== ids.length || files.rows.some(row => row.owner_id !== ownerId || row.purpose !== purpose || row.state !== 'pending')) {
    throw new ApprovalValidationError('照片已失效或不属于本次提交，请重新上传。');
  }
  const count = await client.query('SELECT count(*)::int AS count FROM approval_attachments WHERE request_id=$1 AND stage=$2 AND ($3::uuid IS NULL OR event_id=$3)', [requestId, purpose, eventId || null]);
  if (count.rows[0].count + ids.length > 9) throw new ApprovalValidationError('每组最多9张照片。');
  for (const [index, id] of ids.entries()) {
    const row = files.rows.find(file => file.id === id)!;
    await client.query(
      `INSERT INTO approval_attachments (request_id, uploader_id, stage, object_key, content_type, byte_size, width, height, media_id, thumbnail_key, sort_order, event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [requestId, ownerId, purpose, row.object_key, row.content_type, row.byte_size, row.width, row.height, id, row.thumbnail_key, count.rows[0].count + index, eventId || null],
    );
  }
  await client.query('UPDATE approval_media_files SET state=\'bound\' WHERE id=ANY($1::uuid[])', [ids]);
}

export async function bindApprovalAvatar(client: PoolClient, ownerId: string, id: unknown) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new ApprovalValidationError('头像标识不正确。');
  const files = await client.query<MediaRow>('SELECT * FROM approval_media_files WHERE id=$1 FOR UPDATE', [id]);
  const file = files.rows[0];
  if (!file || file.owner_id !== ownerId || file.purpose !== 'avatar' || file.state !== 'pending') throw new ApprovalValidationError('头像已失效，请重新选择。');
  await client.query('UPDATE approval_media_files SET state=\'bound\' WHERE id=$1', [id]);
  return id;
}

function signature(id: string, userId: string, variant: string, expires: number) {
  return createHmac('sha256', config.approvalSessionSecret).update(`approval-image:v1:${id}:${userId}:${variant}:${expires}`).digest('hex');
}

function mediaUrl(id: string, userId: string, variant: 'photo' | 'thumb') {
  const expires = Math.floor(Date.now() / 1000) + LINK_LIFETIME;
  return `/api/approval/media/${id}/content?user=${userId}&variant=${variant}&expires=${expires}&signature=${signature(id, userId, variant, expires)}`;
}

export async function approvalPhotos(requestId: string, userId: string) {
  const result = await pool.query(
    `SELECT a.media_id AS id, a.stage, a.width, a.height, a.event_id FROM approval_attachments a
     JOIN approval_media_files m ON m.id=a.media_id AND m.state='bound'
     WHERE a.request_id=$1 ORDER BY a.stage, a.sort_order, a.created_at, a.id`, [requestId],
  );
  return result.rows.map(row => ({ id: row.id, stage: row.stage, eventId: row.event_id, width: row.width, height: row.height,
    url: mediaUrl(row.id, userId, 'photo'), thumbnailUrl: mediaUrl(row.id, userId, 'thumb') }));
}

export async function approvalPhotoSummaries(ids: string[], userId: string) {
  if (!ids.length) return new Map<string, { photoCount: number; thumbnailUrl: string }>();
  const rows = await pool.query(
    `SELECT DISTINCT ON (a.request_id) a.request_id, a.media_id, count(*) OVER (PARTITION BY a.request_id)::int AS count
     FROM approval_attachments a JOIN approval_media_files m ON m.id=a.media_id AND m.state='bound'
     WHERE a.request_id=ANY($1::uuid[]) ORDER BY a.request_id, CASE WHEN a.stage='application' THEN 0 ELSE 1 END, a.sort_order, a.created_at`, [ids],
  );
  return new Map(rows.rows.map(row => [row.request_id, { photoCount: row.count, thumbnailUrl: mediaUrl(row.media_id, userId, 'thumb') }]));
}

export async function readApprovalPhoto(id: string, query: Record<string, unknown>) {
  const { user, variant, expires, signature: signed } = query;
  const expiration = Number(expires);
  const now = Math.floor(Date.now() / 1000);
  if (!UUID.test(id) || typeof user !== 'string' || !UUID.test(user) || !['photo', 'thumb'].includes(String(variant)) ||
      !Number.isInteger(expiration) || expiration < now || expiration > now + LINK_LIFETIME + 30 || typeof signed !== 'string' || !/^[a-f0-9]{64}$/.test(signed)) {
    throw new ApprovalForbiddenError('图片链接已失效，请重新打开审批。');
  }
  if (!timingSafeEqual(Buffer.from(signed, 'hex'), Buffer.from(signature(id, user, String(variant), expiration), 'hex'))) throw new ApprovalForbiddenError('无权查看图片。');
  const result = await pool.query<MediaRow>(
    `SELECT m.* FROM approval_media_files m JOIN approval_attachments a ON a.media_id=m.id
     JOIN approval_requests r ON r.id=a.request_id JOIN approval_users u ON u.id=$2 AND u.status='active'
     WHERE m.id=$1 AND m.state='bound' AND (r.applicant_id=$2 OR r.executor_id=$2 OR EXISTS (
       SELECT 1 FROM approval_request_steps s WHERE s.request_id=r.id AND s.assignee_id=$2))`, [id, user],
  );
  const row = result.rows[0];
  if (!row) throw new ApprovalNotFoundError('图片不存在或无权查看。');
  try { return await blobStorage().read(variant === 'thumb' ? row.thumbnail_key : row.object_key); }
  catch { throw new ApprovalMediaUnavailableError('照片读取失败，请稍后重试。'); }
}

export async function readApprovalBlobAvatar(userId: string) {
  if (!UUID.test(userId)) return null;
  const result = await pool.query<MediaRow>(
    `SELECT m.* FROM approval_users u JOIN approval_media_files m ON m.id=u.avatar_media_id
     WHERE u.id=$1 AND u.status='active' AND m.state='bound'`, [userId],
  );
  if (!result.rows[0]) return null;
  try { return await blobStorage().read(result.rows[0].object_key); }
  catch { throw new ApprovalMediaUnavailableError('头像读取失败，请稍后重试。'); }
}

async function removeFile(row: MediaRow) {
  const blob = blobStorage();
  await Promise.all([blob.delete(row.object_key), blob.delete(row.thumbnail_key)]);
  await pool.query('DELETE FROM approval_media_files WHERE id=$1 AND state=\'deleting\'', [row.id]);
}

export async function deleteApprovalMedia(ownerId: string, id: string) {
  if (!UUID.test(id)) throw new ApprovalNotFoundError('照片不存在。');
  const result = await pool.query<MediaRow>(
    `UPDATE approval_media_files SET state='deleting' WHERE id=$1 AND owner_id=$2 AND state IN ('pending','deleting') RETURNING *`, [id, ownerId],
  );
  if (!result.rows[0]) throw new ApprovalNotFoundError('照片不存在或已提交。');
  try { await removeFile(result.rows[0]); } catch { throw new ApprovalMediaUnavailableError('照片删除失败，请重试。'); }
}

export async function cleanupApprovalMedia() {
  // Take row locks to keep cleanup and submission mutually exclusive.
  const result = await pool.query<MediaRow>(
    `WITH expired AS (SELECT m.id FROM approval_media_files m
      WHERE m.state='deleting' OR (m.state='pending' AND m.created_at < NOW() - INTERVAL '24 hours')
        OR (m.purpose='avatar' AND m.state='bound' AND m.created_at < NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (SELECT 1 FROM approval_users u WHERE u.avatar_media_id=m.id))
      ORDER BY m.created_at LIMIT 40 FOR UPDATE SKIP LOCKED)
     UPDATE approval_media_files m SET state='deleting' FROM expired e WHERE m.id=e.id RETURNING m.*`,
  );
  for (const row of result.rows) await removeFile(row);
  return result.rows.length;
}

export function approvalMediaConfigured() { return Boolean(config.azureStorageConnectionString || storage); }

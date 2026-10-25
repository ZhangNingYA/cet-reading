import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireApprovalUser } from './approval-auth.js';
import { ApprovalForbiddenError, ApprovalNotFoundError, ApprovalValidationError } from './approval-store.js';
import {
  ApprovalMediaBusyError, ApprovalMediaUnavailableError, MAX_IMAGE_BYTES,
  approvalMediaConfigured, cleanupApprovalMedia, deleteApprovalMedia, readApprovalPhoto, uploadApprovalMedia,
} from './approval-media.js';

export function mediaErrorResponse(reply: FastifyReply, error: unknown) {
  if (error instanceof ApprovalValidationError) return reply.code(400).send({ error: 'approval_invalid_image', message: error.message });
  if (error instanceof ApprovalForbiddenError) return reply.code(403).send({ error: 'approval_image_forbidden', message: error.message });
  if (error instanceof ApprovalNotFoundError) return reply.code(404).send({ error: 'approval_image_not_found', message: error.message });
  if (error instanceof ApprovalMediaBusyError) return reply.header('Retry-After', '2').code(429).send({ error: 'approval_image_busy', message: error.message });
  if (error instanceof ApprovalMediaUnavailableError) return reply.code(503).send({ error: 'approval_image_unavailable', message: error.message });
  if ((error as { code?: string }).code?.startsWith('FST_')) return reply.code(400).send({ error: 'approval_invalid_upload', message: '每次上传一张照片，大小不能超过2MB。' });
  throw error;
}

export function registerApprovalMediaRoutes(app: FastifyInstance) {
  app.register(async mediaApp => {
    await mediaApp.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1 } });
    mediaApp.post<{ Querystring: { purpose?: string } }>('/api/approval/media', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const user = await requireApprovalUser(request, reply);
      if (!user) return;
      try {
        if (!request.isMultipart()) throw new ApprovalValidationError('请上传图片文件。');
        let bytes: Buffer | undefined;
        for await (const part of request.parts()) {
          if (part.type !== 'file' || part.fieldname !== 'image') throw new ApprovalValidationError('图片字段不正确。');
          bytes = await part.toBuffer();
        }
        if (!bytes) throw new ApprovalValidationError('请选择照片。');
        return reply.code(201).send({ media: await uploadApprovalMedia(user.id, request.query.purpose, bytes) });
      } catch (error) { return mediaErrorResponse(reply, error); }
    });
    mediaApp.delete<{ Params: { id: string } }>('/api/approval/media/:id', async (request, reply) => {
      const user = await requireApprovalUser(request, reply);
      if (!user) return;
      try { await deleteApprovalMedia(user.id, request.params.id); return reply.code(204).send(); }
      catch (error) { return mediaErrorResponse(reply, error); }
    });
    // Image components cannot attach Authorization headers. This short-lived URL
    // carries a signature; every read also rechecks the viewer's participation.
    mediaApp.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/api/approval/media/:id/content', { logLevel: 'silent' }, async (request, reply) => {
      try {
        const image = await readApprovalPhoto(request.params.id, request.query);
        return reply.header('Cache-Control', 'private, max-age=300')
          .header('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(image);
      } catch (error) { return mediaErrorResponse(reply, error); }
    });
  });
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => cleanupApprovalMedia().catch(() => app.log.warn('Approval image cleanup will retry later'));
  app.addHook('onReady', async () => {
    if (!approvalMediaConfigured() || process.env.NODE_ENV === 'test') return;
    cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
    cleanupTimer.unref();
    void cleanup();
  });
  app.addHook('onClose', async () => { if (cleanupTimer) clearInterval(cleanupTimer); });
}

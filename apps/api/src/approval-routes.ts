import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { changeApprovalDeadline, registerApprovalDeadlineWorker } from './approval-deadlines.js';
import { listApprovalFriends, listApprovalFriendRequests, lookupApprovalFriend, sendApprovalFriendRequest, respondApprovalFriendRequest, updateApprovalFriend, removeApprovalFriend } from './approval-friends.js';
import { ApprovalMediaBusyError, ApprovalMediaUnavailableError, readApprovalBlobAvatar } from './approval-media.js';
import { registerApprovalMediaRoutes } from './approval-media-routes.js';
import {
  ApprovalForbiddenError,
  ApprovalNotFoundError,
  ApprovalValidationError,
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalDashboard,
  getApprovalRequest,
  getApprovalAvatar,
  listApprovalHistory,
  listApprovalPeople,
  listApprovalTemplates,
  createApprovalTemplate,
  updateApprovalTemplate,
  updateApprovalProfile,
  reviewApprovalRequest,
  submitApprovalResult,
  supplementApprovalRequest,
  upsertApprovalUser,
  type ApprovalHistoryQuery,
} from './approval-store.js';
import {
  ApprovalAuthError,
  createApprovalSession,
  exchangeWechatCode,
  requireApprovalUser,
} from './approval-auth.js';

function errorResponse(reply: { code: (status: number) => { send: (value: unknown) => unknown } }, error: unknown) {
  if (error instanceof ApprovalValidationError) return reply.code(400).send({ error: 'approval_invalid_input', message: error.message });
  if (error instanceof ApprovalNotFoundError) return reply.code(404).send({ error: 'approval_not_found', message: error.message });
  if (error instanceof ApprovalForbiddenError) return reply.code(403).send({ error: 'approval_forbidden', message: error.message });
  if (error instanceof ApprovalAuthError) return reply.code(503).send({ error: 'approval_auth_unavailable', message: error.message });
  if (error instanceof ApprovalMediaUnavailableError) return reply.code(503).send({ error: 'approval_image_unavailable', message: error.message });
  if (error instanceof ApprovalMediaBusyError) return reply.code(429).send({ error: 'approval_image_busy', message: error.message });
  throw error;
}

export function registerApprovalRoutes(app: FastifyInstance) {
  registerApprovalMediaRoutes(app);
  registerApprovalDeadlineWorker(app);
  app.post<{ Body: unknown }>('/api/approval/auth/login', async (request, reply) => {
    try {
      if (!request.body || typeof request.body !== 'object') throw new ApprovalValidationError('登录参数不正确。');
      const body = request.body as Record<string, unknown>;
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const devOpenid = typeof body.openid === 'string' ? body.openid.trim() : '';
      let identity: { openid: string; unionid: string | null };
      if (config.approvalDevAuth && devOpenid && !code) identity = { openid: devOpenid, unionid: null };
      else {
        if (!code || code.length > 512) throw new ApprovalValidationError('微信登录code不正确。');
        identity = await exchangeWechatCode(code);
      }
      const user = await upsertApprovalUser({
        ...identity,
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        avatarUrl: typeof body.avatarUrl === 'string' ? body.avatarUrl : undefined,
      });
      if (user.status !== 'active') throw new ApprovalAuthError('该用户已停用。');
      return { token: createApprovalSession(user), user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, friendCode: user.friendCode } };
    } catch (error) { return errorResponse(reply, error); }
  });

  app.get('/api/approval/me', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    return { user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, friendCode: user.friendCode } };
  });

  app.patch<{ Body: unknown }>('/api/approval/me', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return { user: await updateApprovalProfile(user.id, request.body) }; }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get<{ Params: { id: string } }>('/api/approval/avatars/:id', async (request, reply) => {
    try {
      const blobAvatar = await readApprovalBlobAvatar(request.params.id);
      if (blobAvatar) return reply.header('Cache-Control', 'public, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(blobAvatar);
      const avatar = await getApprovalAvatar(request.params.id);
      if (!avatar) return reply.code(404).send({ error: 'avatar_not_found' });
      return reply.header('Cache-Control', 'public, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff').type(avatar.content_type).send(avatar.image_bytes);
    } catch (error) { return errorResponse(reply, error); }
  });

  app.get('/api/approval/dashboard', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return await getApprovalDashboard(user.id); }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get<{ Querystring: { q?: string } }>('/api/approval/people', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return { people: await listApprovalPeople(user.id, request.query.q ?? '') }; }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get('/api/approval/friends', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply); if (!user) return;
    try { return { friends: await listApprovalFriends(user.id) }; } catch (error) { return errorResponse(reply, error); }
  });
  app.get<{ Querystring: { code?: string } }>('/api/approval/friends/lookup', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply); if (!user) return;
    try { return await lookupApprovalFriend(user.id, request.query.code); } catch (error) { return errorResponse(reply, error); }
  });
  app.get('/api/approval/friends/requests', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply); if (!user) return;
    try { return await listApprovalFriendRequests(user.id); } catch (error) { return errorResponse(reply, error); }
  });
  app.post<{ Body: unknown }>('/api/approval/friends/requests', async (request, reply) => {
    const user = await requireApprovalUser(request, reply); if (!user) return;
    try { return reply.code(201).send({ request: await sendApprovalFriendRequest(user.id, request.body) }); } catch (error) { return errorResponse(reply, error); }
  });
  app.post<{ Params: { id: string }; Body: { action?: string } }>('/api/approval/friends/requests/:id/respond', async (request, reply) => {
    const user = await requireApprovalUser(request, reply); if (!user) return;
    try { return { request: await respondApprovalFriendRequest(user.id, request.params.id, request.body?.action) }; } catch (error) { return errorResponse(reply, error); }
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/approval/friends/:id', async (request, reply) => {
    const user = await requireApprovalUser(request, reply); if (!user) return;
    try { return { friend: await updateApprovalFriend(user.id, request.params.id, request.body) }; } catch (error) { return errorResponse(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/api/approval/friends/:id/remove', async (request, reply) => {
    const user = await requireApprovalUser(request, reply); if (!user) return;
    try { await removeApprovalFriend(user.id, request.params.id); return reply.code(204).send(); } catch (error) { return errorResponse(reply, error); }
  });

  app.get<{ Querystring: { includeInactive?: string } }>('/api/approval/templates', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return { templates: await listApprovalTemplates(user.id, request.query.includeInactive === 'true') }; }
    catch (error) { return errorResponse(reply, error); }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/approval/templates/:id', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return { template: await updateApprovalTemplate(user.id, request.params.id, request.body) }; }
    catch (error) { return errorResponse(reply, error); }
  });

  app.post<{ Body: unknown }>('/api/approval/templates', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return reply.code(201).send({ template: await createApprovalTemplate(user.id, request.body) }); }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get<{ Querystring: ApprovalHistoryQuery }>('/api/approval/requests', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return await listApprovalHistory(user.id, request.query); }
    catch (error) { return errorResponse(reply, error); }
  });

  app.post<{ Body: unknown }>('/api/approval/requests', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return reply.code(201).send({ request: await createApprovalRequest(user.id, request.body) }); }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get<{ Params: { id: string } }>('/api/approval/requests/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return { request: await getApprovalRequest(request.params.id, user.id) }; }
    catch (error) { return errorResponse(reply, error); }
  });

  app.patch<{ Params: { id: string }; Body: { dueAt?: unknown } }>('/api/approval/requests/:id/deadline', async (request, reply) => {
    const user=await requireApprovalUser(request,reply);if(!user)return;
    try { await changeApprovalDeadline(request.params.id,user.id,request.body?.dueAt);return {request:await getApprovalRequest(request.params.id,user.id)}; }
    catch(error){return errorResponse(reply,error);}
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/approval/requests/:id/supplement', async (request,reply)=>{
    const user=await requireApprovalUser(request,reply);if(!user)return;
    try{return {request:await supplementApprovalRequest(request.params.id,user.id,request.body)};}
    catch(error){return errorResponse(reply,error);}
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/approval/requests/:id/decision', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try {
      const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      return { request: await decideApprovalRequest(request.params.id, user.id, body.action, body.comment) };
    } catch (error) { return errorResponse(reply, error); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/approval/requests/:id/result', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try {
      const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      return { request: await submitApprovalResult(request.params.id, user.id, body.resultBody, body.photoIds) };
    } catch (error) { return errorResponse(reply, error); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/approval/requests/:id/review', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try {
      const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      return { request: await reviewApprovalRequest(request.params.id, user.id, body.score, body.comment) };
    } catch (error) { return errorResponse(reply, error); }
  });

  return app;
}

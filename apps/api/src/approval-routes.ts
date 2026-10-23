import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import {
  ApprovalForbiddenError,
  ApprovalNotFoundError,
  ApprovalValidationError,
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalDashboard,
  getApprovalRequest,
  listApprovalPeople,
  listApprovalRequests,
  reviewApprovalRequest,
  submitApprovalResult,
  upsertApprovalUser,
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
  throw error;
}

export function registerApprovalRoutes(app: FastifyInstance) {
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
      return { token: createApprovalSession(user), user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl } };
    } catch (error) { return errorResponse(reply, error); }
  });

  app.get('/api/approval/me', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    return { user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl } };
  });

  app.get('/api/approval/dashboard', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return await getApprovalDashboard(user.id); }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get<{ Querystring: { q?: string } }>('/api/approval/people', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return { people: await listApprovalPeople(user.id, request.query.q ?? '') }; }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get<{ Querystring: { view?: string } }>('/api/approval/requests', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return { requests: await listApprovalRequests(user.id, request.query.view ?? 'all') }; }
    catch (error) { return errorResponse(reply, error); }
  });

  app.post<{ Body: unknown }>('/api/approval/requests', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return reply.code(201).send({ request: await createApprovalRequest(user.id, request.body) }); }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get<{ Params: { id: string } }>('/api/approval/requests/:id', async (request, reply) => {
    const user = await requireApprovalUser(request, reply);
    if (!user) return;
    try { return { request: await getApprovalRequest(request.params.id, user.id) }; }
    catch (error) { return errorResponse(reply, error); }
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
      return { request: await submitApprovalResult(request.params.id, user.id, body.resultBody) };
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

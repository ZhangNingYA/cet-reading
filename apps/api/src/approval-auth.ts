import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { findApprovalUserByOpenid, type ApprovalUser } from './approval-store.js';

export class ApprovalAuthError extends Error {}

type SessionPayload = {
  sub: string;
  openid: string;
  iat: number;
  exp: number;
};

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url');
}

function sign(value: string) {
  if (!config.approvalSessionSecret) throw new ApprovalAuthError('审批登录尚未配置会话密钥。');
  return base64url(createHmac('sha256', config.approvalSessionSecret).update(value).digest());
}

export function createApprovalSession(user: ApprovalUser) {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: user.id,
    openid: user.openid,
    iat: now,
    exp: now + config.approvalSessionTtlSeconds,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

function readSession(token: string): SessionPayload | null {
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1] || !config.approvalSessionSecret) return null;
  const expected = sign(pieces[0]);
  const actualBuffer = Buffer.from(pieces[1]);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8')) as SessionPayload;
    if (!payload || typeof payload.sub !== 'string' || typeof payload.openid !== 'string' || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

export async function authenticateApprovalRequest(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    const payload = readSession(authorization.slice('Bearer '.length).trim());
    if (!payload) throw new ApprovalAuthError('登录状态已失效，请重新登录。');
    const user = await findApprovalUserByOpenid(payload.openid);
    if (!user || user.id !== payload.sub || user.status !== 'active') throw new ApprovalAuthError('用户不存在或已停用。');
    return user;
  }
  if (config.approvalDevAuth) {
    const openid = request.headers['x-approval-openid'];
    if (typeof openid === 'string' && openid.trim()) {
      const user = await findApprovalUserByOpenid(openid.trim());
      if (user?.status === 'active') return user;
    }
  }
  throw new ApprovalAuthError('请先登录审批中心。');
}

export async function requireApprovalUser(request: FastifyRequest, reply: FastifyReply) {
  try { return await authenticateApprovalRequest(request); }
  catch (error) {
    const message = error instanceof ApprovalAuthError ? error.message : '请先登录审批中心。';
    reply.code(401).send({ error: 'approval_unauthorized', message });
    return null;
  }
}

export async function exchangeWechatCode(code: string) {
  if (!config.approvalWechatAppId || !config.approvalWechatAppSecret) {
    throw new ApprovalAuthError('审批登录尚未配置微信小程序凭证。');
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', config.approvalWechatAppId);
  url.searchParams.set('secret', config.approvalWechatAppSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  const response = await fetch(url);
  if (!response.ok) throw new ApprovalAuthError('微信登录服务暂时不可用。');
  const data = await response.json() as { openid?: string; unionid?: string; errcode?: number; errmsg?: string };
  if (!data.openid) throw new ApprovalAuthError(data.errmsg ? `微信登录失败：${data.errmsg}` : '微信登录失败。');
  return { openid: data.openid, unionid: data.unionid ?? null };
}

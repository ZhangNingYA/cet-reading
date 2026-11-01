import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const expectedAppId = process.argv[2] || 'wx546aacf16a7aab65';
const envPath = resolve(process.argv[3] || '.env');

function readEnv(filePath) {
  if (!existsSync(filePath)) throw new Error(`配置文件不存在：${filePath}`);
  const values = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function fail(message) {
  console.error(`审批发布配置检查失败：${message}`);
  process.exitCode = 1;
}

let env;
try {
  env = readEnv(envPath);
} catch (error) {
  fail(error.message);
  process.exit(1);
}
const problems = [];
if (!/^wx[a-z0-9]{16}$/.test(expectedAppId)) problems.push(`期望 AppID 格式不正确：${expectedAppId}`);
if (env.APPROVAL_WECHAT_APP_ID !== expectedAppId) problems.push('APPROVAL_WECHAT_APP_ID 与小程序 AppID 不一致');
if (!env.APPROVAL_WECHAT_APP_SECRET) problems.push('APPROVAL_WECHAT_APP_SECRET 未配置');
if (!env.APPROVAL_SESSION_SECRET || env.APPROVAL_SESSION_SECRET.length < 32) problems.push('APPROVAL_SESSION_SECRET 必须至少32个字符');
if (env.APPROVAL_DEV_AUTH !== 'false') problems.push('APPROVAL_DEV_AUTH 必须为 false');
if (!env.AZURE_STORAGE_CONNECTION_STRING) problems.push('AZURE_STORAGE_CONNECTION_STRING 未配置');
if (!env.AZURE_STORAGE_CONTAINER) problems.push('AZURE_STORAGE_CONTAINER 未配置');

if (problems.length) {
  for (const problem of problems) fail(problem);
  process.exit(1);
}

console.log(`审批发布配置通过：AppID=${env.APPROVAL_WECHAT_APP_ID}, storage=${env.AZURE_STORAGE_CONTAINER}, devAuth=${env.APPROVAL_DEV_AUTH}`);

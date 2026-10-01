import { z } from 'zod';

const positiveInteger = z.coerce.number().int().positive();
const EnvironmentSchema = z.object({
  DATABASE_URL: z.string().default('postgres://cet_reading:cet_reading@localhost:15432/cet_reading'),
  PORT: positiveInteger.default(3000),
  AI_DRY_RUN: z.enum(['true', 'false']).default('true'),
  AI_MODEL: z.string().default(''),
  AI_API_URL: z.string().default(''),
  AI_API_KEY: z.string().default(''),
  AI_REQUEST_TIMEOUT_MS: positiveInteger.max(90000).default(45000),
  JOB_LEASE_SECONDS: positiveInteger.default(120),
  PROMPT_VERSION: z.string().min(1).default('cet-reading-v2'),
  CORS_ORIGIN: z.string().default('http://localhost:4321,http://localhost:8081'),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvironmentSchema.parse(env);
  const mode = parsed.AI_DRY_RUN === 'true' ? 'demo' as const : 'ai' as const;
  if (mode === 'ai' && !parsed.AI_MODEL.trim()) throw new Error('AI_MODEL is required in AI mode');
  if (parsed.JOB_LEASE_SECONDS * 1000 < parsed.AI_REQUEST_TIMEOUT_MS + 15000) {
    throw new Error('Job lease must exceed the AI timeout by at least 15 seconds');
  }
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    mode,
    model: mode === 'demo' ? 'demo-fixtures-v1' : parsed.AI_MODEL,
    promptVersion: parsed.PROMPT_VERSION,
    corsOrigins: parsed.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean),
    apiUrl: parsed.AI_API_URL,
    apiKey: parsed.AI_API_KEY,
    requestTimeoutMs: parsed.AI_REQUEST_TIMEOUT_MS,
    leaseSeconds: parsed.JOB_LEASE_SECONDS,
  };
}

export type RuntimeConfig = ReturnType<typeof readConfig>;

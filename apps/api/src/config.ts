import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://cet_reading:cet_reading@localhost:5432/cet_reading',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4321',
  promptVersion: process.env.PROMPT_VERSION ?? 'cet-reading-v1',
  model: process.env.AI_MODEL ?? 'unset',
};


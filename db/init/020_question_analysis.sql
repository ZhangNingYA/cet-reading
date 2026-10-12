BEGIN;

ALTER TABLE analysis_jobs ALTER COLUMN sentence_id DROP NOT NULL;
ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'sentence';
ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS question_id TEXT REFERENCES questions(id) ON DELETE CASCADE;
ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS question_json JSONB;
ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS text_key TEXT;
ALTER TABLE analysis_jobs DROP CONSTRAINT IF EXISTS analysis_jobs_job_type_check;
ALTER TABLE analysis_jobs ADD CONSTRAINT analysis_jobs_job_type_check CHECK (job_type IN ('sentence', 'question', 'text'));
CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_question_active_key
  ON analysis_jobs (question_id, source_hash, prompt_version, model, mode)
  WHERE job_type = 'question' AND status IN ('pending', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_text_active_key
  ON analysis_jobs (question_id, text_key, source_hash, prompt_version, model, mode)
  WHERE job_type = 'text' AND status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS question_analyses (
  id BIGSERIAL PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'ai')),
  analysis_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'invalidated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (question_id, content_hash, prompt_version, model, mode)
);

COMMIT;

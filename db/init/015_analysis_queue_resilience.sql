BEGIN;

ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS analysis_jobs_queue_priority
  ON analysis_jobs (mode, model, prompt_version, status, priority DESC, next_attempt_at, created_at);

COMMIT;

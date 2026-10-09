BEGIN;

-- Interactive requests should move ahead of old/batch work, while still
-- preserving FIFO order among requests with the same priority.
ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

-- A transient provider failure returns the job to the queue instead of making
-- the user start over. The worker only claims rows whose retry time has come.
ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS analysis_jobs_queue_priority
  ON analysis_jobs (mode, model, prompt_version, status, priority DESC, next_attempt_at, created_at);

COMMIT;

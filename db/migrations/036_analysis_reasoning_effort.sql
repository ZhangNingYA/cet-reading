ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

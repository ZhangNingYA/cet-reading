BEGIN;
CREATE TABLE IF NOT EXISTS analysis_request_traces (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  worker_attempt INTEGER NOT NULL CHECK (worker_attempt > 0),
  sent_at TIMESTAMPTZ NOT NULL,
  trace_json JSONB NOT NULL CHECK (jsonb_typeof(trace_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS analysis_request_traces_job_time ON analysis_request_traces (job_id, sent_at, id);
COMMIT;

ALTER TABLE analysis_runtime_settings
  ADD COLUMN IF NOT EXISTS prompt_override TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS analysis_paper_priorities (
  paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS analysis_worker_heartbeats (
  worker_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, pid INTEGER NOT NULL,
  active_jobs INTEGER NOT NULL DEFAULT 0, concurrency INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS analysis_config_audit (
  id BIGSERIAL PRIMARY KEY, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT NOT NULL DEFAULT 'admin-console', action TEXT NOT NULL,
  before_json JSONB, after_json JSONB
);
CREATE INDEX IF NOT EXISTS analysis_config_audit_changed_at_idx ON analysis_config_audit (changed_at DESC);

BEGIN;

CREATE TABLE IF NOT EXISTS analysis_priority_target (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id=TRUE),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  section_id TEXT REFERENCES paper_sections(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('sentence','text','question')),
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

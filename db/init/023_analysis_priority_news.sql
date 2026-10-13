BEGIN;

ALTER TABLE analysis_priority_target
  DROP CONSTRAINT IF EXISTS analysis_priority_target_paper_id_fkey;
ALTER TABLE analysis_priority_target
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'paper';
ALTER TABLE analysis_priority_target
  DROP CONSTRAINT IF EXISTS analysis_priority_target_source_type_check;
ALTER TABLE analysis_priority_target
  ADD CONSTRAINT analysis_priority_target_source_type_check CHECK (source_type IN ('paper','news'));
CREATE INDEX IF NOT EXISTS analysis_priority_target_source
  ON analysis_priority_target (source_type, paper_id, finished_at);

COMMIT;

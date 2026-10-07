-- Keep completed jobs for polling/history; deduplicate only active generation.
BEGIN;
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'analysis_jobs'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (sentence_id, source_hash, context_hash, prompt_version, model, mode)'
  LOOP
    EXECUTE format('ALTER TABLE analysis_jobs DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_active_key
  ON analysis_jobs (sentence_id, source_hash, context_hash, prompt_version, model, mode)
  WHERE status IN ('pending', 'running');
COMMIT;

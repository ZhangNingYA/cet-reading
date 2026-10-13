BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='analysis_priority_target'
      AND column_name='id' AND data_type='boolean'
  ) THEN
    ALTER TABLE analysis_priority_target DROP CONSTRAINT IF EXISTS analysis_priority_target_pkey;
    ALTER TABLE analysis_priority_target DROP CONSTRAINT IF EXISTS analysis_priority_target_id_check;
    ALTER TABLE analysis_priority_target ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE analysis_priority_target ALTER COLUMN id TYPE UUID USING gen_random_uuid();
    ALTER TABLE analysis_priority_target ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE analysis_priority_target ADD PRIMARY KEY (id);
  END IF;
END $$;
ALTER TABLE analysis_priority_target ADD COLUMN IF NOT EXISTS queue_priority INTEGER NOT NULL DEFAULT 200;
ALTER TABLE analysis_priority_target ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS analysis_priority_target_queue_order
  ON analysis_priority_target (finished_at, created_at, updated_at);

COMMIT;

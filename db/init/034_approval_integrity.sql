BEGIN;

SET LOCAL lock_timeout = '5s';

-- Existing daily tasks retain their template. Disable templates instead of
-- trying to null a reference required by the daily-task CHECK constraint.
ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_template_id_fkey;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_template_id_fkey
  FOREIGN KEY (template_id) REFERENCES approval_templates(id) ON DELETE RESTRICT;

-- Composite references enforce ownership as well as record existence.
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_id_executor
  ON approval_requests (id, executor_id);
CREATE UNIQUE INDEX IF NOT EXISTS approval_events_id_request
  ON approval_events (id, request_id);

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='approval_task_scores'::regclass AND conname='approval_task_scores_request_executor_fkey') THEN
    ALTER TABLE approval_task_scores
      ADD CONSTRAINT approval_task_scores_request_executor_fkey
      FOREIGN KEY (request_id, executor_id)
      REFERENCES approval_requests(id, executor_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='approval_task_scores'::regclass AND conname='approval_task_scores_source_details_check') THEN
    ALTER TABLE approval_task_scores
      ADD CONSTRAINT approval_task_scores_source_details_check CHECK (
        (source='manual' AND reviewer_id IS NOT NULL)
        OR (source='overdue' AND score=0 AND reviewer_id IS NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='approval_attachments'::regclass AND conname='approval_attachments_event_request_fkey') THEN
    ALTER TABLE approval_attachments
      ADD CONSTRAINT approval_attachments_event_request_fkey
      FOREIGN KEY (event_id, request_id) REFERENCES approval_events(id, request_id)
      DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='approval_request_steps'::regclass AND conname='approval_steps_score_kind_check') THEN
    ALTER TABLE approval_request_steps
      ADD CONSTRAINT approval_steps_score_kind_check CHECK (
        score IS NULL OR (step_kind='review' AND status='completed')
      ) NOT VALID;
  END IF;
END
$migration$;

-- Fail atomically on inconsistent historical rows; never delete or rewrite
-- approval history to make a constraint pass.
ALTER TABLE approval_task_scores VALIDATE CONSTRAINT approval_task_scores_request_executor_fkey;
ALTER TABLE approval_task_scores VALIDATE CONSTRAINT approval_task_scores_source_details_check;
ALTER TABLE approval_attachments VALIDATE CONSTRAINT approval_attachments_event_request_fkey;
ALTER TABLE approval_request_steps VALIDATE CONSTRAINT approval_steps_score_kind_check;
ALTER TABLE approval_task_scores DROP CONSTRAINT IF EXISTS approval_task_scores_request_id_fkey;
ALTER TABLE approval_attachments DROP CONSTRAINT IF EXISTS approval_attachments_event_id_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS approval_steps_one_pending
  ON approval_request_steps (request_id) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS approval_attachments_event_position
  ON approval_attachments (event_id, sort_order) WHERE event_id IS NOT NULL;

-- The UNIQUE(request_id, position) constraint already supplies this index.
DROP INDEX IF EXISTS approval_steps_request;
CREATE INDEX IF NOT EXISTS approval_requests_applicant_history
  ON approval_requests (applicant_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS approval_requests_executor_history
  ON approval_requests (executor_id, updated_at DESC, id DESC);

-- One canonical score per task, for both daily and ad-hoc work. Use the
-- Shanghai calendar day of scoring, matching the existing dashboard.
CREATE OR REPLACE VIEW approval_daily_score_summary AS
SELECT executor_id AS user_id,
       (scored_at AT TIME ZONE 'Asia/Shanghai')::date AS score_date,
       ROUND(AVG(score))::smallint AS score,
       COUNT(*)::integer AS task_count
FROM approval_task_scores
GROUP BY executor_id, (scored_at AT TIME ZONE 'Asia/Shanghai')::date;

COMMENT ON TABLE approval_task_scores IS
  'Canonical final score per task; all statistics derive from this table.';
COMMENT ON VIEW approval_daily_score_summary IS
  'Read-only daily task-score averages by scoring date in Asia/Shanghai, including overdue zero scores.';
COMMENT ON TABLE approval_daily_scores IS
  'Legacy daily snapshots retained for compatibility and rollback. New code must not write or aggregate this table.';
COMMENT ON TABLE approval_user_avatars IS
  'Legacy binary avatars, read only by the compatibility fallback. New uploads use approval_media_files.';
COMMENT ON TABLE approval_comments IS
  'Reserved for standalone conversation. Workflow decisions use approval_request_steps and approval_events.';
COMMENT ON COLUMN approval_attachments.object_key IS
  'Immutable file metadata snapshot at binding time; approval_media_files manages storage lifecycle.';
COMMENT ON COLUMN approval_attachments.event_id IS
  'Submission batch; composite foreign key requires the event to belong to this attachment request. NULL is allowed for legacy records.';

COMMIT;


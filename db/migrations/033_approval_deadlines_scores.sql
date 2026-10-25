BEGIN;

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_status_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_status_check CHECK
  (status IN ('draft','pending_approval','rejected','needs_supplement','approved','in_progress','pending_review','completed','cancelled','expired','overdue'));
UPDATE approval_requests SET status='needs_supplement' WHERE status='rejected';
ALTER TABLE approval_events ALTER COLUMN actor_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS approval_task_scores (
  request_id UUID PRIMARY KEY REFERENCES approval_requests(id) ON DELETE CASCADE,
  executor_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE RESTRICT,
  score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  source TEXT NOT NULL CHECK (source IN ('manual','overdue')),
  reviewer_id UUID REFERENCES approval_users(id) ON DELETE RESTRICT,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_task_scores_executor ON approval_task_scores (executor_id,scored_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_open_deadlines ON approval_requests (due_at)
  WHERE status IN ('pending_approval','needs_supplement','approved','in_progress') AND due_at IS NOT NULL;

ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES approval_events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS approval_attachments_event ON approval_attachments (request_id,event_id,sort_order);
UPDATE approval_attachments a SET event_id=(SELECT e.id FROM approval_events e WHERE e.request_id=a.request_id
  AND e.event_type=CASE WHEN a.stage='application' THEN 'request.created' ELSE 'request.result_submitted' END
  ORDER BY e.created_at,e.id LIMIT 1) WHERE a.event_id IS NULL AND a.stage IN ('application','result');
UPDATE approval_events e SET payload_json=e.payload_json||jsonb_build_object('body',CASE WHEN e.event_type='request.created' THEN r.body ELSE r.result_body END)
FROM approval_requests r WHERE e.request_id=r.id AND e.event_type IN ('request.created','request.result_submitted') AND NOT(e.payload_json?'body');

INSERT INTO approval_task_scores(request_id,executor_id,score,source,reviewer_id,scored_at)
SELECT DISTINCT ON(r.id) r.id,r.executor_id,s.score,'manual',s.assignee_id,COALESCE(s.acted_at,r.reviewed_at,r.updated_at)
FROM approval_requests r JOIN approval_request_steps s ON s.request_id=r.id
WHERE r.status='completed' AND s.step_kind='review' AND s.status='completed' AND s.score IS NOT NULL
ORDER BY r.id,s.position DESC ON CONFLICT(request_id) DO NOTHING;

COMMIT;

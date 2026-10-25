BEGIN;

ALTER TABLE approval_users ADD COLUMN IF NOT EXISTS friend_code TEXT NOT NULL
  DEFAULT upper(encode(gen_random_bytes(6), 'hex')) UNIQUE CHECK (friend_code ~ '^[A-F0-9]{12}$');
ALTER TABLE approval_friendships ADD COLUMN IF NOT EXISTS remark TEXT NOT NULL DEFAULT '' CHECK (char_length(remark) <= 80);

CREATE TABLE IF NOT EXISTS approval_friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
  message TEXT NOT NULL DEFAULT '' CHECK (char_length(message) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  CHECK (requester_id <> recipient_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_friend_requests_pending_pair
  ON approval_friend_requests (LEAST(requester_id,recipient_id), GREATEST(requester_id,recipient_id)) WHERE status='pending';
CREATE INDEX IF NOT EXISTS approval_friend_requests_recipient ON approval_friend_requests (recipient_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS approval_friend_requests_requester ON approval_friend_requests (requester_id,created_at DESC);

ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS executor_id UUID REFERENCES approval_users(id) ON DELETE RESTRICT;
UPDATE approval_requests SET executor_id=applicant_id WHERE executor_id IS NULL;
ALTER TABLE approval_requests ALTER COLUMN executor_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS approval_requests_executor_status ON approval_requests (executor_id,status,updated_at DESC);

COMMIT;

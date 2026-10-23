BEGIN;

-- The approval module is intentionally separate from CET reading data. It can
-- later be exposed through authenticated API routes without changing papers,
-- sentences, or analysis jobs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS approval_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  openid TEXT NOT NULL UNIQUE,
  unionid TEXT,
  display_name TEXT NOT NULL CHECK (btrim(display_name) <> ''),
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_friendships (
  owner_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  requested_by UUID NOT NULL REFERENCES approval_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, friend_id),
  CHECK (owner_id <> friend_id)
);

CREATE TABLE IF NOT EXISTS approval_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'ad_hoc')),
  description TEXT NOT NULL DEFAULT '',
  schedule_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(schedule_json) = 'object'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID REFERENCES approval_templates(id) ON DELETE SET NULL,
  applicant_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'ad_hoc')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'rejected', 'approved', 'in_progress', 'pending_review', 'completed', 'cancelled')),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  body TEXT NOT NULL DEFAULT '',
  scheduled_for DATE,
  due_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  result_submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'daily' AND template_id IS NOT NULL AND scheduled_for IS NOT NULL)
    OR (kind = 'ad_hoc')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS approval_daily_request_once
  ON approval_requests (template_id, applicant_id, scheduled_for)
  WHERE kind = 'daily';
CREATE INDEX IF NOT EXISTS approval_requests_applicant_status
  ON approval_requests (applicant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_kind_schedule
  ON approval_requests (kind, scheduled_for, status);

CREATE TABLE IF NOT EXISTS approval_request_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position > 0),
  step_kind TEXT NOT NULL CHECK (step_kind IN ('approval', 'review')),
  assignee_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'returned', 'cancelled')),
  comment TEXT NOT NULL DEFAULT '',
  score SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  acted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, position)
);
CREATE INDEX IF NOT EXISTS approval_steps_assignee_status
  ON approval_request_steps (assignee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_steps_request
  ON approval_request_steps (request_id, position);

CREATE TABLE IF NOT EXISTS approval_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('application', 'result', 'comment')),
  object_key TEXT NOT NULL CHECK (btrim(object_key) <> ''),
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_attachments_request_stage
  ON approval_attachments (request_id, stage, created_at);

CREATE TABLE IF NOT EXISTS approval_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('application', 'approval', 'result', 'review', 'general')),
  body TEXT NOT NULL CHECK (btrim(body) <> ''),
  score SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_comments_request_time
  ON approval_comments (request_id, created_at);

CREATE TABLE IF NOT EXISTS approval_daily_scores (
  user_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE CASCADE,
  score_date DATE NOT NULL,
  score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  source_request_id UUID REFERENCES approval_requests(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, score_date)
);

CREATE TABLE IF NOT EXISTS approval_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (btrim(event_type) <> ''),
  from_status TEXT,
  to_status TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_events_request_time
  ON approval_events (request_id, created_at);

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS approval_user_avatars (
  user_id UUID PRIMARY KEY REFERENCES approval_users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  image_bytes BYTEA NOT NULL CHECK (octet_length(image_bytes) BETWEEN 1 AND 262144),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS approval_templates_owner_active_updated
  ON approval_templates (owner_id, active, updated_at DESC);

COMMIT;

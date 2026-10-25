BEGIN;

CREATE TABLE IF NOT EXISTS approval_media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES approval_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('avatar', 'application', 'result')),
  object_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg' CHECK (content_type = 'image/jpeg'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'bound', 'deleting')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_media_pending ON approval_media_files (created_at) WHERE state <> 'bound';
CREATE INDEX IF NOT EXISTS approval_media_owner ON approval_media_files (owner_id, created_at);

ALTER TABLE approval_users ADD COLUMN IF NOT EXISTS avatar_media_id UUID REFERENCES approval_media_files(id) ON DELETE SET NULL;
ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS media_id UUID UNIQUE REFERENCES approval_media_files(id) ON DELETE RESTRICT;
ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS thumbnail_key TEXT;
ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS sort_order SMALLINT NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 8);

COMMIT;

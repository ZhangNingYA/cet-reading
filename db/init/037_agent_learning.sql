BEGIN;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS learning_order INTEGER UNIQUE;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS learning_stage INTEGER CHECK (learning_stage BETWEEN 1 AND 6);
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS learning_role TEXT CHECK (learning_role IN ('concept','practice'));
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS lesson_title TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS learning_objective TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS learning_exercise TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS prerequisites JSONB NOT NULL DEFAULT '[]';
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS blocks_json JSONB NOT NULL DEFAULT '[]';
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS source_revision TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS license_text TEXT;
CREATE TABLE IF NOT EXISTS learning_state (
  id INTEGER PRIMARY KEY CHECK (id=1), curriculum_version TEXT NOT NULL,
  next_order INTEGER NOT NULL DEFAULT 1 CHECK(next_order>0), initialized_at TIMESTAMPTZ,
  last_discovered_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO learning_state(id,curriculum_version) VALUES(1,'agent-development-v1') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS learning_candidates (
  key TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL,
  planned_order INTEGER UNIQUE, stage INTEGER, role TEXT,
  editorial_json JSONB, article_json JSONB, review_json JSONB,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK(status IN ('discovered','ready','rejected','failed','published')),
  source_revision TEXT, content_hash TEXT, reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0, discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checked_at TIMESTAMPTZ,
  UNIQUE(repo,path)
);
CREATE TABLE IF NOT EXISTS learning_runs (
  id BIGSERIAL PRIMARY KEY, day DATE NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','complete','failed','partial')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
  cursor_before INTEGER, cursor_after INTEGER, detail_json JSONB NOT NULL DEFAULT '{}', error TEXT
);
CREATE INDEX IF NOT EXISTS learning_runs_day ON learning_runs(day,started_at DESC);
CREATE TABLE IF NOT EXISTS learning_legacy_archive (
  id INTEGER PRIMARY KEY CHECK(id=1), archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), data_json JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), token_hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS learning_progress (
  profile_id UUID NOT NULL REFERENCES learning_profiles(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'reading' CHECK(status IN ('reading','completed','review')),
  sentence_id TEXT, block_id TEXT, exercise_done BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
  PRIMARY KEY(profile_id,article_id)
);
CREATE TABLE IF NOT EXISTS learning_images (
  article_id TEXT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL, body BYTEA NOT NULL, content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(article_id,block_id)
);
COMMIT;

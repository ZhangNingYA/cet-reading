BEGIN;
CREATE TABLE IF NOT EXISTS news_batches (
  scheduled_at TIMESTAMPTZ PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  reason TEXT NOT NULL DEFAULT '',
  audit_json JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS news_articles (
  id TEXT PRIMARY KEY,
  batch_at TIMESTAMPTZ NOT NULL REFERENCES news_batches(scheduled_at),
  selection_kind TEXT NOT NULL CHECK (selection_kind IN ('curated', 'hot')),
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  published_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  license_name TEXT NOT NULL,
  license_url TEXT NOT NULL,
  license_policy_url TEXT NOT NULL,
  paragraphs_json JSONB NOT NULL CHECK (jsonb_typeof(paragraphs_json) = 'array'),
  content_hash TEXT NOT NULL UNIQUE,
  word_count INTEGER NOT NULL CHECK (word_count > 0),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('CET6', 'NEEP', 'advanced')),
  difficulty_reason TEXT NOT NULL,
  topic TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_at TIMESTAMPTZ,
  hotness_json JSONB NOT NULL DEFAULT '[]',
  selection_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS news_articles_date ON news_articles (batch_at DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS news_articles_event ON news_articles (event_key, batch_at DESC);
ALTER TABLE sentences ALTER COLUMN paper_id DROP NOT NULL;
ALTER TABLE sentences ADD COLUMN IF NOT EXISTS article_id TEXT REFERENCES news_articles(id) ON DELETE CASCADE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentences_one_owner') THEN
    ALTER TABLE sentences ADD CONSTRAINT sentences_one_owner
      CHECK ((paper_id IS NOT NULL AND article_id IS NULL) OR (paper_id IS NULL AND article_id IS NOT NULL AND section_id IS NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS sentences_article_position ON sentences (article_id, paragraph_index, sentence_index) WHERE article_id IS NOT NULL;
COMMIT;

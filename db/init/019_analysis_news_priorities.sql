CREATE TABLE IF NOT EXISTS analysis_news_priorities (
  article_id TEXT PRIMARY KEY REFERENCES news_articles(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

BEGIN;

CREATE TABLE IF NOT EXISTS reading_progress (
  board TEXT PRIMARY KEY CHECK (board IN ('cet4', 'cet6', 'postgraduate', 'news')),
  item_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('intensive', 'practice')),
  section_id TEXT,
  sentence_id TEXT,
  section_title TEXT,
  sentence_number INTEGER CHECK (sentence_number IS NULL OR sentence_number > 0),
  sentence_preview TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

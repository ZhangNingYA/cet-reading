ALTER TABLE papers ADD COLUMN IF NOT EXISTS content_state TEXT NOT NULL DEFAULT 'local'
  CHECK (content_state IN ('local', 'external'));
ALTER TABLE papers ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT '';
ALTER TABLE papers ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE papers DROP CONSTRAINT IF EXISTS papers_exam_level_year_month_set_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS papers_edition_key ON papers (exam_level, year, month, set_no, is_demo);

CREATE TABLE IF NOT EXISTS paper_sections (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('reading', 'cloze', 'matching', 'translation', 'writing')),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  paragraphs_json JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(paragraphs_json) = 'array'),
  UNIQUE (paper_id, position)
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES paper_sections(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  type TEXT NOT NULL CHECK (type IN ('choice', 'text')),
  prompt TEXT NOT NULL,
  options_json JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options_json) = 'array'),
  answer_text TEXT,
  explanation TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL CHECK (points > 0),
  UNIQUE (section_id, position)
);
ALTER TABLE sentences ADD COLUMN IF NOT EXISTS section_id TEXT REFERENCES paper_sections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sentences_section ON sentences (section_id, paragraph_index, sentence_index);
CREATE TABLE IF NOT EXISTS practice_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id TEXT NOT NULL REFERENCES papers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  questions_snapshot JSONB NOT NULL CHECK (jsonb_typeof(questions_snapshot) = 'array'),
  answers_json JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(answers_json) = 'object'),
  result_json JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS practice_attempts_paper ON practice_attempts (paper_id, started_at);

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  exam_level TEXT NOT NULL CHECK (exam_level IN ('CET4', 'CET6')),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  set_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exam_level, year, month, set_no)
);

CREATE TABLE IF NOT EXISTS sentences (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  paragraph_index INTEGER NOT NULL,
  sentence_index INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  source_hash TEXT GENERATED ALWAYS AS (encode(digest(source_text, 'sha256'), 'hex')) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, paragraph_index, sentence_index)
);

CREATE TABLE IF NOT EXISTS sentence_analyses (
  id BIGSERIAL PRIMARY KEY,
  sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  context_json JSONB NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'ai')),
  analysis_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'invalidated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sentence_id, source_hash, context_hash, prompt_version, model, mode)
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  source_text TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  context_json JSONB NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'ai')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sentence_id, source_hash, context_hash, prompt_version, model, mode)
);
CREATE INDEX IF NOT EXISTS analysis_jobs_queue ON analysis_jobs (mode, model, prompt_version, status, created_at);

INSERT INTO papers (id, exam_level, year, month, set_no, title, is_demo, status)
VALUES ('demo-cet4-2026-set1', 'CET4', 2026, 6, 1, '两句精读示例（非真题）', TRUE, 'published')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sentences (id, paper_id, paragraph_index, sentence_index, source_text)
VALUES
  ('demo-sentence-001', 'demo-cet4-2026-set1', 0, 0, 'Although the plan was expensive, it was successful.'),
  ('demo-sentence-002', 'demo-cet4-2026-set1', 0, 1, 'The result encouraged the team to continue its research.')
ON CONFLICT (id) DO NOTHING;

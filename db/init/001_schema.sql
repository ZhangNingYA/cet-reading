CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  exam_level TEXT NOT NULL CHECK (exam_level IN ('CET4', 'CET6')),
  year INTEGER NOT NULL,
  set_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exam_level, year, set_no)
);

CREATE TABLE IF NOT EXISTS sentences (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  paragraph_index INTEGER NOT NULL,
  sentence_index INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, paragraph_index, sentence_index)
);

CREATE TABLE IF NOT EXISTS sentence_analyses (
  id BIGSERIAL PRIMARY KEY,
  sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  analysis_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'invalidated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sentence_id, source_hash, prompt_version, model)
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sentence_id, source_hash, prompt_version, model)
);

INSERT INTO papers (id, exam_level, year, set_no, title, status)
VALUES ('demo-cet4-2026-set1', 'CET4', 2026, 1, 'CET4 阅读示例试卷', 'published')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sentences (id, paper_id, paragraph_index, sentence_index, source_text, source_hash)
VALUES
  ('demo-sentence-001', 'demo-cet4-2026-set1', 0, 0,
   'Although the plan was expensive, it was successful.',
   'demo-hash-001'),
  ('demo-sentence-002', 'demo-cet4-2026-set1', 0, 1,
   'The result encouraged the team to continue its research.',
   'demo-hash-002')
ON CONFLICT (id) DO NOTHING;

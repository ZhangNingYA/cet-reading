BEGIN;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS content_kind TEXT NOT NULL DEFAULT 'demo'
  CHECK (content_kind IN ('original', 'external', 'demo'));
ALTER TABLE papers ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE papers ADD COLUMN IF NOT EXISTS reference_paper_id TEXT REFERENCES papers(id);
UPDATE papers SET content_kind = 'external' WHERE content_state = 'external';
ALTER TABLE paper_sections ADD COLUMN IF NOT EXISTS study_paragraphs_json JSONB NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(study_paragraphs_json) = 'array');
COMMIT;

BEGIN;
ALTER TABLE paper_sections ADD COLUMN IF NOT EXISTS images_json JSONB NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(images_json) = 'array');
ALTER TABLE questions ALTER COLUMN points TYPE NUMERIC(6, 2) USING points::NUMERIC(6, 2);
COMMIT;

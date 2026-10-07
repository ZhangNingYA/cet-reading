BEGIN;
ALTER TABLE papers DROP CONSTRAINT IF EXISTS papers_content_kind_check;
ALTER TABLE papers ADD CONSTRAINT papers_content_kind_check
  CHECK (content_kind IN ('original', 'imported', 'external', 'demo'));
COMMIT;

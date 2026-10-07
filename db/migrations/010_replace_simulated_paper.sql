-- Replace previous content with the paper supplied by the user.
-- Explicit IDs preserve unrelated papers added in future releases.
BEGIN;
DO $$
DECLARE
  removed_ids TEXT[] := ARRAY[
    'original-cet4-2026-1', 'original-cet4-2026-2', 'original-cet4-2026-3',
    'original-cet6-2026-1', 'original-cet6-2026-2', 'original-cet6-2026-3',
    'original-neep-2026-1', 'original-neep-2026-2', 'original-neep-2026-3',
    'cet4-2026-06-2', 'cet4-2026-06-3',
    'cet6-2026-06-1', 'cet6-2026-06-2', 'cet6-2026-06-3',
    'neep-2025-1', 'neep-2025-2', 'neep-2024-1',
    'demo-cet4-2026-set1', 'demo-cet6-2026-set1', 'demo-neep-2026-set1'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM papers WHERE id = 'cet4-2026-06-1' AND content_kind = 'imported')
    OR (SELECT count(*) FROM questions q JOIN paper_sections ps ON ps.id = q.section_id
        WHERE ps.paper_id = 'cet4-2026-06-1') <> 32 THEN
    RAISE EXCEPTION 'Import the complete user-provided CET4 paper before removing simulated content';
  END IF;

  UPDATE papers SET reference_paper_id = NULL WHERE reference_paper_id = ANY(removed_ids);
  DELETE FROM practice_attempts WHERE paper_id = ANY(removed_ids);
  DELETE FROM papers WHERE id = ANY(removed_ids);
END;
$$;
COMMIT;

-- Remove only the verified trailing-quote artifact; preserve all valid sentences and their caches.
DELETE FROM sentences
WHERE id = 'cet4-2025-12-3-section-4-sentence-7-5'
  AND paper_id = 'cet4-2025-12-3'
  AND section_id = 'cet4-2025-12-3-section-4'
  AND btrim(source_text) = '"';

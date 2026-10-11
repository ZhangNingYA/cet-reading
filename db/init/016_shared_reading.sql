-- Keep the database's shared-reading rule in one place for API, worker and deploy cleanup.
CREATE OR REPLACE VIEW shared_paper_sections AS
WITH section_content AS (
  SELECT ps.id, ps.paper_id, ps.kind,
         jsonb_build_object(
           'kind', ps.kind,
           'instructions', ps.instructions,
           'paragraphs', ps.paragraphs_json,
           'images', COALESCE(ps.images_json, '[]'::jsonb),
           'questions', COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'type', q.type,
                 'prompt', q.prompt,
                 'options', COALESCE(q.options_json, '[]'::jsonb)
               ) ORDER BY q.position
             )
             FROM questions q
             WHERE q.section_id = ps.id
           ), '[]'::jsonb)
         ) AS content
  FROM paper_sections ps
)
SELECT child.paper_id,
       child.id AS section_id,
       paper.reference_paper_id
FROM section_content child
JOIN papers paper ON paper.id = child.paper_id
JOIN papers reference ON reference.id = paper.reference_paper_id
                      AND reference.status = 'published'
WHERE paper.status = 'published'
  AND child.kind IN ('cloze', 'matching', 'reading')
  AND EXISTS (
    SELECT 1
    FROM section_content original
    WHERE original.paper_id = reference.id
      AND original.content = child.content
  );

BEGIN;

ALTER TABLE papers DROP CONSTRAINT IF EXISTS papers_exam_level_check;
ALTER TABLE papers
  ADD CONSTRAINT papers_exam_level_check
  CHECK (exam_level IN ('CET4', 'CET6', 'NEEP'));

INSERT INTO papers (id, exam_level, year, month, set_no, title, is_demo, status)
VALUES
  ('demo-cet6-2026-set1', 'CET6', 2026, 6, 1, '六级精读示例（非真题）', TRUE, 'published'),
  ('demo-neep-2026-set1', 'NEEP', 2026, 6, 1, '考研英语精读示例（非真题）', TRUE, 'published')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sentences (id, paper_id, paragraph_index, sentence_index, source_text)
VALUES
  ('demo-cet6-sentence-001', 'demo-cet6-2026-set1', 0, 0, 'When evidence is carefully examined, a simple idea can reveal a complex problem.'),
  ('demo-cet6-sentence-002', 'demo-cet6-2026-set1', 0, 1, 'This habit of questioning helps readers understand an argument more precisely.'),
  ('demo-neep-sentence-001', 'demo-neep-2026-set1', 0, 0, 'A useful theory should explain the facts while leaving room for new questions.'),
  ('demo-neep-sentence-002', 'demo-neep-2026-set1', 0, 1, 'Readers therefore need to connect each claim with the evidence that supports it.')
ON CONFLICT (id) DO NOTHING;

COMMIT;

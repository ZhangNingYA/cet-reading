BEGIN;

UPDATE papers
SET title = '本地模式演示（非真题）', content_state = 'local', source_url = NULL, variant = 'demo'
WHERE id = 'demo-cet4-2026-set1';

INSERT INTO paper_sections (id, paper_id, position, kind, title, instructions, paragraphs_json)
VALUES
  ('demo-section-reading', 'demo-cet4-2026-set1', 0, 'reading', '阅读理解', '阅读短文后完成选择题。', '["Although the plan was expensive, it was successful.", "The result encouraged the team to continue its research."]'::jsonb),
  ('demo-section-cloze', 'demo-cet4-2026-set1', 1, 'cloze', '完形填空', '选择最合适的词语完成句子。', '["A clear study plan helps learners make steady progress."]'::jsonb),
  ('demo-section-matching', 'demo-cet4-2026-set1', 2, 'matching', '信息匹配', '将信息与对应选项匹配。', '["Regular review turns short practice into lasting knowledge."]'::jsonb),
  ('demo-section-translation', 'demo-cet4-2026-set1', 3, 'translation', '翻译', '将下面的句子翻译成中文。', '["Careful reading makes difficult sentences easier to understand."]'::jsonb),
  ('demo-section-writing', 'demo-cet4-2026-set1', 4, 'writing', '写作', '根据题目完成一篇短文。', '[]'::jsonb)
ON CONFLICT (id) DO UPDATE SET paragraphs_json = EXCLUDED.paragraphs_json, title = EXCLUDED.title;

UPDATE sentences SET section_id = 'demo-section-reading'
WHERE paper_id = 'demo-cet4-2026-set1' AND id IN ('demo-sentence-001', 'demo-sentence-002');

INSERT INTO questions (id, section_id, position, type, prompt, options_json, answer_text, explanation, points)
VALUES
  ('demo-reading-q1', 'demo-section-reading', 0, 'choice', 'What was true about the plan?', '[{"key":"A","text":"It was expensive but successful."},{"key":"B","text":"It was cheap and unsuccessful."},{"key":"C","text":"It was cancelled."},{"key":"D","text":"It was never tested."}]'::jsonb, 'A', 'although introduces a contrast between cost and result.', 2),
  ('demo-cloze-q1', 'demo-section-cloze', 0, 'choice', 'A clear study plan helps learners make _____ progress.', '[{"key":"A","text":"steady"},{"key":"B","text":"silent"},{"key":"C","text":"narrow"},{"key":"D","text":"empty"}]'::jsonb, 'A', 'steady progress means continuous and reliable progress.', 2),
  ('demo-matching-q1', 'demo-section-matching', 0, 'choice', 'What does regular review do?', '[{"key":"A","text":"It turns practice into lasting knowledge."},{"key":"B","text":"It removes every difficulty."},{"key":"C","text":"It replaces reading."},{"key":"D","text":"It shortens every text."}]'::jsonb, 'A', 'The sentence directly states the benefit of review.', 2),
  ('demo-translation-q1', 'demo-section-translation', 0, 'text', 'Careful reading makes difficult sentences easier to understand.', '[]'::jsonb, NULL, '主观翻译题保存作答，暂不自动评分。', 4),
  ('demo-writing-q1', 'demo-section-writing', 0, 'text', 'Write a short paragraph about a useful reading habit.', '[]'::jsonb, NULL, '主观写作题保存作答，暂不自动评分。', 6)
ON CONFLICT (id) DO UPDATE SET prompt = EXCLUDED.prompt, options_json = EXCLUDED.options_json, answer_text = EXCLUDED.answer_text, explanation = EXCLUDED.explanation, points = EXCLUDED.points;

INSERT INTO papers (id, exam_level, year, month, set_no, variant, title, is_demo, status, content_state, source_url)
VALUES
  ('cet4-2026-06-1', 'CET4', 2026, 6, 1, '', '2026年6月大学英语四级真题（第1套）', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2026-06-cet4-1'),
  ('cet4-2026-06-2', 'CET4', 2026, 6, 2, '', '2026年6月大学英语四级真题（第2套）', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2026-06-cet4-2'),
  ('cet4-2026-06-3', 'CET4', 2026, 6, 3, '', '2026年6月大学英语四级真题（第3套）', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2026-06-cet4-3'),
  ('cet6-2026-06-1', 'CET6', 2026, 6, 1, '', '2026年6月大学英语六级真题（第1套）', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2026-06-cet6-1'),
  ('cet6-2026-06-2', 'CET6', 2026, 6, 2, '', '2026年6月大学英语六级真题（第2套）', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2026-06-cet6-2'),
  ('cet6-2026-06-3', 'CET6', 2026, 6, 3, '', '2026年6月大学英语六级真题（第3套）', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2026-06-cet6-3'),
  ('neep-2025-1', 'NEEP', 2025, 12, 1, '英语一', '2025年考研英语一真题', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2025-1'),
  ('neep-2025-2', 'NEEP', 2025, 12, 2, '英语二', '2025年考研英语二真题', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2025-2'),
  ('neep-2024-1', 'NEEP', 2024, 12, 1, '英语一', '2024年考研英语一真题', FALSE, 'published', 'external', 'https://pastpapers.cn/paper/2024-1')
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, source_url = EXCLUDED.source_url, content_state = 'external', status = 'published';

COMMIT;

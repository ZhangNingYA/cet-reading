BEGIN;
-- Keep the previous records for recovery, then use one site-wide record per article.
CREATE TABLE IF NOT EXISTS learning_progress_archive (
  id INTEGER PRIMARY KEY CHECK(id=1), archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_json JSONB NOT NULL
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='learning_progress' AND column_name='profile_id') THEN
    INSERT INTO learning_progress_archive(id,data_json)
      SELECT 1,COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM learning_progress p
      ON CONFLICT DO NOTHING;
    CREATE TABLE learning_progress_single (
      article_id TEXT PRIMARY KEY REFERENCES news_articles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'reading' CHECK(status IN ('reading','completed','review')),
      sentence_id TEXT, block_id TEXT, exercise_done BOOLEAN NOT NULL DEFAULT FALSE,
      notes TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
    );
    INSERT INTO learning_progress_single(article_id,status,sentence_id,block_id,exercise_done,notes,revision,started_at,updated_at,completed_at)
      SELECT DISTINCT ON (p.article_id) p.article_id,p.status,p.sentence_id,p.block_id,p.exercise_done,p.notes,p.revision,p.started_at,p.updated_at,p.completed_at
      FROM learning_progress p
      ORDER BY p.article_id,p.updated_at DESC,p.revision DESC,p.profile_id;
    DROP TABLE learning_progress;
    ALTER TABLE learning_progress_single RENAME TO learning_progress;
  END IF;
END $$;
DROP TABLE IF EXISTS learning_profiles;
COMMIT;

import type { ArticleChatContext, ArticleChatTarget } from '@cet-reading/contracts/article-chat';
import type { Pool } from 'pg';
import { pool } from './store.js';

export async function loadArticleChatContext(target: ArticleChatTarget, db: Pick<Pool, 'query'> = pool): Promise<ArticleChatContext | null> {
  if (target.kind === 'news') {
    const result = await db.query<ArticleChatContext>(
      `SELECT title, paragraphs_json AS paragraphs, author, source_name AS "sourceName", published_at::text AS "publishedAt"
       FROM news_articles WHERE id=$1 AND status='published'`,
      [target.id],
    );
    return result.rows[0] ?? null;
  }
  const result = await db.query<ArticleChatContext>(
    `SELECT p.title || ' · ' || ps.title AS title, ps.paragraphs_json AS paragraphs, ps.instructions,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('prompt', q.prompt, 'options', q.options_json) ORDER BY q.position)
         FROM questions q WHERE q.section_id=ps.id), '[]'::jsonb) AS questions
     FROM paper_sections ps JOIN papers p ON p.id=ps.paper_id
     WHERE p.id=$1 AND ps.id=$2 AND p.status='published' AND p.content_state='local'
       AND ps.kind IN ('reading','matching','cloze','translation')
       AND NOT EXISTS (SELECT 1 FROM shared_paper_sections shared WHERE shared.paper_id=p.id AND shared.section_id=ps.id)`,
    [target.id, target.sectionId],
  );
  return result.rows[0] ?? null;
}

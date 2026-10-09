import { pool } from './store.js';

export async function listNews(before?: string) {
  const batches = await pool.query(`SELECT b.scheduled_at,b.status,b.reason,count(n.id)::int AS article_count
    FROM news_batches b LEFT JOIN news_articles n ON n.batch_at=b.scheduled_at AND n.status='published'
    WHERE ($1::timestamptz IS NULL OR b.scheduled_at < $1)
    GROUP BY b.scheduled_at ORDER BY b.scheduled_at DESC LIMIT 31`,[before || null]);
  const visible = batches.rows.slice(0,30);
  const result = await pool.query(`SELECT id,batch_at,selection_kind,title,source_name,published_at,word_count,difficulty,topic
    FROM news_articles WHERE status='published' AND batch_at=ANY($1::timestamptz[])
    ORDER BY batch_at DESC,selection_kind, published_at DESC`,[visible.map(row=>row.scheduled_at)]);
  return { articles:result.rows, batches:visible.map(row=>({ ...row, reason:row.status==='failed'?'采集暂时失败，任务会按规则重试。':row.reason })), nextCursor:batches.rows.length>30?visible.at(-1).scheduled_at:null, schedule:{ timezone:'Asia/Shanghai', hours:[8,11,14,17] } };
}
export async function getNews(id: string) {
  const result = await pool.query(`SELECT id,title,author,source_name,source_url,published_at,batch_at,license_name,license_url,word_count,difficulty,difficulty_reason,topic,selection_kind,selection_reason,hotness_json AS evidence, paragraphs_json AS paragraphs
    FROM news_articles WHERE id=$1 AND status='published'`,[id]);
  const article = result.rows[0]; if (!article) return null;
  const sentences = await pool.query(`SELECT id,paragraph_index AS "paragraphIndex",sentence_index AS "sentenceIndex",source_text AS source,article_id || '-body' AS "sectionId"
    FROM sentences WHERE article_id=$1 ORDER BY paragraph_index,sentence_index`,[id]);
  const { paragraphs, ...metadata } = article;
  return { ...metadata, content_kind:'news', exam_level:'NEWS', sections:[{ id:`${id}-body`, title:article.title,kind:'reading',paragraphs,questions:[] }], sentences:sentences.rows };
}

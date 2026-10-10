import { pool } from './store.js';
import { config } from './config.js';

export async function listNews(before?: string) {
  const batches = await pool.query(`SELECT b.scheduled_at,b.status,b.reason,count(n.id)::int AS article_count
    FROM news_batches b LEFT JOIN news_articles n ON n.batch_at=b.scheduled_at AND n.status='published'
    WHERE ($1::timestamptz IS NULL OR b.scheduled_at < $1)
    GROUP BY b.scheduled_at ORDER BY b.scheduled_at DESC LIMIT 31`,[before || null]);
  const visible = batches.rows.slice(0,30);
  const result = await pool.query(`WITH ordered AS (
    SELECT s.id,s.article_id,s.source_hash,
           jsonb_build_object(
             'title', n.title,
             'previousSentence', lag(s.source_text) OVER w,
             'nextSentence', lead(s.source_text) OVER w
           ) AS context_json
    FROM sentences s JOIN news_articles n ON n.id=s.article_id
    WHERE n.status='published'
    WINDOW w AS (PARTITION BY s.article_id ORDER BY s.paragraph_index,s.sentence_index)
  )
  SELECT n.id,n.batch_at,n.selection_kind,n.title,n.source_name,n.published_at,n.word_count,n.difficulty,n.topic,
    COUNT(DISTINCT o.id)::int AS analysis_total,
    COUNT(DISTINCT a.sentence_id)::int AS analysis_cached,
    COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND
      (j.status='pending' OR (j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW()))))::int AS analysis_pending,
    COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND
      j.status='running' AND j.lease_expires_at>NOW())::int AS analysis_running,
    COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND j.status='failed')::int AS analysis_failed
    FROM news_articles n
    LEFT JOIN ordered o ON o.article_id=n.id
    LEFT JOIN sentence_analyses a ON a.sentence_id=o.id AND a.source_hash=o.source_hash
      AND a.context_json=o.context_json AND a.prompt_version=$2 AND a.model=$3 AND a.mode=$4 AND a.status='succeeded'
    LEFT JOIN analysis_jobs j ON j.sentence_id=o.id AND j.source_hash=o.source_hash
      AND j.context_json=o.context_json AND j.prompt_version=$2 AND j.model=$3 AND j.mode=$4
      AND j.status IN ('pending','running','failed')
    WHERE n.status='published' AND n.batch_at=ANY($1::timestamptz[])
    GROUP BY n.id
    ORDER BY n.batch_at DESC,n.selection_kind,n.published_at DESC`,
    [visible.map(row=>row.scheduled_at),config.promptVersion,config.model,config.mode]);
  return { articles:result.rows, batches:visible.map(row=>({ ...row, reason:row.status==='failed'?'采集暂时失败，任务会按规则重试。':row.reason })), nextCursor:batches.rows.length>30?visible.at(-1).scheduled_at:null, schedule:{ timezone:'Asia/Shanghai', hours:[8,11,14,17] } };
}
export async function getNews(id: string) {
  const result = await pool.query(`SELECT id,title,author,source_name,source_url,published_at,batch_at,license_name,license_url,word_count,difficulty,difficulty_reason,topic,selection_kind,selection_reason,hotness_json AS evidence, paragraphs_json AS paragraphs
    FROM news_articles WHERE id=$1 AND status='published'`,[id]);
  const article = result.rows[0]; if (!article) return null;
  const progress = await pool.query(`WITH ordered AS (
      SELECT s.id,s.source_hash,
             jsonb_build_object(
               'title', n.title,
               'previousSentence', lag(s.source_text) OVER w,
               'nextSentence', lead(s.source_text) OVER w
             ) AS context_json
      FROM sentences s JOIN news_articles n ON n.id=s.article_id
      WHERE n.id=$1 AND n.status='published'
      WINDOW w AS (PARTITION BY s.article_id ORDER BY s.paragraph_index,s.sentence_index)
    )
    SELECT COUNT(DISTINCT o.id)::int AS analysis_total,
      COUNT(DISTINCT a.sentence_id)::int AS analysis_cached,
      COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND
        (j.status='pending' OR (j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW()))))::int AS analysis_pending,
      COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND
        j.status='running' AND j.lease_expires_at>NOW())::int AS analysis_running,
      COUNT(DISTINCT j.sentence_id) FILTER (WHERE a.sentence_id IS NULL AND j.status='failed')::int AS analysis_failed
    FROM ordered o
    LEFT JOIN sentence_analyses a ON a.sentence_id=o.id AND a.source_hash=o.source_hash
      AND a.context_json=o.context_json AND a.prompt_version=$2 AND a.model=$3 AND a.mode=$4 AND a.status='succeeded'
    LEFT JOIN analysis_jobs j ON j.sentence_id=o.id AND j.source_hash=o.source_hash
      AND j.context_json=o.context_json AND j.prompt_version=$2 AND j.model=$3 AND j.mode=$4
      AND j.status IN ('pending','running','failed')`,
    [id,config.promptVersion,config.model,config.mode]);
  const sentences = await pool.query(`SELECT id,paragraph_index AS "paragraphIndex",sentence_index AS "sentenceIndex",source_text AS source,article_id || '-body' AS "sectionId"
    FROM sentences WHERE article_id=$1 ORDER BY paragraph_index,sentence_index`,[id]);
  const { paragraphs, ...metadata } = article;
  return { ...metadata, ...(progress.rows[0] ?? { analysis_total:0,analysis_cached:0,analysis_pending:0,analysis_running:0,analysis_failed:0 }), content_kind:'news', exam_level:'NEWS', sections:[{ id:`${id}-body`, title:article.title,kind:'reading',paragraphs,questions:[] }], sentences:sentences.rows };
}

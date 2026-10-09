import 'dotenv/config';
import { Pool } from 'pg';
import { readConfig } from '@cet-reading/contracts/config';
import { NEWS_HOURS, newsDay, newsSlot, nextNewsSlot, readNewsConfig, splitNewsParagraph } from '@cet-reading/contracts/news';
import { loadCandidates, digest } from './news-sources.js';
import { selectNews, validateNewsPicks } from './news-selector.js';

const config = readConfig(); const news = readNewsConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
let stopping = false;

async function runBatch(slot: Date, supplement = false) {
  if (slot > new Date()) throw new Error('Cannot ingest a future news batch');
  if (!config.apiKey || !config.apiUrl || !news.model || config.mode !== 'ai') throw new Error('News ingestion requires configured real AI credentials');
  const client = await pool.connect();
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(814172026) AS locked');
    if (!lock.rows[0].locked) return console.log('Another news collector is running');
    const claimed = await client.query(`INSERT INTO news_batches (scheduled_at,status) VALUES ($1,'running')
      ON CONFLICT (scheduled_at) DO UPDATE SET status='running', attempts=news_batches.attempts+1, started_at=NOW(), finished_at=NULL
      WHERE ($2::boolean AND news_batches.status IN ('partial','failed','running'))
        OR (NOT $2::boolean AND news_batches.status IN ('failed','running') AND news_batches.attempts < 3) RETURNING *`, [slot,supplement]);
    if (!claimed.rowCount) return console.log(`Batch ${slot.toISOString()} already finished or exhausted retries`);
    console.log(`Collecting news batch ${slot.toISOString()} (Shanghai)`);
    try {
      const { candidates, failures } = await loadCandidates(slot);
      const recent = await client.query(`SELECT title,source_url,event_key,content_hash FROM news_articles WHERE status='published' ORDER BY batch_at DESC LIMIT 180`);
      const existing = await client.query('SELECT selection_kind FROM news_articles WHERE batch_at=$1',[slot]);
      const remaining = { curated:1-existing.rows.filter(item=>item.selection_kind==='curated').length,hot:2-existing.rows.filter(item=>item.selection_kind==='hot').length };
      const allUrls = await client.query('SELECT source_url,content_hash FROM news_articles');
      const urls = new Set(allUrls.rows.map(item => item.source_url)); const hashes = new Set(allUrls.rows.map(item => item.content_hash));
      const fresh = candidates.filter(item => !urls.has(item.url));
      if (!fresh.length) throw new Error('No fresh licensed candidates: ' + failures.join('; '));
      const result = await selectNews(config, news.model, news.maxRounds, fresh, slot, recent.rows, remaining);
      const checked = validateNewsPicks(result.selection, result.articles, result.evidence, slot, new Set(recent.rows.map(item => item.event_key.toLowerCase().trim())));
      const chosen = checked.chosen.filter(item => { if (hashes.has(item.article.contentHash) || remaining[item.pick.kind]<=0) return false; remaining[item.pick.kind]--; return true; });
      const total = chosen.length+existing.rows.length;
      const reasons = [result.selection.shortfall, ...checked.rejected, ...(chosen.length < 3 ? failures : [])].filter(Boolean);
      if (total < 3 && !reasons.length) reasons.push('符合时效、热点证据、全文授权和阅读难度的未收录文章不足三篇。');
      await client.query('BEGIN');
      for (const { article, pick, evidence } of chosen) {
        const id = `news-${digest(article.url).slice(0,20)}`;
        await client.query(`INSERT INTO news_articles
          (id,batch_at,selection_kind,title,author,source_name,source_url,published_at,fetched_at,license_name,license_url,license_policy_url,paragraphs_json,content_hash,word_count,difficulty,difficulty_reason,topic,event_key,event_at,hotness_json,selection_reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [id,slot,pick.kind,article.title,article.author,article.source.name,article.url,article.publishedAt,article.fetchedAt,article.source.license,article.source.licenseUrl,article.source.policy,JSON.stringify(article.paragraphs),article.contentHash,article.wordCount,pick.difficulty,pick.difficultyReason,pick.topic,pick.eventKey.toLowerCase().trim(),pick.eventAt,JSON.stringify(evidence),pick.reason]);
        for (const [paragraphIndex, paragraph] of article.paragraphs.entries()) {
          for (const [sentenceIndex, sentence] of splitNewsParagraph(paragraph).entries()) {
            await client.query(`INSERT INTO sentences (id,article_id,paragraph_index,sentence_index,source_text) VALUES ($1,$2,$3,$4,$5)`, [`${id}-sentence-${paragraphIndex+1}-${sentenceIndex+1}`,id,paragraphIndex,sentenceIndex,sentence]);
          }
        }
      }
      const previous = claimed.rows[0].audit_json;
      const audit = { model:news.model, cutoff:slot.toISOString(), candidateCount:fresh.length, failures, selection:result.selection, rejected:checked.rejected, tools:result.audit };
      await client.query(`UPDATE news_batches SET status=$2,finished_at=NOW(),reason=$3,audit_json=$4 WHERE scheduled_at=$1`, [slot,total===3?'complete':'partial',total===3?'':reasons.join('\n'),JSON.stringify({ ...audit, ...(supplement?{ priorRuns:[...(previous.priorRuns||[]),Object.fromEntries(Object.entries(previous).filter(([key])=>key!=='priorRuns'))] }: {}) })]);
      await client.query('COMMIT');
      console.log(JSON.stringify({ batch:slot.toISOString(), count:total, added:chosen.length, titles:chosen.map(item=>item.article.title), reason:total===3?'':reasons.join('\n') }));
    } catch (error) {
      await client.query('ROLLBACK');
      const reason = error instanceof Error ? error.message : 'News ingestion failed';
      await client.query(`UPDATE news_batches SET status='failed',finished_at=NOW(),reason=$2 WHERE scheduled_at=$1`,[slot,reason]);
      throw error;
    }
  } finally { await client.query('SELECT pg_advisory_unlock(814172026)').catch(()=>{}); client.release(); }
}

const args = process.argv.slice(2);
if (args[0] === '--slot') {
  try { const [day,hour] = (args[1] || '').split('/'); await runBatch(newsSlot(day!,Number(hour)),args.includes('--supplement')); }
  finally { await pool.end(); }
} else if (!news.enabled) {
  console.log('News schedule is disabled. Set NEWS_ENABLED=true after the initial backfill.');
  const idle = setInterval(()=>{},60000);
  const stop = () => { clearInterval(idle); void pool.end(); }; process.once('SIGTERM',stop); process.once('SIGINT',stop);
} else {
  console.log(`News schedule: 08:00 / 11:00 / 14:00 / 17:00 Asia/Shanghai; next ${nextNewsSlot(new Date()).toISOString()}`);
  let wake: ReturnType<typeof setTimeout> | undefined; let releaseWait: (()=>void) | undefined;
  const stop = () => { stopping=true; if (wake) clearTimeout(wake); releaseWait?.(); };
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
  try {
    while (!stopping) {
      const now = new Date();
      const batches = await pool.query(`SELECT scheduled_at,status,attempts,finished_at FROM news_batches WHERE scheduled_at >= $1`,[newsSlot(newsDay(now),8)]);
      const recorded = new Map(batches.rows.map(row=>[new Date(row.scheduled_at).toISOString(),row]));
      for (const hour of NEWS_HOURS) {
        const slot = newsSlot(newsDay(now),hour); if (slot > now || stopping) continue;
        const row = recorded.get(slot.toISOString());
        if (row && (['complete','partial'].includes(row.status) || row.attempts>=3 || (row.status==='failed' && now.getTime()-new Date(row.finished_at).getTime()<120000))) continue;
        try { await runBatch(slot); } catch (error) { console.error(error instanceof Error ? error.message : 'News collection failed'); }
      }
      if (!stopping) await new Promise<void>(resolve=>{ releaseWait=resolve; wake=setTimeout(resolve,15000); });
    }
  } finally { await pool.end(); }
}

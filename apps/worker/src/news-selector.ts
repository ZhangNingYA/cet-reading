import { NEWS_SELECTOR_PROMPT, NewsSelectionSchema, timely, type NewsSelection } from '@cet-reading/contracts/news';
import type { RuntimeConfig } from '@cet-reading/contracts/config';
import { readArticle, searchNews, type Article, type Candidate, type Evidence } from './news-sources.js';

const tools = [
  { type: 'function', function: { name: 'read_article', description: 'Read complete original English article and verified license/date. Use a candidate ID from the supplied live feed.', parameters: { type: 'object', properties: { candidateId: { type: 'string' } }, required: ['candidateId'], additionalProperties: false } } },
  { type: 'function', function: { name: 'search_news', description: 'Live English news search for an event. Use short event keywords without calendar dates; the server applies the time window. If results are insufficient, retry broader synonyms. Return genuine publisher headlines, timestamps and evidence IDs; unrelated results do not prove hotness.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
];
export function validateNewsPicks(selection: NewsSelection, articles: Map<string, Article>, evidence: Map<string, Evidence>, cutoff: Date, recentEvents: Set<string>) {
  const chosen: { article: Article; pick: NewsSelection['selections'][number]; evidence: Evidence[] }[] = [];
  const rejected: string[] = []; const used = new Set<string>(); const hashes = new Set<string>(); const events = new Set(recentEvents);
  for (const pick of selection.selections) {
    const article = articles.get(pick.candidateId);
    const fail = (reason: string) => rejected.push(`${article?.title || pick.candidateId}: ${reason}`);
    if (!article) { fail('AI 未读取或未能核验完整正文'); continue; }
    if (used.has(article.url) || hashes.has(article.contentHash) || events.has(pick.eventKey.toLowerCase().trim())) { fail('重复正文或事件'); continue; }
    if (chosen.filter(item => item.pick.kind === pick.kind).length >= (pick.kind === 'hot' ? 2 : 1)) { fail('超出本轮类别配额'); continue; }
    const proofs = [...new Set(pick.evidenceIds)].map(id => evidence.get(id)).filter((item): item is Evidence => Boolean(item));
    if (pick.kind === 'hot') {
      if (!timely(article.publishedAt, cutoff, 48) || !pick.eventAt || !timely(pick.eventAt, cutoff, 48)) { fail('发表或事件时间不满足 48 小时时效要求'); continue; }
      if (proofs.length !== new Set(pick.evidenceIds).size || new Set(proofs.map(item => new URL(item.publisherUrl).hostname.replace(/^www\./,''))).size < 2) { fail('缺少两家真实独立媒体的近期证据'); continue; }
      if (proofs.some(item => !timely(item.publishedAt, cutoff, 48))) { fail('热度证据超出时间范围'); continue; }
    } else if (!timely(article.publishedAt, cutoff, 7*24)) { fail('阅读材料超过七天'); continue; }
    used.add(article.url); hashes.add(article.contentHash); events.add(pick.eventKey.toLowerCase().trim()); chosen.push({ article, pick, evidence: pick.kind === 'hot' ? proofs : [] });
  }
  return { chosen, rejected };
}

export async function selectNews(config: RuntimeConfig, model: string, maxRounds: number, candidates: Candidate[], cutoff: Date, recentArticles: object[], remainingSlots = { curated:1,hot:2 }) {
  const articles = new Map<string, Article>(); const evidence = new Map<string, Evidence>();
  const audit: object[] = [];
  const messages: any[] = [{ role: 'system', content: NEWS_SELECTOR_PROMPT }, { role: 'user', content: JSON.stringify({ cutoff: cutoff.toISOString(), timezone: 'Asia/Shanghai', remainingSlots, recentArticles, candidates: candidates.map(({ feedHtml, ...item }) => item) }) }];
  const deadline = Date.now() + 12*60000;
  let selection: NewsSelection | undefined;
  for (let round = 0; round < maxRounds; round++) {
    const finalRound = round === maxRounds-1;
    const response = await fetch(`${config.apiUrl.replace(/\/$/,'')}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model, messages, tools, tool_choice: finalRound ? 'none' : 'auto', ...(finalRound ? { response_format: { type: 'json_object' } } : {}) }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(120000, deadline-Date.now()))),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`News AI HTTP ${response.status}`); }
    const data = await response.json() as any; const message = data.choices?.[0]?.message;
    if (!message) throw new Error('News AI returned no message');
    messages.push(message);
    if (!message.tool_calls?.length) {
      try { selection = NewsSelectionSchema.parse(JSON.parse(String(message.content).replace(/^```(?:json)?\s*|\s*```$/g,''))); break; }
      catch { messages.push({ role:'user', content:'输出未通过 JSON schema 检查。请按 system 中的 JSON 格式输出；不要输出正文。' }); continue; }
    }
    const results = await Promise.allSettled(message.tool_calls.map(async (call: any) => {
      const args = JSON.parse(call.function.arguments);
      if (call.function.name === 'read_article') {
        const candidate = candidates.find(item => item.id === args.candidateId);
        if (!candidate) throw new Error('Unknown candidate');
        const article = articles.get(candidate.id) || await readArticle(candidate); articles.set(candidate.id, article);
        const { feedHtml, ...plain } = article; return plain;
      }
      if (call.function.name === 'search_news' && typeof args.query === 'string' && args.query.length >= 3) {
        const results = await searchNews(args.query, cutoff); for (const item of results) evidence.set(item.id,item); return results;
      }
      throw new Error('Unknown tool or invalid arguments');
    }));
    results.forEach((result,index) => {
      const call = message.tool_calls[index];
      const value = result.status === 'fulfilled' ? result.value : { error: result.reason?.message || 'Tool failed' };
      audit.push({ tool: call.function.name, args: call.function.arguments, result: value });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(value) });
    });
    if (Date.now() >= deadline) throw new Error('News selection exceeded its time budget');
  }
  if (!selection) throw new Error('News AI did not return a valid selection');
  return { selection, articles, evidence, audit };
}

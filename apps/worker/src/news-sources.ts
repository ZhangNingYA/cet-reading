import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { timely } from '@cet-reading/contracts/news';

type NewsSource = { name: string; host: string; hosts?: readonly string[]; feed: string; license: string; licenseUrl: string; policy: string; policyText?: string; articleLicenseText?: string };
export const sources: readonly NewsSource[] = [
  { name: '360info', host: '360info.org', feed: 'https://360info.org/feed/', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', policy: 'https://360info.org/about-us/what-we-do/' },
  { name: 'Global Voices', host: 'globalvoices.org', feed: 'https://globalvoices.org/feed/', license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/', policy: 'https://globalvoices.org/about/global-voices-attribution-policy/' },
  { name: 'EFF', host: 'www.eff.org', feed: 'https://www.eff.org/rss/updates.xml', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', policy: 'https://www.eff.org/copyright' },
  { name: 'Futurity', host: 'www.futurity.org', feed: 'https://www.futurity.org/feed/', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', policy: 'https://www.futurity.org/about/', policyText: 'All of Futurity’s articles can be republished under the Creative Commons 4.0 license', articleLicenseText: 'You are free to share this article under the Attribution 4.0 International license.' },
  { name: 'SciDev.Net', host: 'www.scidev.net', feed: 'https://www.scidev.net/global/rss.xml/?type=header', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0/', policy: 'https://www.scidev.net/global/content/media.html' },
  { name: 'NASA', host: 'www.nasa.gov', hosts: ['www.nasa.gov', 'science.nasa.gov'], feed: 'https://www.nasa.gov/news-release/feed/', license: 'NASA educational use', licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/', policy: 'https://www.nasa.gov/nasa-brand-center/images-and-media/', policyText: 'NASA content used in a factual manner that does not imply endorsement may be used without needing explicit permission.' },
];
export type Candidate = { id: string; title: string; url: string; author: string; publishedAt: string; source: NewsSource; feedHtml: string; excerpt: string };
export type Article = Candidate & { paragraphs: string[]; contentHash: string; wordCount: number; fetchedAt: string; pagePublishedAt: string | null };
export type Evidence = { id: string; title: string; url: string; publisher: string; publisherUrl: string; publishedAt: string; query: string; fetchedAt: string };
const xml = new XMLParser({ ignoreAttributes: false, processEntities: true });
const clean = (text: string) => text.replace(/\s+/gu, ' ').trim();
const comparable = (text: string) => clean(text).normalize('NFKC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"');
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export async function fetchText(url: string, hosts: readonly string[], limit = 2_000_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    for (let redirects = 0; redirects < 4; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || !hosts.includes(parsed.hostname)) throw new Error('Unapproved source URL');
      const response = await fetch(parsed, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'CET-Reading/1.0 (+https://cet.fulafu.com/news/)', Accept: 'application/rss+xml,text/html,application/xml;q=0.9' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { url = new URL(response.headers.get('location') || '', parsed).href; continue; }
      if (!response.ok || !response.body) throw new Error(`Source HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('Source response too large'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new Error('Source response too large'); } chunks.push(value); }
      return Buffer.concat(chunks).toString('utf8');
    }
    throw new Error('Too many source redirects');
  } finally { clearTimeout(timer); }
}

export function plainParagraphs(html: string) {
  const $ = load(html);
  $('script,style,noscript,figure,figcaption,iframe,form,nav,textarea,.wp-caption,.sharedaddy,.gv-syndication-notice,.related-articles,.related-posts,.hds-topic-cards,.hds-featured-link-list,.hds-news-grid').remove();
  return $('p,h2,h3,li').filter((_, el) => !$(el).parents('li,p').length).map((_, el) => clean($(el).text())).get().filter(Boolean)
    .filter(text => !/^(Originally published under Creative Commons|This article was originally published|Read the original article|The post .+ appeared first on)/i.test(text));
}

function editorialParagraphs(html: string, source: NewsSource) {
  const paragraphs = plainParagraphs(html);
  if (source.name !== 'NASA') return paragraphs;
  const end = paragraphs.findIndex(text=> /^(?:Downloads & Related Information|Explore More|Keep Exploring|Related Links|Related Topics|Related Terms|About the Author|[-–—]\s*end\s*[-–—])$/i.test(text));
  return end < 0 ? paragraphs : paragraphs.slice(0,end);
}

export function parseCandidates(raw: string, source: NewsSource, cutoff: Date): Candidate[] {
  const items = xml.parse(raw)?.rss?.channel?.item ?? [];
  return (Array.isArray(items) ? items : [items]).flatMap((item: Record<string, unknown>) => {
    const date = new Date(String(item.pubDate));
    if (Number.isNaN(date.getTime()) || !timely(date.toISOString(), cutoff, 7 * 24)) return [];
    let url: URL; try { url = new URL(String(item.link)); } catch { return []; } url.hash = ''; url.search = '';
    if (!(source.hosts || [source.host]).includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password || url.port) return [];
    const html = String(item['content:encoded'] || item.description || '');
    const title = clean(load(String(item.title)).text());
    return [{ id: digest(url.href).slice(0,16), title, url: url.href, author: clean(String(item['dc:creator'] || source.name)), publishedAt: date.toISOString(), source, feedHtml: html, excerpt: plainParagraphs(html).join(' ').slice(0,1800) }];
  });
}

export async function loadCandidates(cutoff: Date) {
  const failures: string[] = [];
  const result = await Promise.allSettled(sources.map(async source => {
    const policy = await fetchText(source.policy, [source.host]);
    const $ = load(policy); const licensePath = new URL(source.licenseUrl).pathname;
    const licensed = source.policyText ? clean($.text()).includes(source.policyText) : $('a[href]').toArray().some(link=>{
      try { const url = new URL($(link).attr('href')!,source.policy); return url.hostname==='creativecommons.org' && url.pathname.replace(/\/deed(?:\.[a-z]+)?$/,'/')===licensePath; } catch { return false; }
    });
    if (!licensed) throw new Error('Expected reuse permission cannot be verified on the source policy');
    return parseCandidates(await fetchText(source.feed, [source.host]), source, cutoff);
  }));
  const candidates: Candidate[] = [];
  result.forEach((item, index) => { if (item.status === 'fulfilled') candidates.push(...item.value); else failures.push(`${sources[index]!.name}: ${item.reason?.message || 'fetch failed'}`); });
  return { candidates: candidates.sort((a,b) => b.publishedAt.localeCompare(a.publishedAt)), failures };
}

export async function readArticle(candidate: Candidate): Promise<Article> {
  const page = await fetchText(candidate.url, candidate.source.hosts || [candidate.source.host]);
  const $ = load(page);
  if (candidate.source.articleLicenseText && !clean($.text()).includes(candidate.source.articleLicenseText)) throw new Error('Article-specific CC BY permission is missing');
  const body = candidate.source.name === 'EFF' ? $('.field-name-body,.field--name-body,.node-content .field-type-text-with-summary,.node-blog .field-item,.node .field-item').first()
    : candidate.source.name === 'Global Voices' ? $('.post .entry,.entry-container .entry').first()
    : candidate.source.name === 'Futurity' ? $('.article-content .stickem-container').first().clone()
    : candidate.source.name === 'SciDev.Net' ? $('.fl-module-fl-post-content .fl-module-content').first().clone()
    : $('.main-copy,.entry-content').first();
  // Remove presentation widgets before comparing text; image licenses do not license the article text.
  body.find('figure,figcaption,.wp-caption,textarea,.related-articles,.related-posts,.sharing,.share-buttons').remove();
  const originParagraphs = editorialParagraphs(body.html() || '',candidate.source);
  const feedParagraphs = editorialParagraphs(candidate.feedHtml,candidate.source);
  // SciDev's official feed is headline-only. NASA feeds include unrelated download/mission widgets.
  // Publish the full origin editorial body for these adapters, and verify NASA against its feed.
  const paragraphs = ['SciDev.Net','NASA'].includes(candidate.source.name) ? originParagraphs : feedParagraphs;
  if (paragraphs.length < 5) throw new Error('Incomplete or very short feed body');
  if (!body.length) throw new Error('Original article body selector is unavailable');
  const pageText = comparable(originParagraphs.join(' '));
  const substantive = feedParagraphs.filter(text => text.split(/\s+/).length >= 8);
  if (candidate.source.name !== 'SciDev.Net') {
    if (!substantive.length || substantive.filter(text => pageText.includes(comparable(text))).length / substantive.length < .9) throw new Error('Feed body does not match the original page');
    const originSubstantive = originParagraphs.filter(text => text.split(/\s+/).length >= 8);
    const feedText = comparable(feedParagraphs.join(' '));
    if (originSubstantive.filter(text => feedText.includes(comparable(text))).length / Math.max(1,originSubstantive.length) < .9) throw new Error('Feed omits a substantial part of the original body');
  }
  const rightsText = clean(body.length ? body.text() : $('article').first().text());
  if (/all rights reserved|permission (?:is )?required|not (?:be )?(?:republished|reproduced)|CC BY[\s-]*(?:NC[\s-]*)?ND/i.test(rightsText)) throw new Error('Article has a conflicting license exception');
  if (candidate.source.name === 'Global Voices' && /originally published (?:by|on|in)|first appeared|republished (?:from|with permission|on)|content partnership agreement/i.test(rightsText) && !/Creative Commons/i.test(rightsText)) throw new Error('Syndicated article needs separate rights verification');
  const pageDate = $('meta[property="article:published_time"]').attr('content');
  const pagePublishedAt = pageDate && !Number.isNaN(Date.parse(pageDate)) ? new Date(pageDate).toISOString() : null;
  if (pagePublishedAt && Math.abs(Date.parse(pagePublishedAt)-Date.parse(candidate.publishedAt)) > 86400000) throw new Error('Origin and feed publication dates disagree');
  let author = candidate.author;
  if (candidate.source.name === '360info') {
    const authors = $('.post-authors').filter((_,el) => /^Authors\b/.test(clean($(el).text()))).first().clone();
    authors.find('span').remove(); authors.find('br').replaceWith('\n');
    const names = authors.text().split('\n').map(clean).filter(text=>text && !/University|School|Institute|College/i.test(text));
    if (names.length) author = names.join('; ');
  }
  if (candidate.source.name === 'NASA') author = $('meta[name="parsely-author"]').attr('content') || (/^[a-z]+\d+$|^HQ Web Team$/.test(author) ? 'NASA' : author);
  const wordCount = paragraphs.join(' ').match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)?.length ?? 0;
  if (wordCount < 350 || wordCount > 3500) throw new Error(`Unsuitable article length: ${wordCount}`);
  return { ...candidate, author, paragraphs, wordCount, contentHash: digest(paragraphs.join('\n\n')), fetchedAt: new Date().toISOString(), pagePublishedAt };
}

export async function searchNews(query: string, cutoff: Date): Promise<Evidence[]> {
  const day = (date: Date) => date.toISOString().slice(0,10);
  // Calendar words become required search terms and can hide reports filed one day earlier.
  const months = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
  const keywords = query.slice(0,240).replace(new RegExp(`\\b${months}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?\\b`,'gi'),' ')
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/g,' ').replace(/\b(?:after|before|when):\S+/gi,' ').replace(/\s+/g,' ').trim();
  if (keywords.length < 3) throw new Error('Use event keywords instead of a date');
  const q = `${keywords} after:${day(new Date(cutoff.getTime()-3*86400000))} before:${day(new Date(cutoff.getTime()+86400000))}`;
  const url = new URL('https://news.google.com/rss/search'); url.search = new URLSearchParams({ q, hl: 'en-US', gl: 'US', ceid: 'US:en' }).toString();
  const items = xml.parse(await fetchText(url.href, ['news.google.com']))?.rss?.channel?.item ?? [];
  return (Array.isArray(items) ? items : [items]).flatMap((item: any) => {
    const date = new Date(String(item.pubDate)); if (Number.isNaN(date.getTime()) || !timely(date.toISOString(), cutoff, 48)) return [];
    const publisher = String(item.source?.['#text'] || ''); const publisherUrl = String(item.source?.['@_url'] || '');
    const link = String(item.link); if (!publisher || !/^https:\/\//.test(publisherUrl) || !link.startsWith('https://news.google.com/')) return [];
    return [{ id: digest(link).slice(0,16), title: clean(String(item.title)), url: link, publisher, publisherUrl, publishedAt: date.toISOString(), query, fetchedAt: new Date().toISOString() }];
  }).slice(0,20);
}

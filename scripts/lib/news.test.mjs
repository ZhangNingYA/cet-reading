import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { NEWS_ARTICLES_PER_SLOT, NewsSelectionSchema, newsDay, newsSlot, nextNewsSlot, splitNewsParagraph, timely } from '@cet-reading/contracts/news';
const { sources, parseCandidates, plainParagraphs, fetchText, readArticle, searchNews } = await tsImport('../../apps/worker/src/news-sources.ts',import.meta.url);
const { validateNewsPicks, selectNews } = await tsImport('../../apps/worker/src/news-selector.ts',import.meta.url);
const cutoff = new Date('2026-10-09T00:00:00Z');
const candidate = { id:'c1', title:'A genuine article', url:'https://360info.org/example/',author:'An author',publishedAt:'2026-10-08T10:00:00Z',source:sources[0],feedHtml:'',excerpt:'' };
const article = { ...candidate, paragraphs:['An authentic paragraph.'],contentHash:'hash1',wordCount:800 };
const pick = { candidateId:'c1', kind:'hot', difficulty:'NEEP', difficultyReason:'具体指出复杂句式与词汇的阅读难度。', topic:'科技',eventKey:'a-genuine-new-event',eventAt:'2026-10-08T12:00:00Z',evidenceIds:['e1','e2'],reason:'两家不同媒体核实了最近出现的事件。' };
const evidence = new Map(['e1','e2'].map((id,i)=>[id,{ id,publishedAt:'2026-10-08T15:00:00Z',publisherUrl:`https://${i?'second':'first'}.example`,title:'A genuine event' }]));
const validate = (selection, articles=new Map([['c1',article]]),proofs=evidence,events=new Set())=>validateNewsPicks({selections:selection,shortfall:''},articles,proofs,cutoff,events);

test('each news slot accepts at most one selected article',()=>{
  assert.equal(NEWS_ARTICLES_PER_SLOT,1);
  assert.equal(NewsSelectionSchema.safeParse({selections:[pick],shortfall:''}).success,true);
  assert.equal(NewsSelectionSchema.safeParse({selections:[pick,{...pick,candidateId:'c2'}],shortfall:''}).success,false);
});

test('news slots use Shanghai time, survive UTC date boundaries and roll over after 17:00',()=>{
  assert.equal(newsDay(new Date('2026-10-08T16:01:00Z')),'2026-10-09');
  assert.equal(newsSlot('2026-10-09',8).toISOString(),'2026-10-09T00:00:00.000Z');
  assert.equal(nextNewsSlot(cutoff).toISOString(),'2026-10-09T03:00:00.000Z');
  assert.equal(nextNewsSlot(new Date('2026-10-09T09:00:00Z')).toISOString(),'2026-10-10T00:00:00.000Z');
  assert.throws(()=>newsSlot('2026-02-30',8)); assert.throws(()=>newsSlot('2026-10-09',2));
});
test('publication and evidence age reject future news, missing dates and stale reprints',()=>{
  assert.equal(timely('2026-10-09T01:00:00Z',cutoff,48),false);
  assert.equal(timely('invalid',cutoff,48),false);
  assert.equal(timely('2026-10-07T00:00:00Z',cutoff,48),true);
  assert.equal(validate([{...pick,eventAt:'2026-09-01T00:00:00Z'}]).chosen.length,0);
});
test('source feeds drop future stories and preserve original link words without scripts or captions',()=>{
  const raw=`<rss><channel><item><title>A real story</title><link>https://360info.org/real/?utm_source=rss</link><pubDate>Thu, 08 Oct 2026 10:00:00 GMT</pubDate><content:encoded><![CDATA[<p>Keep <a href="https://example.org">these words</a>.</p>]]></content:encoded></item><item><title>Future</title><link>https://360info.org/future/</link><pubDate>Fri, 09 Oct 2026 01:00:00 GMT</pubDate></item></channel></rss>`;
  const found=parseCandidates(raw,sources[0],cutoff);assert.equal(found.length,1);assert.equal(found[0].url,'https://360info.org/real/');
  assert.deepEqual(plainParagraphs('<p>Keep <a>these words</a>.</p><script>bad()</script><figure><figcaption>Credit</figcaption></figure><h2>Heading</h2><ul><li>A <b>list</b> item</li></ul>'),['Keep these words.','Heading','A list item']);
});
test('hot selections require verified body reads, real independent proof IDs and fresh event timestamps',()=>{
  assert.equal(validate([pick]).chosen.length,1);
  assert.equal(validate([pick],new Map()).chosen.length,0);
  assert.equal(validate([{...pick,evidenceIds:['invented','e2']}]).chosen.length,0);
  const same = new Map(evidence);same.set('e2',{...same.get('e2'),publisherUrl:'https://www.first.example'});
  assert.equal(validate([pick],undefined,same).chosen.length,0);
  assert.equal(validate([{...pick,eventAt:null}]).chosen.length,0);
});
test('related NASA sites and Future science publications cannot supply two independent proofs',()=>{
  for (const urls of [['https://www.nasa.gov','https://science.nasa.gov'],['https://www.space.com','https://www.livescience.com']]) {
    const proofs=new Map([...evidence].map(([id,item],i)=>[id,{...item,publisherUrl:urls[i]}]));
    assert.equal(validate([pick],undefined,proofs).chosen.length,0);
    proofs.set('e2',{...proofs.get('e2'),publisherUrl:'https://www.theguardian.com'});
    assert.equal(validate([pick],undefined,proofs).chosen.length,urls[0].includes('nasa.gov')?0:1);
  }
});
test('primary agency or university announcements do not substitute for two independent news reports',()=>{
  for(const url of ['https://science.nasa.gov','https://www.noaa.gov','https://news.ucsc.edu','https://www.manchester.ac.uk','https://www.eurekalert.org']) {
    const proofs=new Map(evidence);proofs.set('e1',{...proofs.get('e1'),publisherUrl:url});
    assert.equal(validate([pick],undefined,proofs).chosen.length,0);
    proofs.set('e3',{...proofs.get('e2'),id:'e3',publisherUrl:'https://www.theguardian.com'});
    assert.equal(validate([{...pick,evidenceIds:['e1','e2','e3']}],undefined,proofs).chosen.length,1);
  }
});
test('identical bodies, URLs and recent events cannot fill a batch twice',()=>{
  const a2={...article,id:'c2',url:'https://360info.org/other/'};const map=new Map([['c1',article],['c2',a2]]);
  assert.equal(validate([pick,{...pick,candidateId:'c2',eventKey:'different-event'}],map).chosen.length,1);
  assert.equal(validate([pick],undefined,undefined,new Set(['a-genuine-new-event'])).chosen.length,0);
  assert.equal(validate([{...pick,kind:'curated',eventAt:null,evidenceIds:[]}],undefined,new Map()).chosen.length,1);
});
test('source reads refuse local URLs and redirects outside the source allowlist',async t=>{
  await assert.rejects(fetchText('http://127.0.0.1/private',['127.0.0.1']),/Unapproved/);
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://attacker.example/private'}});});
  await assert.rejects(fetchText('https://360info.org/real/',['360info.org']),/Unapproved/);assert.equal(calls,1);
});
test('article validation rejects a partial feed rather than publishing it as a full original',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('<article><p>Full original exists here.</p></article>'));
  await assert.rejects(readArticle({...candidate,feedHtml:'<p>Short teaser.</p>'}),/Incomplete/);
});
const fullParagraphs=Array.from({length:6},(_,i)=>`Paragraph ${i+1}: `+Array.from({length:65},(_,j)=>`word${i}_${j}`).join(' ')+" Scientists don't treat this result as established fact.");
const fullBody=fullParagraphs.map(p=>`<p>${p}</p>`).join('');
test('NASA reads preserve full origin text, tolerate typographic feed differences and omit navigation widgets',async t=>{
  const source=sources.find(s=>s.name==='NASA');
  const page=`<div class="entry-content">${fullBody}<h2>Downloads &amp; Related Information</h2><p>Download instructions.</p></div>`;
  t.mock.method(globalThis,'fetch',async()=>new Response(page));
  const a=await readArticle({...candidate,url:'https://science.nasa.gov/example/',source,feedHtml:fullBody.replaceAll("don't","don’t")+'<h2>Downloads &amp; Related Information</h2><p>Download instructions.</p><div class="hds-topic-cards"><p>An unrelated mission description.</p></div>'});
  assert.deepEqual(a.paragraphs,fullParagraphs);assert.equal(a.source.license,'NASA educational use');
  await assert.rejects(readArticle({...candidate,url:'https://science.nasa.gov/example/',source,feedHtml:fullParagraphs.slice(0,3).map(p=>`<p>${p}</p>`).join('')}),/omits a substantial/);
});
test('Futurity requires the article-specific Attribution 4.0 declaration',async t=>{
  const source=sources.find(s=>s.name==='Futurity');
  let permission=false;
  t.mock.method(globalThis,'fetch',async()=>new Response(`${permission?'<aside>'+source.articleLicenseText+'</aside>':''}<div class="article-content"><div class="stickem-container">${fullBody}</div></div>`));
  const c={...candidate,url:'https://www.futurity.org/example/',source,feedHtml:fullBody};
  await assert.rejects(readArticle(c),/permission is missing/);permission=true;
  assert.deepEqual((await readArticle(c)).paragraphs,fullParagraphs);
});
test('SciDev headline feeds resolve to the entire original and exclude image rights and embedded copies',async t=>{
  const source=sources.find(s=>s.name==='SciDev.Net');
  let exception=false;
  t.mock.method(globalThis,'fetch',async()=>new Response(`<div class="fl-module-fl-post-content"><div class="fl-module-content">${fullBody}<div class="wp-caption"><p>Image CC BY-NC-ND</p></div><textarea>${fullBody}</textarea>${exception?'<p>All rights reserved. Permission required.</p>':''}</div></div>`));
  const c={...candidate,url:'https://www.scidev.net/global/news/example/',source,feedHtml:'<p>A short teaser.</p>'};
  assert.deepEqual((await readArticle(c)).paragraphs,fullParagraphs);exception=true;
  await assert.rejects(readArticle(c),/conflicting license/);
});
test('NASA feed permits its explicit science host and rejects arbitrary hosts and malformed links',()=>{
  const source=sources.find(s=>s.name==='NASA');
  const items=['https://science.nasa.gov/new/','https://fake.nasa.gov/new/','https://attacker.example/new/','not a URL'].map(link=>`<item><title>News</title><link>${link}</link><pubDate>Thu, 08 Oct 2026 10:00:00 GMT</pubDate></item>`).join('');
  assert.deepEqual(parseCandidates(`<rss><channel>${items}</channel></rss>`,source,cutoff).map(c=>c.url),['https://science.nasa.gov/new/']);
});
test('AI selects using actual tool results and cannot silently substitute its own article body',async t=>{
  let calls=0;const requests=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const req=JSON.parse(options.body);requests.push(req);
    const message=++calls===1?{ role:'assistant',tool_calls:[{id:'call1',type:'function',function:{name:'read_article',arguments:'{"candidateId":"unknown"}'}}] }
      :{ role:'assistant',content:JSON.stringify({ selections:[{...pick,kind:'curated',eventAt:null,evidenceIds:[]}],shortfall:'授权候选不足。' }) };
    return new Response(JSON.stringify({choices:[{message}]}));
  });
  const result=await selectNews({apiUrl:'https://model.example/v1',apiKey:'test'},'test-model',3,[candidate],cutoff,[]);
  assert.equal(requests[1].messages.at(-1).role,'tool');assert.match(requests[1].messages.at(-1).content,/Unknown candidate/);
  assert.equal(validateNewsPicks(result.selection,result.articles,result.evidence,cutoff,new Set()).chosen.length,0);
});
test('news sentence segmentation retains every original character except surrounding whitespace',()=>{
  const text='Dr. Smith said, “This is a new study.” However, the result remains uncertain.';
  assert.equal(splitNewsParagraph(text).join(' ').replace(/\s/g,''),text.replace(/\s/g,''));
});
test('live news search applies one time window without requiring literal calendar words in headlines',async t=>{
  let captured;t.mock.method(globalThis,'fetch',async(url)=>{captured=new URL(url);return new Response('<rss><channel></channel></rss>');});
  assert.deepEqual(await searchNews('October 8 2026 Alibaba Pentagon lawsuit before:2001-01-01',cutoff),[]);
  const query=captured.searchParams.get('q');assert.match(query,/Alibaba Pentagon lawsuit/);assert.doesNotMatch(query,/October|2001/);assert.match(query,/after:2026-10-06 before:2026-10-10/);
});
test('fresh database initialization and existing database migration share the news schema',()=>{
  assert.equal(readFileSync('db/init/014_news.sql','utf8'),readFileSync('db/migrations/014_news.sql','utf8'));
});

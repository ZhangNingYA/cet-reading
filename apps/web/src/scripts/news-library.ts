import { mountIntensive } from './intensive-reader';

const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const library = node<HTMLElement>('news-library'); const reader = node<HTMLElement>('news-reader');
const list = node<HTMLElement>('news-list'); const status = node<HTMLElement>('news-status');
const search = node<HTMLInputElement>('news-search'); const more = node<HTMLButtonElement>('news-more'); const retry = node<HTMLButtonElement>('news-retry');
const apiBase = library.dataset.apiBase || '';
type Progress = { analysis_total?:number; analysis_cached?:number; analysis_pending?:number; analysis_running?:number; analysis_failed?:number };
type Summary = Progress & { id:string; title:string; source_name:string; batch_at:string; published_at:string; selection_kind:string; topic:string; difficulty:string; word_count:number };
type Batch = { scheduled_at:string; status:string; reason:string; article_count:number };
let articles: Summary[] = []; let batches: Batch[] = []; let cursor: string | null = null;
let dispose: (()=>void) | undefined; let viewRequest=0; let activeArticleId:string|null=null;
const date = (time: string, options: Intl.DateTimeFormatOptions = {}) => new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',...options}).format(new Date(time));
const difficulty = (value:string) => ({ CET6:'六级',NEEP:'考研',advanced:'进阶' }[value] || value);
function element<K extends keyof HTMLElementTagNameMap>(tag:K,className:string,text?:string) { const el=document.createElement(tag); el.className=className; if(text!==undefined) el.textContent=text; return el; }
function progressText(value: Progress, empty = '') {
  const total=Number(value.analysis_total??0); const cached=Math.min(total,Number(value.analysis_cached??0));
  if (!total) return empty;
  const states:string[]=[];
  const pending=Number(value.analysis_pending??0); const running=Number(value.analysis_running??0); const failed=Number(value.analysis_failed??0);
  if (pending) states.push(`${pending} 条排队`);
  if (running) states.push(`${running} 条生成中`);
  if (failed) states.push(`${failed} 条失败`);
  const percentage=((cached/total)*100).toFixed(1);
  return `精读缓存 ${cached}/${total}（${percentage}%）${states.length?` · ${states.join(' · ')}`:''}`;
}
async function json(path:string) {
  const response=await fetch(`${apiBase}${path}`,{signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('request failed'); return response.json();
}
function render() {
  const query=search.value.trim().toLowerCase(); const visible=articles.filter(item=>`${item.title} ${item.topic} ${item.source_name}`.toLowerCase().includes(query));
  list.replaceChildren(); list.setAttribute('aria-busy','false'); node('news-count').textContent=visible.length?`${visible.length} 篇`:'';
  const dayKey=(time:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
  const days=[...new Set(batches.map(batch=>dayKey(batch.scheduled_at)))].sort().reverse();
  for(const day of days) {
    if(query&&!visible.some(article=>dayKey(article.batch_at)===day))continue;
    const [year,month,dayNumber]=day.split('-');
    const dayGroup=element('section','news-day');
    dayGroup.append(element('h2','news-day-heading',`${year!.slice(-2)}/${Number(month)}/${Number(dayNumber)}`));
    for(const hour of [8,11,14,17]) {
      const slot=new Date(`${day}T${String(hour).padStart(2,'0')}:00:00+08:00`).toISOString();
      const batch=batches.find(item=>item.scheduled_at===slot);
      const entries=visible.filter(item=>item.batch_at===slot); if(query&&!entries.length)continue;
      const group=element('section','news-batch');
      group.append(element('h3','news-batch-heading',`${String(hour).padStart(2,'0')}:00`));
      const body=element('div','news-batch-body');
      for(const article of entries) {
      const link=element('a','news-row'); link.href=`?article=${encodeURIComponent(article.id)}`;
      const title=element('h3','news-row-title',article.title); title.lang='en';
      const progress=progressText(article);
      const meta=element('p','news-row-meta',`${article.selection_kind==='hot'?'热点':'阅读'} · ${article.topic} · ${article.source_name} · ${difficulty(article.difficulty)} · ${article.word_count.toLocaleString()} 词${progress?` · ${progress}`:''}`);
      link.append(title,meta); link.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();void openArticle(article.id,true);}); body.append(link);
      }
      if(batch?.status==='partial'||batch?.status==='failed') {
        const note=element('p','news-batch-note',`${batch.article_count} / 3 篇 · ${batch.status==='failed'?'采集暂未完成':'符合条件的文章不足'}`);
        note.title=batch.reason;body.append(note);
      } else if(batch?.status==='running') body.append(element('p','news-batch-note','正在选取文章…'));
      else if(!entries.length)body.append(element('p','news-batch-note',new Date(slot)>new Date()?'待更新':'暂无文章'));
      group.append(body);dayGroup.append(group);
    }
    list.append(dayGroup);
  }
  if(!list.childElementCount) list.append(element('p','empty-state',query?'没有找到相关文章':'首批文章正在准备中'));
  more.hidden=!cursor; retry.hidden=true; status.classList.add('sr-only'); status.textContent=`已加载 ${visible.length} 篇文章`;
}
async function load(older=false) {
  more.disabled=true;
  try {
    const data=await json(`/api/news${older&&cursor?`?before=${encodeURIComponent(cursor)}`:''}`);
    articles=older?[...articles,...data.articles]:data.articles; batches=older?[...batches,...data.batches]:data.batches;cursor=data.nextCursor;render();
  } catch { status.textContent='文章加载失败，请重试。';status.classList.remove('sr-only');retry.hidden=false;list.setAttribute('aria-busy','false'); }
  finally { more.disabled=false; }
}
async function openArticle(id:string,writeHistory=false) {
  const request=++viewRequest;dispose?.();dispose=undefined;
  if(writeHistory) history.pushState({},'',`?article=${encodeURIComponent(id)}`);
  status.textContent='正在加载文章…'; status.classList.remove('sr-only');
  try {
    const article=await json(`/api/news/${encodeURIComponent(id)}`); if(request!==viewRequest)return;
    activeArticleId=id;
    library.hidden=true;reader.hidden=false;document.body.classList.add('reader-page');
    node('news-title').textContent=article.title;
    node('news-meta').textContent=`${article.selection_kind==='hot'?'热点':'阅读'} · ${article.topic} · ${difficulty(article.difficulty)} · ${article.word_count.toLocaleString()} 词 · ${date(article.published_at)}`;
    node<HTMLElement>('news-analysis-status').textContent=progressText(article,'精读缓存暂未开始');
    const attribution=node('news-attribution'); attribution.replaceChildren(document.createTextNode(`${article.author} · `));
    const source=element('a','',article.source_name);source.href=article.source_url;source.target='_blank';source.rel='noopener noreferrer';
    const license=element('a','',article.license_name);license.href=article.license_url;license.target='_blank';license.rel='noopener noreferrer';
    attribution.append(source,document.createTextNode(' · '),license,document.createTextNode(' · 原文，链接转为文字'));
    const content=node('news-content');content.replaceChildren();
    dispose=mountIntensive(article,apiBase,content,{analysisPath:`/api/news/${encodeURIComponent(id)}/analyses`,hideNavigation:true});
    node('news-title').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});
  } catch { if(request!==viewRequest)return;showList(false);status.textContent='文章暂时无法加载，请返回列表重试。';status.classList.remove('sr-only'); }
}
function showList(writeHistory=true) {
  ++viewRequest;activeArticleId=null;dispose?.();dispose=undefined;reader.hidden=true;library.hidden=false;document.body.classList.remove('reader-page');
  if(writeHistory)history.pushState({},'',location.pathname);status.classList.add('sr-only');
}
async function refreshProgress() {
  if (document.visibilityState==='hidden') return;
  try {
    const data=await json('/api/news');
    const freshArticles:Summary[]=data.articles??[]; const freshBatches:Batch[]=data.batches??[];
    const freshArticleIds=new Set(freshArticles.map(article=>article.id));
    const freshBatchIds=new Set(freshBatches.map(batch=>batch.scheduled_at));
    articles=[...freshArticles,...articles.filter(article=>!freshArticleIds.has(article.id))];
    batches=[...freshBatches,...batches.filter(batch=>!freshBatchIds.has(batch.scheduled_at))];
    if (!cursor) cursor=data.nextCursor??null;
    if (activeArticleId) {
      const current=articles.find(article=>article.id===activeArticleId);
      if (current) node<HTMLElement>('news-analysis-status').textContent=progressText(current,'精读缓存暂未开始');
      else {
        const detail=await json(`/api/news/${encodeURIComponent(activeArticleId)}`);
        if (activeArticleId) node<HTMLElement>('news-analysis-status').textContent=progressText(detail,'精读缓存暂未开始');
      }
    }
    render();
  } catch {
    // Progress is supplementary; keep the current list when a poll fails.
  }
}
function restore() {const id=new URL(location.href).searchParams.get('article');if(id)void openArticle(id);else showList(false);}
node('news-back').addEventListener('click',()=>showList());search.addEventListener('input',render);more.addEventListener('click',()=>void load(true));retry.addEventListener('click',()=>void load());
window.addEventListener('popstate',restore);void load();restore();setInterval(()=>{void refreshProgress();},15_000);

// The競馬 EV分析 - Always-on Odds Timeline Collector v6.1.4
// Cloudflare Worker + Durable Object
// Device 0 / iPad offでも時系列オッズ収集を継続するためのコンパニオンWorker。
//
// 必要bindings:
//   Durable Object namespace: TIMELINE -> OddsTimelineCollector
// 任意vars:
//   UPSTREAM_PROXY_URL   既存のThe競馬プロキシWorker URL
//   MANIFEST_SOURCE_URL  既存Cron Worker URL（/cron-status?date=YYYY-MM-DDを持つ）
//   TIMELINE_TOKEN       書込/停止API保護用（空なら保護なし）
//
// Cron: * * * * *  (1分ごとに当日manifestを確認し、発走90分前〜10分後のレースを自動起動)

const VERSION = 'v6.1.4 AlwaysOnTimeline DO';
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_START_BEFORE_MS = 90 * 60 * 1000;
const DEFAULT_END_AFTER_MS = 10 * 60 * 1000;
const MAX_RECORDS = 5000;
const MARKET_TYPES = ['単勝','複勝','枠連','ワイド','馬連','馬単','3連複','3連単'];

function cors(extra={}) {
  return {
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,X-Timeline-Token,X-Snapshot-Token',
    'Cache-Control':'no-store',
    ...extra
  };
}
function json(data,status=200){ return new Response(JSON.stringify(data),{status,headers:cors({'Content-Type':'application/json; charset=UTF-8'})}); }
function text(s,status=200,ct='text/plain; charset=UTF-8'){ return new Response(s,{status,headers:cors({'Content-Type':ct})}); }
function tokenOk(req,env){
  const want=String(env.TIMELINE_TOKEN||''); if(!want) return true;
  const got=req.headers.get('X-Timeline-Token')||req.headers.get('X-Snapshot-Token')||'';
  return got===want;
}
function jstParts(ms=Date.now()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(ms));
  const o={}; for(const p of parts)o[p.type]=p.value;
  return o;
}
function jstYmd(ms=Date.now()){ const p=jstParts(ms); return `${p.year}-${p.month}-${p.day}`; }
function timeMsOnJstDate(date,hhmm){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||!/^\d{1,2}:\d{2}$/.test(String(hhmm))) return NaN;
  const [h,m]=String(hhmm).split(':').map(Number);
  return new Date(`${date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+09:00`).getTime();
}
function stripTags(s){
  return decodeHtml(String(s||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]+>/g,' ').replace(/[\t\r\n]+/g,' ').replace(/[　 ]+/g,' ').trim());
}
function decodeHtml(s){
  return String(s||'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&#x27;/gi,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)||32));
}
function half(s){ return String(s||'').replace(/[０-９．－]/g,c=>({'０':'0','１':'1','２':'2','３':'3','４':'4','５':'5','６':'6','７':'7','８':'8','９':'9','．':'.','－':'-'}[c]||c)); }
function decimals(s){ return [...half(s).matchAll(/(?:^|[^\d])(\d{1,6}(?:,\d{3})*\.\d+)(?!\d)/g)].map(m=>Number(m[1].replace(/,/g,''))).filter(Number.isFinite); }
function rangeLow(s){ const t=half(s).replace(/[〜～~]/g,'-'); const m=t.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/); return m?Math.min(Number(m[1]),Number(m[2])):0; }
function intsNoOdds(s){ let t=half(stripTags(s)); t=t.replace(/\d{1,6}(?:,\d{3})*\.\d+(?:\s*[-〜～~]\s*\d{1,6}(?:,\d{3})*\.\d+)?/g,' '); return (t.match(/\b\d{1,2}\b/g)||[]).map(Number); }
function keyNums(type,nums){ const a=(nums||[]).map(Number).filter(n=>n>0&&Number.isFinite(n)); if(['馬連','ワイド','枠連','3連複'].includes(type))a.sort((x,y)=>x-y); return a.join('-'); }
function newMarkets(){ const x={}; MARKET_TYPES.forEach(t=>x[t]=new Map()); return x; }
function put(markets,type,nums,odds){ const o=Number(odds); if(!markets[type]||!Number.isFinite(o)||o<1)return; const k=keyNums(type,nums); if(k)markets[type].set(k,Math.round(o*10)/10); }
function serializeMarkets(markets){ const out={}; for(const t of MARKET_TYPES){ const a=[]; const m=markets[t]; if(m)m.forEach((odds,combination)=>a.push({combination:String(combination),odds:Number(odds)})); a.sort((x,y)=>x.odds-y.odds||x.combination.localeCompare(y.combination)); if(a.length)out[t]=a; } return out; }

// Browser版parseAllMarkets202の考え方をWorker向けの軽量regex parserへ移植。
// DOMParserを使わず、table/tr/td と見出しテキストから券種を判定する。
function parseAllMarketsHtml(html){
  const markets=newMarkets();
  const src=String(html||'').replace(/<!--[\s\S]*?-->/g,' ');
  const tables=[...src.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)];
  for(const tm of tables){
    const attrs=String(tm[1]||''); const body=String(tm[2]||'');
    const pos=tm.index||0; const before=stripTags(src.slice(Math.max(0,pos-1000),pos));
    const tt=stripTags(body); if(!tt)continue;
    const ctx=(attrs+' '+before.slice(-700)+' '+tt.slice(0,450));
    const rows=[...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]);

    const isWinPlace=/odds_tan|単勝オッズ|\bTan\b/i.test(attrs+' '+ctx) || (/単勝/.test(ctx)&&/複勝/.test(ctx)&&(/馬名|人気/.test(tt)));
    if(isWinPlace){
      for(const row of rows){
        const cells=[...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map(m=>({attrs:m[1]||'',html:m[2]||'',text:stripTags(m[2]||'')}));
        if(!cells.length)continue;
        let no=0;
        for(const c of cells){ if(/Umaban|umaban|Horse_Num|HorseNum/i.test(c.attrs)){ const m=half(c.text).match(/\b(\d{1,2})\b/); if(m){no=Number(m[1]);break;} } }
        if(!no){ const ints=intsNoOdds(row).filter(n=>n>=1&&n<=18); if(ints.length)no=ints[Math.min(ints.length-1,1)]; }
        if(!(no>=1&&no<=18))continue;
        let win=0,place=0;
        for(const c of cells){
          const low=rangeLow(c.text); if(low>=1&&!place)place=low;
          const m=half(c.text).replace(/[,倍\s]/g,'').match(/^(\d{1,6}\.\d+)$/); if(m&&!win){ const v=Number(m[1]); if(v>=1&&v<9999999)win=v; }
        }
        if(win)put(markets,'単勝',[no],win);
        if(place)put(markets,'複勝',[no],place);
      }
      continue;
    }

    let kind='';
    if(/馬連[^]{0,40}ワイド|馬連・ワイド|馬連\/ワイド/.test(ctx))kind='PAIR_BOTH';
    else if(/3連単|３連単/.test(ctx))kind='3連単';
    else if(/3連複|３連複/.test(ctx))kind='3連複';
    else if(/馬単/.test(ctx))kind='馬単';
    else if(/枠連/.test(ctx)&&!/枠単/.test(ctx))kind='枠連';
    else if(/馬連/.test(ctx))kind='馬連';
    else if(/ワイド/.test(ctx))kind='ワイド';
    if(!kind)continue;
    const arity=(kind==='3連複'||kind==='3連単')?3:2;
    for(const row of rows){
      if(!/<td\b/i.test(row))continue;
      const rt=stripTags(row), vals=decimals(rt); if(!vals.length)continue;
      let ints=intsNoOdds(rt); if(ints.length>=arity+1)ints=ints.slice(1);
      const maxN=kind==='枠連'?8:18;
      ints=ints.filter(n=>n>=1&&n<=maxN);
      const nums=ints.slice(0,arity); if(nums.length!==arity||new Set(nums).size!==arity)continue;
      if(kind==='PAIR_BOTH'){
        put(markets,'馬連',nums,vals[0]); const low=rangeLow(rt); put(markets,'ワイド',nums,low||(vals.length>=2?vals[1]:0));
      } else if(kind==='ワイド') put(markets,'ワイド',nums,rangeLow(rt)||vals[0]);
      else put(markets,kind,nums,vals[0]);
    }
  }
  return serializeMarkets(markets);
}

function blockedHtml(s){ return !s||s.length<200||/Access Denied|Request blocked|Pardon Our Interruption|captcha|akamai|bm-verify|Just a moment|Reference\s*#/i.test(s); }
function marketCount(markets){ return Object.values(markets||{}).reduce((s,a)=>s+(Array.isArray(a)?a.length:0),0); }

async function fetchViaProxy(proxy,target){
  const base=String(proxy||'').replace(/\/$/,''); if(!base)throw new Error('UPSTREAM_PROXY_URL未設定');
  const sep=base.includes('?')?'&':'?';
  const u=base+sep+'url='+encodeURIComponent(target)+'&_odds_all=1&_timeline='+Date.now();
  const r=await fetch(u,{cache:'no-store',headers:{'Accept':'text/html,application/json,*/*','Cache-Control':'no-cache'}});
  const body=await r.text();
  if(!r.ok)throw new Error(`upstream HTTP ${r.status}`);
  return body;
}

async function fetchMarketsSnapshot(meta,env){
  const rid=String(meta.race_id||''); const kind=String(meta.kind||'JRA').toUpperCase()==='NAR'?'NAR':'JRA';
  const proxy=String(meta.upstream_proxy||env.UPSTREAM_PROXY_URL||env.MANIFEST_SOURCE_URL||'');
  const host=kind==='NAR'?'https://nar.netkeiba.com':'https://race.netkeiba.com';
  const urls=[`${host}/odds/index.html?race_id=${rid}&type=b0`];
  if(kind==='NAR')urls.push(`https://nar.sp.netkeiba.com/odds/?race_id=${rid}`);
  let lastErr='';
  for(const target of urls){
    try{
      const html=await fetchViaProxy(proxy,target);
      if(blockedHtml(html))throw new Error('blocked/empty');
      const markets=parseAllMarketsHtml(html);
      if(marketCount(markets)>0)return {markets,source:target};
    }catch(e){lastErr=String(e&&e.message||e);}
  }

  // JRAは公開JSON APIを単勝だけ最後の保険として利用。
  if(kind==='JRA'){
    try{
      const api=`https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${rid}&type=1&action=update`;
      const raw=await fetchViaProxy(proxy,api); const j=JSON.parse(raw); const root=j?.data?.odds?.['1']||j?.data?.odds||{};
      const win=[];
      for(const [k,v] of Object.entries(root||{})){
        const no=Number(String(k).replace(/\D/g,'')); const od=Number(Array.isArray(v)?v[0]:v?.odds??v);
        if(no>=1&&no<=18&&od>=1)win.push({combination:String(no),odds:od});
      }
      if(win.length)return {markets:{'単勝':win},source:api+'#fallback'};
    }catch(e){lastErr=String(e&&e.message||e);}
  }
  throw new Error(lastErr||'オッズ取得0件');
}

export class OddsTimelineCollector {
  constructor(ctx,env){ this.ctx=ctx; this.env=env; this.storage=ctx.storage; }

  async fetch(request){
    const url=new URL(request.url); const path=url.pathname;
    if(path.endsWith('/start')){
      const body=request.method==='POST'?await request.json().catch(()=>({})):Object.fromEntries(url.searchParams);
      const meta=await this.start(body); return json({ok:true,version:VERSION,meta});
    }
    if(path.endsWith('/stop')){ const meta=await this.storage.get('meta')||{}; meta.active=false; meta.stopped_at=new Date().toISOString(); await this.storage.put('meta',meta); await this.storage.deleteAlarm(); return json({ok:true,meta}); }
    if(path.endsWith('/status')){ return json({ok:true,version:VERSION,meta:await this.storage.get('meta')||null,count:Number(await this.storage.get('count')||0)}); }
    if(path.endsWith('/history')){
      const since=Number(url.searchParams.get('since')||0); const limit=Math.max(1,Math.min(5000,Number(url.searchParams.get('limit')||5000)));
      const list=await this.storage.list({prefix:'c:',limit:limit+100}); const rows=[];
      for(const [,v] of list){ if(v&&Number(v.captured_ms||0)>since)rows.push(v); }
      rows.sort((a,b)=>a.captured_ms-b.captured_ms); return json({ok:true,version:VERSION,count:rows.length,captures:rows.slice(-limit)});
    }
    return json({ok:false,error:'unknown DO route'},404);
  }

  async start(body={}){
    const rid=String(body.race_id||'').replace(/\D/g,''); if(!/^\d{10,14}$/.test(rid))throw new Error('race_id required');
    const old=await this.storage.get('meta')||{};
    const now=Date.now();
    const meta={
      ...old,
      race_id:rid,
      kind:String(body.kind||old.kind||'JRA').toUpperCase()==='NAR'?'NAR':'JRA',
      race_label:String(body.race_label||old.race_label||rid),
      upstream_proxy:String(body.upstream_proxy||old.upstream_proxy||this.env.UPSTREAM_PROXY_URL||''),
      interval_ms:Math.max(5000,Math.min(60000,Number(body.interval_ms||old.interval_ms||DEFAULT_INTERVAL_MS))),
      end_at_ms:Number(body.end_at_ms||old.end_at_ms||now+3*60*60*1000),
      active:true,
      started_at:old.started_at||new Date().toISOString(),
      updated_at:new Date().toISOString(),
      last_error:''
    };
    await this.storage.put('meta',meta);
    const alarm=await this.storage.getAlarm(); if(alarm==null||alarm>now+10000)await this.storage.setAlarm(now+1000);
    return meta;
  }

  async alarm(){
    const meta=await this.storage.get('meta'); if(!meta||!meta.active)return;
    const now=Date.now();
    if(Number(meta.end_at_ms||0)>0 && now>Number(meta.end_at_ms)){
      meta.active=false; meta.finished_at=new Date().toISOString(); await this.storage.put('meta',meta); return;
    }
    try{
      const got=await fetchMarketsSnapshot(meta,this.env);
      const total=marketCount(got.markets);
      if(total>0){
        const rec={schema:'thekeiba-odds-timeline-v1',id:`${meta.race_id}:${now}`,race_id:meta.race_id,kind:meta.kind,race_label:meta.race_label||meta.race_id,captured_ms:now,captured_at:new Date(now).toISOString(),source:'CLOUD_DO:'+got.source,horses:[],markets:got.markets};
        await this.storage.put(`c:${String(now).padStart(13,'0')}`,rec);
        let count=Number(await this.storage.get('count')||0)+1; await this.storage.put('count',count);
        meta.last_capture_ms=now; meta.last_capture_at=rec.captured_at; meta.last_market_count=total; meta.last_error='';
        await this.storage.put('meta',meta);
        if(count>MAX_RECORDS && count%50===0){
          const list=await this.storage.list({prefix:'c:',limit:count-MAX_RECORDS}); const dels=[...list.keys()]; if(dels.length)await this.storage.delete(dels); await this.storage.put('count',Math.max(MAX_RECORDS,count-dels.length));
        }
      }
    }catch(e){ meta.last_error=String(e&&e.message||e); meta.last_error_at=new Date().toISOString(); await this.storage.put('meta',meta); }
    if(meta.active)await this.storage.setAlarm(Date.now()+Math.max(5000,Number(meta.interval_ms||DEFAULT_INTERVAL_MS)));
  }
}

async function doFetch(env,rid,path,init){
  const id=env.TIMELINE.idFromName(String(rid)); const stub=env.TIMELINE.get(id);
  return await stub.fetch('https://do.internal'+path,init);
}
async function startRace(env,meta){
  const rid=String(meta.race_id||'').replace(/\D/g,''); if(!rid)return null;
  return await doFetch(env,rid,'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(meta)});
}
async function discoverAndStart(env,date=jstYmd()){
  const base=String(env.MANIFEST_SOURCE_URL||env.UPSTREAM_PROXY_URL||'').replace(/\/$/,'');
  if(!base)return {ok:false,error:'MANIFEST_SOURCE_URL未設定',started:0};
  let j=null;
  try{
    let r=await fetch(base+'/cron-status?date='+encodeURIComponent(date),{cache:'no-store'}); j=await r.json().catch(()=>null);
    if(!j?.manifest?.races?.length){ try{await fetch(base+'/cron-run?discover=1',{cache:'no-store'});}catch(_){} r=await fetch(base+'/cron-status?date='+encodeURIComponent(date),{cache:'no-store'}); j=await r.json().catch(()=>null); }
  }catch(e){return {ok:false,error:String(e&&e.message||e),started:0};}
  const races=Array.isArray(j?.manifest?.races)?j.manifest.races:[]; const now=Date.now(); let started=0,eligible=0;
  for(const r of races){
    const rid=String(r?.race_id||'').replace(/\D/g,''); if(!/^\d{10,14}$/.test(rid))continue;
    const kind=String(r.kind||'JRA').toUpperCase()==='NAR'?'NAR':'JRA';
    const hhmm=String(r.discovered_post_time||r.post_time||'').match(/\d{1,2}:\d{2}/)?.[0]||'';
    let postMs=timeMsOnJstDate(date,hhmm);
    if(!Number.isFinite(postMs))continue;
    const startMs=postMs-DEFAULT_START_BEFORE_MS,endMs=postMs+DEFAULT_END_AFTER_MS;
    if(now<startMs||now>endMs)continue; eligible++;
    try{
      await startRace(env,{race_id:rid,kind,race_label:String(r.race_name||`${r.race_no||rid.slice(-2)}R`),upstream_proxy:String(env.UPSTREAM_PROXY_URL||base),interval_ms:DEFAULT_INTERVAL_MS,end_at_ms:endMs}); started++;
    }catch(_){ }
  }
  return {ok:true,date,manifest_races:races.length,eligible,started};
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors()});
    if(url.pathname==='/health')return json({ok:true,version:VERSION,durable_object:true,alarm_interval_ms:DEFAULT_INTERVAL_MS,manifest_source:!!env.MANIFEST_SOURCE_URL,upstream_proxy:!!env.UPSTREAM_PROXY_URL});
    if(url.pathname==='/timeline/discover'){
      if(!tokenOk(request,env))return json({ok:false,error:'unauthorized'},401);
      return json(await discoverAndStart(env,url.searchParams.get('date')||jstYmd()));
    }
    const rid=String(url.searchParams.get('race_id')||'').replace(/\D/g,'');
    if(/^\/timeline\/(start|stop|status|history)$/.test(url.pathname)){
      let body=null;
      if(request.method==='POST')body=await request.clone().json().catch(()=>({}));
      const rr=rid||String(body?.race_id||'').replace(/\D/g,'');
      if(!/^\d{10,14}$/.test(rr))return json({ok:false,error:'race_id required'},400);
      if((url.pathname.endsWith('/start')||url.pathname.endsWith('/stop'))&&!tokenOk(request,env))return json({ok:false,error:'unauthorized'},401);
      if(url.pathname.endsWith('/start')){
        const payload={...(body||{}),race_id:rr,upstream_proxy:String(body?.upstream_proxy||env.UPSTREAM_PROXY_URL||'')};
        return await doFetch(env,rr,'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      }
      if(url.pathname.endsWith('/stop'))return await doFetch(env,rr,'/stop',{method:'POST'});
      if(url.pathname.endsWith('/status'))return await doFetch(env,rr,'/status');
      const q=new URLSearchParams(); if(url.searchParams.has('since'))q.set('since',url.searchParams.get('since')); if(url.searchParams.has('limit'))q.set('limit',url.searchParams.get('limit'));
      return await doFetch(env,rr,'/history?'+q.toString());
    }
    return json({ok:false,error:'route not found',version:VERSION},404);
  },
  async scheduled(controller,env,ctx){ ctx.waitUntil(discoverAndStart(env,jstYmd())); }
};

// The競馬 EV分析 - Always-on Odds Timeline Collector v6.1.12 OddsRelease5s Post+3m GitHubArchive
// Cloudflare Worker + Durable Object
// Device 0 / iPad offでも時系列オッズ収集を継続するためのコンパニオンWorker。
//
// 必要bindings:
//   Durable Object namespace: TIMELINE -> OddsTimelineCollector
// 任意vars:
//   UPSTREAM_PROXY_URL   既存のThe競馬プロキシWorker URL
//   MANIFEST_SOURCE_URL  既存Cron Worker URL（/cron-status?date=YYYY-MM-DDを持つ）
//   TIMELINE_TOKEN       書込/停止API保護用（空なら保護なし）
//   GITHUB_TOKEN         GitHub fine-grained or classic token (repo contents write)
//   GITHUB_OWNER         保存先GitHubユーザー/組織名
//   GITHUB_REPO          保存先リポジトリ名
//   GITHUB_BRANCH        保存先ブランチ名（既定 main）
//   GITHUB_BASE_PATH     保存先ベースフォルダ（既定 data）
//
// Cron: * * * * *
// 仕様: JRA/NARとも、オッズ初回配信を5秒間隔で検知 → 以後は全8券種を5秒刻みで保存 → 発走時刻+3分で停止。
// 停止後はGitHubへ自動退避（初回フル + 以後差分形式）し、成功後にDurable Object内の時系列を削除。
// 当日＋翌日manifestを監視し、夜間発売/前日発売にも対応。
// Free枠対策: 発売前は単勝/複勝系の軽量probeだけを実行し、発売後のみ7ページ/8券種をまとめて取得。

const VERSION = 'v6.1.12 OddsRelease5s Post3m GitHubArchive All8Markets';
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_RELEASE_PROBE_MS = 5000;
const DEFAULT_ARM_BEFORE_MS = 36 * 60 * 60 * 1000;
const DEFAULT_END_AFTER_MS = 3 * 60 * 1000;
// 5秒刻みで約27.8時間。前日発売から発走+3分までを切らないため従来5000→20000。
const MAX_RECORDS = 20000;
const DISCOVER_REFRESH_MINUTES = 10; // Free枠節約: active raceへの/start再送を毎分→10分ごとに抑制
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
function armBeforeMs(env){
  const hours=Number(env?.ODDS_ARM_HOURS||36);
  return Math.max(1,Math.min(48,Number.isFinite(hours)?hours:36))*60*60*1000;
}
function releaseProbeMs(env){
  const ms=Number(env?.RELEASE_PROBE_MS||DEFAULT_RELEASE_PROBE_MS);
  return Math.max(5000,Math.min(60000,Number.isFinite(ms)?ms:DEFAULT_RELEASE_PROBE_MS));
}
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

// Shared by the browser and the Durable Object collector.
// netkeiba data.odds is keyed by ticket type; never infer a type from a flat map.
const TICKET_DEFS243 = [
  {id:1,name:'単勝',arity:1},
  {id:2,name:'複勝',arity:1,range:true},
  {id:3,name:'枠連',arity:2,unordered:true,frame:true},
  {id:4,name:'馬連',arity:2,unordered:true},
  {id:5,name:'ワイド',arity:2,unordered:true,range:true},
  {id:6,name:'馬単',arity:2},
  {id:7,name:'3連複',arity:3,unordered:true},
  {id:8,name:'3連単',arity:3}
];

function oddsNumber243(value){
  if(typeof value==='number') return Number.isFinite(value)&&value>=1?value:NaN;
  const text=String(value??'').replace(/[,\s倍]/g,'');
  return /^\d+(?:\.\d+)?$/.test(text)&&Number(text)>=1?Number(text):NaN;
}

function oddsKey243(key,def){
  const s=String(key??'').trim();
  let nums;
  if(def.arity===1 && /^\d{1,2}$/.test(s)) nums=[Number(s)];
  else if(new RegExp('^\\d{'+(def.arity*2)+'}$').test(s)) nums=s.match(/\d{2}/g).map(Number);
  else if(/^\d{1,2}(?:\s*[-,>→]\s*\d{1,2})+$/.test(s)) nums=s.split(/\s*[-,>→]\s*/).map(Number);
  else return '';
  if(nums.length!==def.arity || nums.some(n=>n<1||n>(def.frame?8:18))) return '';
  if(!def.frame && new Set(nums).size!==nums.length) return '';
  if(def.unordered) nums.sort((a,b)=>a-b);
  return nums.join('-');
}

function parseTicketJson243(raw,def,rid){
  const j=typeof raw==='string'?JSON.parse(raw.trim()):raw;
  const responseRid=j?.data?.race_id??j?.race_id;
  if(responseRid!=null && String(responseRid)!==String(rid)) throw new Error('別レースの応答');
  const root=j?.data?.odds??j?.odds;
  const values=root?.[String(def.id)];
  if(!values || typeof values!=='object') throw new Error(`${def.name}のJSONデータなし（未発売・取得拒否等）`);
  const byKey=new Map();
  for(const [key,v] of Object.entries(values)){
    const combination=oddsKey243(key,def); if(!combination) continue;
    let low,high,pop;
    if(Array.isArray(v)) { low=v[0]; high=def.range?v[1]:undefined; pop=v[2]; }
    else if(v && typeof v==='object') {
      low=v.odds_min??v.min??v.odds??v.value;
      high=def.range?(v.odds_max??v.max):undefined;
      pop=v.popularity??v.pop;
    } else low=v;
    const lo=oddsNumber243(low),hi=oddsNumber243(high);
    if(!Number.isFinite(lo)) continue;
    const row={combination,odds:lo};
    if(def.range){
      row.odds_min=Number.isFinite(hi)?Math.min(lo,hi):lo;
      row.odds_max=Number.isFinite(hi)?Math.max(lo,hi):lo;
      row.odds=row.odds_min;
    }
    if(Number.isInteger(Number(pop))&&Number(pop)>0) row.popularity=Number(pop);
    byKey.set(combination,row);
  }
  return [...byKey.values()].sort((a,b)=>a.odds-b.odds||a.combination.localeCompare(b.combination,'ja',{numeric:true}));
}


// v6.1.10:
// JRAの単勝と複勝は同じ出走馬を対象にするため、単勝件数 > 複勝件数なら
// race.netkeiba.com の type=1 JSONを「不足時だけ」1回追加取得して馬番単位で補完する。
// 通常時は追加subrequest 0回。Free 5s BatchSaverの省リクエスト設計を維持する。
function mergeMarketRows610(currentRows=[],freshRows=[]){
  const map=new Map();
  for(const r of Array.isArray(currentRows)?currentRows:[]){
    const k=String(r?.combination||'').trim();
    if(k)map.set(k,r);
  }
  for(const r of Array.isArray(freshRows)?freshRows:[]){
    const k=String(r?.combination||'').trim();
    if(k)map.set(k,r);
  }
  return [...map.values()].sort((a,b)=>Number(a?.odds||0)-Number(b?.odds||0)||String(a?.combination||'').localeCompare(String(b?.combination||''),'ja',{numeric:true}));
}

async function reconcileJraWinPlace610(got,rid,fetchText){
  if(!got||!got.markets||typeof got.markets!=='object')return got;
  const winBefore=Array.isArray(got.markets['単勝'])?got.markets['単勝'].length:0;
  const placeBefore=Array.isArray(got.markets['複勝'])?got.markets['複勝'].length:0;
  got.place_reconcile={
    attempted:false,
    win_before:winBefore,
    place_before:placeBefore,
    win_after:winBefore,
    place_after:placeBefore,
    source:'',
    message:''
  };

  // 単勝が取得できていない、または既に同数以上なら追加取得しない。
  if(winBefore<=0 || placeBefore>=winBefore){
    got.place_reconcile.message=winBefore<=0?'単勝件数0のため照合省略':'単勝/複勝件数一致';
    return got;
  }

  got.place_reconcile.attempted=true;
  const endpoint='https://race.netkeiba.com/api/api_get_jra_odds.html';
  const url=`${endpoint}?pid=api_get_jra_odds&race_id=${rid}&type=1&action=update&sort=odds&compress=0&output=json&_placefix=${Date.now()}`;

  try{
    const raw=await fetchText(url);
    let winJson=[],placeJson=[];
    try{winJson=parseTicketJson243(raw,TICKET_DEFS243[0],rid);}catch(_){}
    try{placeJson=parseTicketJson243(raw,TICKET_DEFS243[1],rid);}catch(_){}

    const mergedWin=mergeMarketRows610(got.markets['単勝'],winJson);
    const mergedPlace=mergeMarketRows610(got.markets['複勝'],placeJson);
    if(mergedWin.length)got.markets['単勝']=mergedWin;
    if(mergedPlace.length)got.markets['複勝']=mergedPlace;

    const winAfter=Array.isArray(got.markets['単勝'])?got.markets['単勝'].length:0;
    const placeAfter=Array.isArray(got.markets['複勝'])?got.markets['複勝'].length:0;
    got.place_reconcile.win_after=winAfter;
    got.place_reconcile.place_after=placeAfter;
    got.place_reconcile.source='JRA_JSON_TYPE1';
    got.place_reconcile.message=placeAfter>=winAfter
      ?`複勝 ${placeBefore}→${placeAfter}件へ補完`
      :`複勝 ${placeBefore}→${placeAfter}件（単勝${winAfter}件、配信元不足継続）`;

    got.diagnostics=got.diagnostics||{};
    got.diagnostics['単勝']={
      ...(got.diagnostics['単勝']||{}),
      state:winAfter?'ok':'empty',
      count:winAfter,
      message:winAfter?'':'有効な単勝オッズなし'
    };
    got.diagnostics['複勝']={
      ...(got.diagnostics['複勝']||{}),
      state:placeAfter?'ok':'empty',
      count:placeAfter,
      message:placeAfter>=winAfter
        ?(placeAfter>placeBefore?'JRA type=1 JSONで不足分を補完':'')
        :`単勝${winAfter}件に対し複勝${placeAfter}件。次回5秒取得で再照合`
    };
    got.market_count=Object.values(got.markets||{}).filter(a=>Array.isArray(a)&&a.length).length;
    if(!String(got.source||'').includes('JRA_JSON_TYPE1_RECONCILE')){
      got.source=String(got.source||'')+(got.source?' | ':'')+'JRA_JSON_TYPE1_RECONCILE';
    }
  }catch(e){
    got.place_reconcile.message='補完取得失敗: '+String(e?.message||e).slice(0,180);
    got.diagnostics=got.diagnostics||{};
    got.diagnostics['複勝']={
      ...(got.diagnostics['複勝']||{}),
      state:placeBefore?'ok':'error',
      count:placeBefore,
      message:`単勝${winBefore}件に対し複勝${placeBefore}件。補完取得失敗、次回5秒取得で再試行`
    };
  }
  return got;
}

async function fetchAllTickets243(kind,rid,fetchText,onProgress=()=>{}){
  if(!/^\d{12}$/.test(String(rid))) throw new Error('race_idは12桁で指定してください');
  const nar=kind==='NAR';
  const markets={},diagnostics={},sources=[];
  let done=0;
  const setDiag=(name,state,count,message='')=>{
    diagnostics[name]={state,count:Number(count||0),message:String(message||'')};
  };
  const publish=()=>{ try{onProgress(done,diagnostics);}catch(_){} };

  if(!nar){
    // JRA公式JSON: type=1 は単勝(1)と複勝(2)を同じ応答に含む。
    // compress=0/output=json を明示し、残りは type=3..8 を個別取得する。
    const endpoint='https://race.netkeiba.com/api/api_get_jra_odds.html';
    const groups=[
      {type:1,defs:[TICKET_DEFS243[0],TICKET_DEFS243[1]]},
      {type:3,defs:[TICKET_DEFS243[2]]},
      {type:4,defs:[TICKET_DEFS243[3]]},
      {type:5,defs:[TICKET_DEFS243[4]]},
      {type:6,defs:[TICKET_DEFS243[5]]},
      {type:7,defs:[TICKET_DEFS243[6]]},
      {type:8,defs:[TICKET_DEFS243[7]]}
    ];
    let cursor=0;
    async function run(){
      while(cursor<groups.length){
        const group=groups[cursor++];
        const url=`${endpoint}?pid=api_get_jra_odds&race_id=${rid}&type=${group.type}&action=update&sort=odds&compress=0&output=json&_=${Date.now()}`;
        try{
          const raw=await fetchText(url);
          for(const def of group.defs){
            try{
              const rows=parseTicketJson243(raw,def,rid);
              if(rows.length){markets[def.name]=rows;sources.push(url);setDiag(def.name,'ok',rows.length,'');}
              else setDiag(def.name,'empty',0,'有効なオッズなし（未発売・売止等）');
            }catch(e){ setDiag(def.name,'error',0,String(e?.message||e).slice(0,180)); }
            done++; publish();
          }
        }catch(e){
          for(const def of group.defs){ setDiag(def.name,'error',0,String(e?.message||e).slice(0,180)); done++; publish(); }
        }
      }
    }
    await Promise.all([run(),run(),run()]);
  }else{
    // NARはJRA用JSON APIを仮定しない。券種別HTMLを取得して8券種へ集約する。
    const pages=[
      {b:'b1',types:['単勝','複勝']},{b:'b3',types:['枠連']},{b:'b4',types:['馬連']},
      {b:'b5',types:['ワイド']},{b:'b6',types:['馬単']},{b:'b7',types:['3連複']},{b:'b8',types:['3連単']}
    ];
    let cursor=0;
    async function run(){
      while(cursor<pages.length){
        const p=pages[cursor++];
        const urls=[
          `https://nar.netkeiba.com/odds/index.html?race_id=${rid}&type=${p.b}${p.b==='b1'?'':'&housiki=c99'}`,
          `https://nar.sp.netkeiba.com/odds/?race_id=${rid}&type=${p.b}${p.b==='b1'?'':'&housiki=c99'}`
        ];
        let parsed=null,used='',lastErr='';
        for(const url of urls){
          try{
            const raw=await fetchText(url);
            const got=parseAllMarketsHtml(raw);
            if(Object.values(got||{}).some(a=>Array.isArray(a)&&a.length)){parsed=got;used=url;break;}
            lastErr='有効なオッズなし（未発売・売止等）';
          }catch(e){lastErr=String(e?.message||e).slice(0,180);}
        }
        if(parsed){
          for(const [t,rows] of Object.entries(parsed)) if(Array.isArray(rows)&&rows.length) markets[t]=rows;
          if(used)sources.push(used);
        }
        for(const t of p.types){
          const n=markets[t]?.length||0;
          setDiag(t,n?'ok':(lastErr?'error':'empty'),n,n?'':(lastErr||'有効なオッズなし（未発売・売止等）'));
          done++;publish();
        }
      }
    }
    await Promise.all([run(),run(),run()]);
  }
  const ordered={};
  for(const def of TICKET_DEFS243) if(markets[def.name]?.length) ordered[def.name]=markets[def.name];
  return {markets:ordered,diagnostics,source:[...new Set(sources)].sort().join(' | '),market_count:Object.keys(ordered).length};
}


// v6.1.9 Free saver:
// 7つの券種ページを「同じDO実行の外部subrequest」としてまとめて取得する。
// 別Workerを券種ごとに7回起動しないため、Workers日次リクエスト消費を大幅に削減する。
async function fetchAllTicketsHtml243(kind,rid,fetchText,onProgress=()=>{}){
  if(!/^\d{12}$/.test(String(rid))) throw new Error('race_idは12桁で指定してください');
  const nar=kind==='NAR';
  const host=nar?'https://nar.netkeiba.com':'https://race.netkeiba.com';
  const spHost=nar?'https://nar.sp.netkeiba.com':'https://race.sp.netkeiba.com';
  const defs=[
    {b:'b1',types:['単勝','複勝']},{b:'b3',types:['枠連']},{b:'b4',types:['馬連']},
    {b:'b5',types:['ワイド']},{b:'b6',types:['馬単']},{b:'b7',types:['3連複']},{b:'b8',types:['3連単']}
  ];
  const markets={},diagnostics={},sources=[];
  let done=0,cursor=0;
  const publish=()=>{try{onProgress(done,diagnostics);}catch(_){}};
  async function run(){
    while(cursor<defs.length){
      const d=defs[cursor++];
      const suffix=d.b==='b1'?'': '&housiki=c99';
      const urls=[
        `${host}/odds/index.html?race_id=${rid}&type=${d.b}${suffix}`,
        `${spHost}/odds/?race_id=${rid}&type=${d.b}${suffix}`
      ];
      let parsed=null,used='',lastErr='';
      for(const url of urls){
        try{
          const raw=await fetchText(url);
          const got=parseAllMarketsHtml(raw);
          if(Object.values(got||{}).some(a=>Array.isArray(a)&&a.length)){
            parsed=got;used=url;break;
          }
          lastErr='有効なオッズなし（未発売・売止等）';
        }catch(e){lastErr=String(e?.message||e).slice(0,180);}
      }
      if(parsed){
        for(const [t,rows] of Object.entries(parsed)){
          if(Array.isArray(rows)&&rows.length) markets[t]=rows;
        }
        if(used)sources.push(used);
      }
      for(const t of d.types){
        const n=markets[t]?.length||0;
        diagnostics[t]={state:n?'ok':(lastErr?'error':'empty'),count:n,message:n?'':(lastErr||'有効なオッズなし（未発売・売止等）')};
        done++;publish();
      }
    }
  }
  // 7 subrequestsを最大3並列。Cloudflare Freeの1実行subrequest上限内。
  await Promise.all([run(),run(),run()]);
  const ordered={};
  for(const t of MARKET_TYPES) if(markets[t]?.length) ordered[t]=markets[t];
  return {markets:ordered,diagnostics,source:[...new Set(sources)].join(' | '),market_count:Object.keys(ordered).length,fetch_mode:'DIRECT_HTML_BATCH'};
}

async function fetchAllMarketsBatchViaProxy243(meta,env){
  const base=String(meta.upstream_proxy||env.UPSTREAM_PROXY_URL||env.MANIFEST_SOURCE_URL||'').trim();
  if(!base)throw new Error('batch proxy URL未設定');
  const u=new URL('/all-markets',base.endsWith('/')?base:base+'/');
  u.searchParams.set('race_id',String(meta.race_id||''));
  u.searchParams.set('kind',String(meta.kind||'JRA'));
  if(meta.race_date)u.searchParams.set('date',String(meta.race_date));
  if(meta.post_time)u.searchParams.set('post_time',String(meta.post_time));
  u.searchParams.set('_timeline',String(Date.now()));
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),15000);
  try{
    const r=await fetch(u,{cache:'no-store',signal:ac.signal,headers:{Accept:'application/json'}});
    const raw=await r.text();
    let j=null; try{j=JSON.parse(raw);}catch(_){throw new Error(`batch proxy JSON不正 HTTP ${r.status}`);}
    if(!r.ok||!j?.ok)throw new Error(String(j?.error||`batch proxy HTTP ${r.status}`));
    const markets=(j.markets&&typeof j.markets==='object')?j.markets:(j.additional_markets||{});
    const count=Object.values(markets).filter(a=>Array.isArray(a)&&a.length).length;
    if(!count)throw new Error('batch proxy: 全券種0件');
    return {
      markets,
      diagnostics:j.diagnostics||j.market_status||{},
      source:String(j.source||j.source_url||u.origin+'/all-markets'),
      market_count:count,
      fetch_mode:'ONE_WORKER_BATCH_PROXY'
    };
  }finally{clearTimeout(timer);}
}

async function fetchViaProxy(proxy,target){
  const base=String(proxy||'').replace(/\/$/,''); if(!base)throw new Error('UPSTREAM_PROXY_URL未設定');
  const u=new URL(base); u.searchParams.set('url',target); u.searchParams.set('_timeline',String(Date.now()));
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),8000);
  try{
    const r=await fetch(u,{cache:'no-store',signal:ac.signal,headers:{Accept:'application/json'}});
    if(!r.ok)throw new Error(`upstream HTTP ${r.status}`);
    return await r.text();
  }finally{clearTimeout(timer);}
}

async function fetchDirectText243(target,accept='application/json'){
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),6500);
  try{
    const u=new URL(target);
    const referer=u.hostname.startsWith('nar.')?'https://nar.netkeiba.com/':'https://race.netkeiba.com/';
    const r=await fetch(target,{cache:'no-store',signal:ac.signal,headers:{
      'Accept':accept,
      'Accept-Language':'ja-JP,ja;q=0.9,en;q=0.6',
      'Referer':referer,
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
    }});
    const txt=await r.text();
    if(!r.ok)throw new Error(`direct HTTP ${r.status}`);
    return txt;
  }finally{clearTimeout(timer);}
}

async function fetchMarketsSnapshot(meta,env){
  const rid=String(meta.race_id||'');
  const kind=String(meta.kind||'JRA').toUpperCase()==='NAR'?'NAR':'JRA';
  const proxy=String(meta.upstream_proxy||env.UPSTREAM_PROXY_URL||env.MANIFEST_SOURCE_URL||'');
  const errors=[];

  // 1) 最優先: このDurable Objectの1回のalarm内で7ページを直接取得。
  //    Workersの「別Worker呼び出し」は0回。Free枠を最も節約できる。
  try{
    const got=await fetchAllTicketsHtml243(kind,rid,url=>fetchDirectText243(url,'text/html,application/xhtml+xml,*/*;q=0.8'));
    if(got.market_count){
      if(kind==='JRA'){
        await reconcileJraWinPlace610(got,rid,url=>fetchDirectText243(url,'application/json, text/javascript, */*;q=0.8'));
      }
      return got;
    }
  }catch(e){errors.push('direct-html:'+String(e?.message||e));}

  // 2) directがサイト側で拒否された場合だけ、abc Workerの/all-marketsを1回だけ呼ぶ。
  //    旧方式の「券種ごとに7回abc Workerを起動」はしない。
  if(proxy){
    try{
      const got=await fetchAllMarketsBatchViaProxy243(meta,env);
      if(kind==='JRA'){
        await reconcileJraWinPlace610(got,rid,url=>fetchDirectText243(url,'application/json, text/javascript, */*;q=0.8'));
      }
      return got;
    }catch(e){errors.push('batch-proxy:'+String(e?.message||e));}
  }

  // 3) JRA JSON APIを直接試す（別Workerは使わない）。HTML仕様変更時の保険。
  if(kind==='JRA'){
    try{
      const got=await fetchAllTickets243(kind,rid,url=>fetchDirectText243(url,'application/json, text/javascript, */*;q=0.8'));
      if(got.market_count){
        got.fetch_mode='DIRECT_JSON_BATCH';
        await reconcileJraWinPlace610(got,rid,url=>fetchDirectText243(url,'application/json, text/javascript, */*;q=0.8'));
        return got;
      }
    }catch(e){errors.push('direct-json:'+String(e?.message||e));}
  }

  // 4) 明示的に許可した場合だけ旧「券種別proxy」を最終保険として使う。
  //    Free運用では既定OFF。ENABLE_LEGACY_PROXY_FALLBACK=1でのみ有効。
  const allowLegacy=String(env.ENABLE_LEGACY_PROXY_FALLBACK||'').trim()==='1';
  if(allowLegacy && proxy){
    try{
      const got=await fetchAllTickets243(kind,rid,async url=>{
        try{return await fetchDirectText243(url,/api_get_/i.test(url)?'application/json, text/javascript, */*;q=0.8':'text/html,*/*;q=0.8');}
        catch(_){return await fetchViaProxy(proxy,url);}
      });
      if(got.market_count){got.fetch_mode='LEGACY_PER_MARKET_PROXY';return got;}
    }catch(e){errors.push('legacy-proxy:'+String(e?.message||e));}
  }

  throw new Error(errors.join(' / ')||'全券種オッズ取得失敗');
}

async function probeOddsReleased611(meta,env){
  const rid=String(meta.race_id||'');
  const kind=String(meta.kind||'JRA').toUpperCase()==='NAR'?'NAR':'JRA';
  const proxy=String(meta.upstream_proxy||env.UPSTREAM_PROXY_URL||env.MANIFEST_SOURCE_URL||'');
  const errors=[];

  if(kind==='JRA'){
    const url=`https://race.netkeiba.com/api/api_get_jra_odds.html?pid=api_get_jra_odds&race_id=${rid}&type=1&action=update&sort=odds&compress=0&output=json&_release=${Date.now()}`;
    const parse=raw=>{
      let n=0;
      try{n+=parseTicketJson243(raw,TICKET_DEFS243[0],rid).length;}catch(_){}
      try{n+=parseTicketJson243(raw,TICKET_DEFS243[1],rid).length;}catch(_){}
      return n;
    };
    try{
      const raw=await fetchDirectText243(url,'application/json, text/javascript, */*;q=0.8');
      const count=parse(raw); if(count>0)return {released:true,count,source:'JRA_TYPE1_DIRECT',errors};
    }catch(e){errors.push('direct:'+String(e?.message||e).slice(0,120));}
    if(proxy){
      try{
        const raw=await fetchViaProxy(proxy,url); const count=parse(raw);
        if(count>0)return {released:true,count,source:'JRA_TYPE1_PROXY',errors};
      }catch(e){errors.push('proxy:'+String(e?.message||e).slice(0,120));}
    }
    return {released:false,count:0,source:'',errors};
  }

  const urls=[
    `https://nar.netkeiba.com/odds/index.html?race_id=${rid}&type=b1`,
    `https://nar.sp.netkeiba.com/odds/?race_id=${rid}&type=b1`
  ];
  const parse=raw=>{
    const got=parseAllMarketsHtml(raw);
    return (got?.['単勝']?.length||0)+(got?.['複勝']?.length||0);
  };
  for(const url of urls){
    try{
      const raw=await fetchDirectText243(url,'text/html,application/xhtml+xml,*/*;q=0.8');
      const count=parse(raw); if(count>0)return {released:true,count,source:url.includes('nar.sp.')?'NAR_B1_SP_DIRECT':'NAR_B1_DIRECT',errors};
    }catch(e){errors.push('direct:'+String(e?.message||e).slice(0,120));}
  }
  if(proxy){
    for(const url of urls){
      try{
        const raw=await fetchViaProxy(proxy,url); const count=parse(raw);
        if(count>0)return {released:true,count,source:url.includes('nar.sp.')?'NAR_B1_SP_PROXY':'NAR_B1_PROXY',errors};
      }catch(e){errors.push('proxy:'+String(e?.message||e).slice(0,120));}
    }
  }
  return {released:false,count:0,source:'',errors};
}

function parseWinningDurationMs243(html){
  const src=String(html||'');
  // 結果表の1着行を優先。勝ち時計は通常 m:ss.s 形式。
  const rows=[...src.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]);
  for(const row of rows){
    const text=stripTags(row);
    const rank=(text.match(/^\s*(\d{1,2})(?:\s|$)/)||[])[1];
    if(String(rank)!=='1' && !/着順\s*1|1\s*着/.test(text)) continue;
    const tm=text.match(/\b(\d{1,2}):([0-5]\d(?:\.\d)?)\b/);
    if(tm){ const sec=Number(tm[1])*60+Number(tm[2]); if(sec>20&&sec<600)return Math.round(sec*1000); }
  }
  // HTML構造変更時の保険: 「タイム」付近の最初の競走タイム。
  const around=(src.match(/タイム[\s\S]{0,5000}/i)||[])[0]||'';
  const tm=stripTags(around).match(/\b(\d{1,2}):([0-5]\d(?:\.\d)?)\b/);
  if(tm){ const sec=Number(tm[1])*60+Number(tm[2]); if(sec>20&&sec<600)return Math.round(sec*1000); }
  return NaN;
}
function parseResultStartMs243(html,fallbackPostMs){
  const text=stripTags(html);
  const m=text.match(/(?:発走|スタート)[^0-9]{0,30}(\d{1,2}):(\d{2})/);
  if(!m)return Number(fallbackPostMs)||NaN;
  const base=Number(fallbackPostMs)||Date.now();
  const date=jstYmd(base);
  return timeMsOnJstDate(date,`${m[1]}:${m[2]}`);
}
async function fetchResultHtml243(meta,env){
  const base=String(meta.upstream_proxy||env.UPSTREAM_PROXY_URL||env.MANIFEST_SOURCE_URL||'').replace(/\/$/,'');
  if(!base)throw new Error('結果確認用UPSTREAM_PROXY_URL未設定');
  const u=new URL(base);
  u.searchParams.set('race_id',String(meta.race_id||''));
  u.searchParams.set('type','result');
  u.searchParams.set('kind',String(meta.kind||'JRA'));
  u.searchParams.set('_finish_probe',String(Date.now()));
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),8000);
  try{
    const r=await fetch(u,{cache:'no-store',signal:ac.signal,headers:{Accept:'text/html,*/*;q=0.8'}});
    const txt=await r.text();
    if(!r.ok)throw new Error(`result HTTP ${r.status}`);
    if(!/着順|払戻|タイム|Result/i.test(txt))throw new Error('結果未確定');
    return txt;
  }finally{clearTimeout(timer);}
}
async function maybeUpdateFinishStop243(meta,env,now=Date.now()){
  const postMs=Number(meta.post_ms||0);
  if(!(postMs>0) || now<postMs+20*1000) return meta;
  if(now-Number(meta.last_result_probe_ms||0)<15000) return meta;
  meta.last_result_probe_ms=now;
  try{
    const html=await fetchResultHtml243(meta,env);
    const dur=parseWinningDurationMs243(html);
    const startMs=parseResultStartMs243(html,postMs);
    if(Number.isFinite(dur)&&Number.isFinite(startMs)){
      const finishMs=startMs+dur;
      meta.finish_ms=finishMs;
      meta.finish_source='result_winner_time';
      meta.end_at_ms=finishMs+5*60*1000;
      meta.result_detected_at=new Date(now).toISOString();
      meta.last_result_probe_error='';
    }else{
      if(!Number(meta.finish_detected_ms||0)) meta.finish_detected_ms=now;
      const detectedEnd=Number(meta.finish_detected_ms)+5*60*1000;
      const fallback=Number(meta.fallback_end_at_ms||meta.end_at_ms||0);
      meta.end_at_ms=fallback>0?Math.min(fallback,detectedEnd):detectedEnd;
      meta.finish_source='result_detected';
      meta.result_detected_at=new Date(now).toISOString();
    }
  }catch(e){ meta.last_result_probe_error=String(e?.message||e).slice(0,180); }
  return meta;
}

// Keep each Durable Object value below its per-value size limit.
// A complete 18-horse trifecta alone can contain 4,896 rows.
async function saveCapture243(storage,key,rec){
  const body=JSON.stringify(rec);
  if(new TextEncoder().encode(body).byteLength<=90000){await storage.put(key,rec);return;}
  const chunks=[];
  for(let i=0;i<body.length;i+=20000)chunks.push(body.slice(i,i+20000));
  const partKeys=chunks.map((_,i)=>'p:'+key.slice(2)+':'+String(i).padStart(3,'0'));
  await storage.transaction(async tx=>{
    for(let i=0;i<chunks.length;i++)await tx.put(partKeys[i],chunks[i]);
    await tx.put(key,{captured_ms:rec.captured_ms,_parts243:partKeys});
  });
}
async function readCapture243(storage,value){
  if(!Array.isArray(value?._parts243))return value;
  const parts=await storage.get(value._parts243);
  if(value._parts243.some(k=>typeof parts.get(k)!=='string'))throw new Error('時系列データの分割読み込み失敗');
  return JSON.parse(value._parts243.map(k=>parts.get(k)).join(''));
}
async function deleteCaptures243(storage,entries){
  const keys=[];
  for(const [key,value] of entries){keys.push(key);if(Array.isArray(value?._parts243))keys.push(...value._parts243);}
  for(let i=0;i<keys.length;i+=100)await storage.delete(keys.slice(i,i+100));
}


function githubArchiveEnabled612(env){
  return !!(String(env?.GITHUB_TOKEN||'').trim() && String(env?.GITHUB_OWNER||'').trim() && String(env?.GITHUB_REPO||'').trim());
}
function githubBranch612(env){ return String(env?.GITHUB_BRANCH||'main').trim() || 'main'; }
function githubBasePath612(env){ return String(env?.GITHUB_BASE_PATH||'data').replace(/^\/+|\/+$/g,'').trim() || 'data'; }
function archivePath612(meta,env){
  const date = String(meta?.race_date || jstYmd(Number(meta?.post_ms||Date.now()))).trim();
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const y = m ? m[1] : 'unknown';
  const mo = m ? m[2] : '00';
  const d = m ? m[3] : '00';
  const kind = String(meta?.kind||'JRA').toUpperCase()==='NAR'?'NAR':'JRA';
  return `${githubBasePath612(env)}/${y}/${mo}/${d}/${kind}/${String(meta?.race_id||'unknown')}.json`;
}
function utf8Base64Encode612(str=''){
  const bytes = new TextEncoder().encode(String(str));
  let bin='';
  for(let i=0;i<bytes.length;i+=0x8000){ bin += String.fromCharCode(...bytes.slice(i,i+0x8000)); }
  return btoa(bin);
}
async function githubFetchJson612(env, path, init={}){
  const token = String(env?.GITHUB_TOKEN||'').trim();
  const owner = encodeURIComponent(String(env?.GITHUB_OWNER||'').trim());
  const repo = encodeURIComponent(String(env?.GITHUB_REPO||'').trim());
  const url = `https://api.github.com/repos/${owner}/${repo}${path}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': `TheKeiba/${VERSION}`,
    ...(init.headers||{})
  };
  const res = await fetch(url,{...init,headers});
  const txt = await res.text();
  let js = null; try{ js = txt ? JSON.parse(txt) : null; }catch(_){ }
  return {ok:res.ok,status:res.status,json:js,text:txt};
}
function rowComparable612(row){
  if(row==null)return null;
  const out = { odds:Number(row.odds) };
  if(Number.isFinite(Number(row.odds_min))) out.odds_min = Number(row.odds_min);
  if(Number.isFinite(Number(row.odds_max))) out.odds_max = Number(row.odds_max);
  if(Number.isFinite(Number(row.popularity))) out.popularity = Number(row.popularity);
  return out;
}
function computeMarketChanges612(prevMarkets={}, currMarkets={}){
  const changes = {};
  const types = new Set([ ...Object.keys(prevMarkets||{}), ...Object.keys(currMarkets||{}) ]);
  for(const type of types){
    const prevMap = new Map((Array.isArray(prevMarkets?.[type])?prevMarkets[type]:[]).map(r=>[String(r?.combination||''), rowComparable612(r)]).filter(([k])=>k));
    const currMap = new Map((Array.isArray(currMarkets?.[type])?currMarkets[type]:[]).map(r=>[String(r?.combination||''), rowComparable612(r)]).filter(([k])=>k));
    const comboChanges = {};
    const keys = new Set([ ...prevMap.keys(), ...currMap.keys() ]);
    for(const key of keys){
      const a = prevMap.has(key) ? JSON.stringify(prevMap.get(key)) : '__MISSING__';
      const b = currMap.has(key) ? JSON.stringify(currMap.get(key)) : '__MISSING__';
      if(a===b) continue;
      comboChanges[key] = currMap.has(key) ? currMap.get(key) : null;
    }
    if(Object.keys(comboChanges).length) changes[type] = comboChanges;
  }
  return changes;
}
function buildArchivePayload612(meta,captures){
  const rows = [...(captures||[])].sort((a,b)=>Number(a.captured_ms||0)-Number(b.captured_ms||0));
  if(!rows.length) throw new Error('保存対象のcaptureがありません');
  const first = rows[0];
  const deltas = [];
  let prevMarkets = first.markets || {};
  for(let i=1;i<rows.length;i++){
    const cur = rows[i];
    const changes = computeMarketChanges612(prevMarkets, cur.markets || {});
    if(Object.keys(changes).length){
      deltas.push({
        captured_ms: Number(cur.captured_ms||0),
        captured_at: String(cur.captured_at||''),
        changes
      });
    }
    prevMarkets = cur.markets || {};
  }
  const captureTimes = rows.map(r=>Number(r.captured_ms||0)).filter(n=>n>0);
  const firstMs = captureTimes[0]||0;
  const lastMs = captureTimes[captureTimes.length-1]||0;
  return {
    schema:'thekeiba-odds-archive-v1',
    compression:'first_full_then_delta',
    version:VERSION,
    exported_at:new Date().toISOString(),
    race:{
      race_id:String(meta?.race_id||''),
      kind:String(meta?.kind||'JRA'),
      race_label:String(meta?.race_label||meta?.race_id||''),
      race_date:String(meta?.race_date||''),
      post_time:String(meta?.post_time||''),
      post_ms:Number(meta?.post_ms||0),
      odds_first_seen_ms:Number(meta?.odds_first_seen_ms||0),
      odds_first_seen_at:String(meta?.odds_first_seen_at||''),
      started_at:String(meta?.started_at||''),
      finished_at:String(meta?.finished_at||''),
      stop_reason:String(meta?.stop_reason||''),
      capture_interval_ms:Number(meta?.interval_ms||DEFAULT_INTERVAL_MS)
    },
    stats:{
      raw_capture_count:rows.length,
      delta_event_count:deltas.length,
      first_capture_ms:firstMs,
      last_capture_ms:lastMs,
      first_capture_at:String(first?.captured_at||''),
      last_capture_at:String(rows[rows.length-1]?.captured_at||'')
    },
    initial_snapshot:{
      captured_ms:Number(first?.captured_ms||0),
      captured_at:String(first?.captured_at||''),
      markets:first?.markets||{},
      market_status:first?.market_status||{}
    },
    deltas
  };
}
async function loadAllCaptures612(storage){
  const list = await storage.list({prefix:'c:',limit:MAX_RECORDS+1000});
  const entries = [...list.entries()].sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  const captures = [];
  for(const [,v] of entries){ captures.push(await readCapture243(storage,v)); }
  captures.sort((a,b)=>Number(a.captured_ms||0)-Number(b.captured_ms||0));
  return {entries,captures};
}
async function uploadArchiveToGitHub612(env, archivePath, payload, meta){
  const branch = githubBranch612(env);
  const pathEsc = archivePath.split('/').map(encodeURIComponent).join('/');
  let sha = null;
  const getRes = await githubFetchJson612(env, `/contents/${pathEsc}?ref=${encodeURIComponent(branch)}`, { method:'GET' });
  if(getRes.ok && getRes.json?.sha) sha = String(getRes.json.sha);
  else if(getRes.status !== 404) throw new Error(`GitHub GET ${getRes.status}: ${String(getRes.json?.message||getRes.text||'').slice(0,200)}`);
  const body = {
    message:`archive odds timeline ${String(meta?.race_id||'')} (${String(meta?.kind||'JRA')}) via ${VERSION}`,
    content:utf8Base64Encode612(JSON.stringify(payload)),
    branch,
    committer:{ name:'TheKeiba Worker', email:'actions@users.noreply.github.com' }
  };
  if(sha) body.sha = sha;
  const putRes = await githubFetchJson612(env, `/contents/${pathEsc}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if(!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}: ${String(putRes.json?.message||putRes.text||'').slice(0,200)}`);
  return {
    path:archivePath,
    branch,
    sha:String(putRes.json?.content?.sha || putRes.json?.commit?.sha || ''),
    html_url:String(putRes.json?.content?.html_url || ''),
    download_url:String(putRes.json?.content?.download_url || '')
  };
}
async function archiveFinishedRace612(storage, meta, env){
  if(!githubArchiveEnabled612(env)){
    meta.archive_pending = false;
    meta.archive_skipped = 'GITHUB_NOT_CONFIGURED';
    meta.archive_error = 'GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO を設定してください';
    await storage.put('meta',meta);
    return {ok:false,skipped:true,reason:meta.archive_skipped};
  }
  const {entries,captures} = await loadAllCaptures612(storage);
  if(!captures.length){
    meta.archive_pending = false;
    meta.archived_to_github = true;
    meta.archive_mode = 'EMPTY_NO_CAPTURES';
    meta.archived_at = new Date().toISOString();
    await storage.put('meta',meta);
    return {ok:true,empty:true};
  }
  const payload = buildArchivePayload612(meta,captures);
  const archivePath = archivePath612(meta,env);
  const gh = await uploadArchiveToGitHub612(env, archivePath, payload, meta);
  await deleteCaptures243(storage,entries);
  await storage.put('count',0);
  meta.archive_pending = false;
  meta.archived_to_github = true;
  meta.archive_mode = payload.compression;
  meta.github_archive_path = gh.path;
  meta.github_archive_branch = gh.branch;
  meta.github_archive_sha = gh.sha;
  meta.github_archive_url = gh.html_url || gh.download_url || '';
  meta.archived_at = new Date().toISOString();
  meta.archived_capture_count = Number(payload.stats?.raw_capture_count||0);
  delete meta.retention_warning;
  delete meta.archive_error;
  delete meta.archive_retry_count;
  await storage.put('meta',meta);
  return {ok:true,archivePath:gh.path,sha:gh.sha,captures:Number(payload.stats?.raw_capture_count||0)};
}

export class OddsTimelineCollector {
  constructor(ctx,env){ this.ctx=ctx; this.env=env; this.storage=ctx.storage; }

  async fetch(request){
    const url=new URL(request.url); const path=url.pathname;
    if(path.endsWith('/start')){
      const body=request.method==='POST'?await request.json().catch(()=>({})):Object.fromEntries(url.searchParams);
      const meta=await this.start(body); return json({ok:true,version:VERSION,meta});
    }
    if(path.endsWith('/stop')){ const meta=await this.storage.get('meta')||{}; meta.active=false; meta.archive_pending=false; meta.stopped_at=new Date().toISOString(); await this.storage.put('meta',meta); await this.storage.deleteAlarm(); return json({ok:true,meta}); }
    if(path.endsWith('/status')){ return json({ok:true,version:VERSION,meta:await this.storage.get('meta')||null,count:Number(await this.storage.get('count')||0)}); }
    if(path.endsWith('/history')){
      const since=Number(url.searchParams.get('since')||0);
      const limit=Math.max(1,Math.min(5000,Number(url.searchParams.get('limit')||5000)));
      const opts={prefix:'c:',limit:Math.min(MAX_RECORDS,limit+1)};
      if(since>0)opts.startAfter=`c:${String(since).padStart(13,'0')}`;
      const list=await this.storage.list(opts); const rows=[];
      let bytes=0,hasMore=false;
      for(const [,v] of list){
        if(!v || Number(v.captured_ms||0)<=since)continue;
        if(rows.length>=limit || bytes>=3000000){hasMore=true;break;}
        const rec=await readCapture243(this.storage,v);
        rows.push(rec);bytes+=new TextEncoder().encode(JSON.stringify(rec)).byteLength;
      }
      if(list.size>rows.length)hasMore=true;
      rows.sort((a,b)=>a.captured_ms-b.captured_ms);
      return json({ok:true,version:VERSION,count:rows.length,captures:rows,has_more:hasMore,next_since:rows.length?rows[rows.length-1].captured_ms:since});
    }
    if(path.endsWith('/archive')){
      const meta=await this.storage.get('meta')||null;
      if(!meta) return json({ok:false,error:'meta not found'},404);
      const result=await archiveFinishedRace612(this.storage,meta,this.env).catch(e=>({ok:false,error:String(e?.message||e)}));
      return json({ok:!!result?.ok,version:VERSION,result,meta:await this.storage.get('meta')||meta});
    }
    return json({ok:false,error:'unknown DO route'},404);
  }

  async start(body={}){
    const rid=String(body.race_id||'').replace(/\D/g,'');
    if(!/^\d{10,14}$/.test(rid))throw new Error('race_id required');

    const stored=await this.storage.get('meta')||{};
    const same=String(stored.race_id||'')===rid;
    const old=same?stored:{};
    const now=Date.now();

    // v6.1.11: JSTの発走時刻を保持し、発走+3分を停止時刻として一貫して使用する。
    let raceDate=String(body.race_date||body.date||old.race_date||'').trim();
    const dm=raceDate.match(/^(20\d{2})[-/]?(\d{2})[-/]?(\d{2})$/);
    raceDate=dm?`${dm[1]}-${dm[2]}-${dm[3]}`:'';

    let postTime=String(body.post_time||body.discovered_post_time||old.post_time||'').trim();
    const tm=postTime.match(/(?:^|\s)(\d{1,2}):(\d{2})(?:$|\s)/)||postTime.match(/^(\d{1,2}):(\d{2})$/);
    postTime=tm?`${String(Number(tm[1])).padStart(2,'0')}:${tm[2]}`:'';

    let postMs=Number(body.post_ms||body.post_at_ms||0);
    if(!(postMs>0) && raceDate && postTime)postMs=timeMsOnJstDate(raceDate,postTime);
    if(!(postMs>0))postMs=Number(old.post_ms||0);

    const requestedEnd=Number(body.end_at_ms||0);
    const requestedFallback=Number(body.fallback_end_at_ms||0);
    const oldEnd=Number(old.end_at_ms||0);
    const oldFallback=Number(old.fallback_end_at_ms||0);
    const canonicalPostEnd=postMs>0?postMs+DEFAULT_END_AFTER_MS:0;

    let fallbackEnd=requestedFallback>0?requestedFallback:(requestedEnd>0?requestedEnd:0);
    if(!(fallbackEnd>now)){
      if(canonicalPostEnd>now)fallbackEnd=canonicalPostEnd;
      else if(oldFallback>now)fallbackEnd=oldFallback;
      else if(oldEnd>now)fallbackEnd=oldEnd;
      else fallbackEnd=now+3*60*60*1000;
    }

    let endAt=requestedEnd>0?requestedEnd:0;
    if(!(endAt>now)){
      // 発走前〜発走+3分以内なら、過去のend_at_msより発走時刻を優先して復旧。
      if(canonicalPostEnd>now)endAt=canonicalPostEnd;
      else if(oldEnd>now)endAt=oldEnd;
      else endAt=fallbackEnd;
    }
    if(canonicalPostEnd>now && endAt<canonicalPostEnd)endAt=canonicalPostEnd;
    if(fallbackEnd<endAt)fallbackEnd=endAt;

    const recovered=same && oldEnd>0 && oldEnd<=now && endAt>now;
    const meta={
      ...old,
      race_id:rid,
      kind:String(body.kind||old.kind||'JRA').toUpperCase()==='NAR'?'NAR':'JRA',
      race_label:String(body.race_label||old.race_label||rid),
      race_date:raceDate||old.race_date||'',
      post_time:postTime||old.post_time||'',
      upstream_proxy:String(body.upstream_proxy||old.upstream_proxy||this.env.UPSTREAM_PROXY_URL||''),
      interval_ms:Math.max(5000,Math.min(60000,Number(body.interval_ms||old.interval_ms||DEFAULT_INTERVAL_MS))),
      post_ms:postMs>0?postMs:0,
      fallback_end_at_ms:fallbackEnd,
      end_at_ms:endAt,
      active:endAt>now,
      started_at:old.started_at||new Date().toISOString(),
      updated_at:new Date().toISOString(),
      odds_started:same?!!old.odds_started:false,
      odds_first_seen_ms:same?Number(old.odds_first_seen_ms||0):0,
      odds_first_seen_at:same?String(old.odds_first_seen_at||''):'',
      odds_release_source:same?String(old.odds_release_source||''):'',
      phase:(same&&old.odds_started)?'CAPTURING':'WAIT_ODDS',
      archived_to_github:false,
      archive_pending:false,
      archive_mode:'',
      github_archive_path:'',
      github_archive_branch:'',
      github_archive_sha:'',
      github_archive_url:'',
      last_error:''
    };

    if(recovered){
      delete meta.finished_at;
      delete meta.stopped_at;
      delete meta.stop_reason;
      delete meta.finish_ms;
      delete meta.finish_detected_ms;
      delete meta.finish_source;
      delete meta.result_detected_at;
      delete meta.last_result_probe_ms;
      delete meta.last_result_probe_error;
      delete meta.archived_at;
      delete meta.archive_error;
      delete meta.archive_retry_count;
      delete meta.archive_skipped;
      meta.schedule_recovered_at=new Date().toISOString();
      meta.schedule_recovery_reason='STALE_END_AT_BEFORE_CURRENT_POST';
    }

    await this.storage.put('meta',meta);
    if(!meta.active){
      await this.storage.deleteAlarm();
      return meta;
    }
    const alarm=await this.storage.getAlarm();
    if(alarm==null||alarm>now+10000||alarm<now-1000)await this.storage.setAlarm(now+500);
    return meta;
  }

  async alarm(){
    const meta=await this.storage.get('meta');
    if(!meta)return;
    const now=Date.now();

    if(meta.archive_pending){
      try{
        const result=await archiveFinishedRace612(this.storage,meta,this.env);
        if(result?.ok || result?.skipped){
          await this.storage.deleteAlarm();
          return;
        }
      }catch(e){
        meta.archive_error=String(e?.message||e).slice(0,500);
        meta.archive_retry_count=Number(meta.archive_retry_count||0)+1;
        await this.storage.put('meta',meta);
      }
      await this.storage.setAlarm(now+60000);
      return;
    }

    if(!meta.active)return;

    // 発走時刻+3分で厳密停止。結果ページ検出による延長は行わない。
    if(Number(meta.end_at_ms||0)>0 && now>=Number(meta.end_at_ms)){
      meta.active=false;
      meta.phase='FINISHED';
      meta.finished_at=new Date().toISOString();
      meta.stop_reason='POST_PLUS_3M';
      meta.archive_pending=true;
      await this.storage.put('meta',meta);
      try{
        const result=await archiveFinishedRace612(this.storage,meta,this.env);
        if(result?.ok || result?.skipped){
          await this.storage.deleteAlarm();
          return;
        }
      }catch(e){
        meta.archive_error=String(e?.message||e).slice(0,500);
        meta.archive_retry_count=Number(meta.archive_retry_count||0)+1;
        await this.storage.put('meta',meta);
      }
      await this.storage.setAlarm(now+60000);
      return;
    }

    // 発売前: 単勝/複勝の軽量probeを5秒刻み。初回有効オッズを検知した瞬間から本収集へ移行。
    if(!meta.odds_started){
      try{
        const probe=await probeOddsReleased611(meta,this.env);
        meta.last_release_probe_ms=now;
        meta.last_release_probe_at=new Date(now).toISOString();
        meta.last_release_probe_source=probe.source||'';
        meta.last_release_probe_error=(probe.errors||[]).join(' / ').slice(0,500);
        if(!probe.released){
          meta.phase='WAIT_ODDS';
          await this.storage.put('meta',meta);
          await this.storage.setAlarm(Date.now()+releaseProbeMs(this.env));
          return;
        }
        meta.odds_started=true;
        meta.phase='CAPTURING';
        meta.odds_first_seen_ms=now;
        meta.odds_first_seen_at=new Date(now).toISOString();
        meta.odds_release_source=probe.source||'';
        meta.odds_release_count=Number(probe.count||0);
        meta.last_error='';
        delete meta.last_error_at;
        await this.storage.put('meta',meta);
      }catch(e){
        meta.phase='WAIT_ODDS';
        meta.last_release_probe_ms=now;
        meta.last_release_probe_at=new Date(now).toISOString();
        meta.last_release_probe_error=String(e?.message||e).slice(0,500);
        await this.storage.put('meta',meta);
        await this.storage.setAlarm(Date.now()+releaseProbeMs(this.env));
        return;
      }
    }

    try{
      const got=await fetchMarketsSnapshot(meta,this.env);
      const total=marketCount(got.markets);
      if(total>0){
        const rec={schema:'thekeiba-odds-timeline-v1',id:`${meta.race_id}:${now}`,race_id:meta.race_id,kind:meta.kind,race_label:meta.race_label||meta.race_id,captured_ms:now,captured_at:new Date(now).toISOString(),source:'CLOUD_DO:'+got.source,horses:[],markets:got.markets,market_status:got.diagnostics};
        await saveCapture243(this.storage,`c:${String(now).padStart(13,'0')}`,rec);
        const count=Number(await this.storage.get('count')||0)+1; await this.storage.put('count',count);
        meta.last_capture_ms=now;
        meta.last_capture_at=rec.captured_at;
        meta.last_market_count=total;
        meta.last_ticket_types=Object.keys(got.markets).length;
        meta.last_market_types=meta.last_ticket_types;
        meta.market_status=got.diagnostics;
        meta.last_fetch_mode=String(got.fetch_mode||'UNKNOWN');
        meta.last_place_reconcile=got.place_reconcile||null;
        const missingTypes=MARKET_TYPES.filter(t=>!got.markets[t]?.length);
        if(missingTypes.length){
          meta.last_error='未取得：'+missingTypes.join('・');
          meta.last_error_at=new Date(now).toISOString();
        }else{
          meta.last_error='';
          delete meta.last_error_at;
        }
        await this.storage.put('meta',meta);
        // v6.1.12ではGitHub退避前の一時保持に限定するが、想定外の長時間発売向けに安全弁は残す。
        if(count>MAX_RECORDS && count%50===0){
          meta.retention_warning=`保存件数が${MAX_RECORDS}件を超えました。GitHub退避は停止後に実行されます。必要なら ODDS_ARM_HOURS を短くしてください。`;
          await this.storage.put('meta',meta);
        }
      }
    }catch(e){
      meta.last_error=String(e&&e.message||e);
      meta.last_error_at=new Date().toISOString();
      await this.storage.put('meta',meta);
    }
    if(meta.active)await this.storage.setAlarm(Date.now()+Math.max(5000,Number(meta.interval_ms||DEFAULT_INTERVAL_MS)));
  }}

async function doFetch(env,rid,path,init){
  const id=env.TIMELINE.idFromName(String(rid)); const stub=env.TIMELINE.get(id);
  return await stub.fetch('https://do.internal'+path,init);
}
async function startRace(env,meta){
  const rid=String(meta.race_id||'').replace(/\D/g,''); if(!rid)return null;
  return await doFetch(env,rid,'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(meta)});
}
async function discoverAndStart(env,date=jstYmd(),forceStart=false){
  const base=String(env.MANIFEST_SOURCE_URL||env.UPSTREAM_PROXY_URL||'').replace(/\/$/,'');
  if(!base)return {ok:false,error:'MANIFEST_SOURCE_URL未設定',started:0};
  let j=null,manifestWasEmpty=false;
  try{
    let r=await fetch(base+'/cron-status?date='+encodeURIComponent(date),{cache:'no-store'}); j=await r.json().catch(()=>null);
    if(!j?.manifest?.races?.length){ manifestWasEmpty=true; try{await fetch(base+'/cron-run?discover=1&date='+encodeURIComponent(date),{cache:'no-store'});}catch(_){} r=await fetch(base+'/cron-status?date='+encodeURIComponent(date),{cache:'no-store'}); j=await r.json().catch(()=>null); }
  }catch(e){return {ok:false,error:String(e&&e.message||e),started:0};}
  const races=Array.isArray(j?.manifest?.races)?j.manifest.races:[]; const now=Date.now(); let started=0,eligible=0,skippedRefresh=0;
  for(const r of races){
    const rid=String(r?.race_id||'').replace(/\D/g,''); if(!/^\d{10,14}$/.test(rid))continue;
    const kind=String(r.kind||'JRA').toUpperCase()==='NAR'?'NAR':'JRA';
    const hhmm=String(r.discovered_post_time||r.post_time||'').match(/\d{1,2}:\d{2}/)?.[0]||'';
    let postMs=timeMsOnJstDate(date,hhmm);
    if(!Number.isFinite(postMs))continue;
    const startMs=postMs-armBeforeMs(env),endMs=postMs+DEFAULT_END_AFTER_MS;
    if(now<startMs||now>endMs)continue; eligible++;
    const minsSinceStart=Math.max(0,Math.floor((now-startMs)/60000));
    const initialWindow=minsSinceStart<2;
    const refreshTick=(minsSinceStart%DISCOVER_REFRESH_MINUTES)===0;
    const nearPost=now>=postMs-20*60*1000;
    if(!forceStart && !manifestWasEmpty && !initialWindow && !nearPost && !refreshTick){skippedRefresh++;continue;}
    try{
      await startRace(env,{race_id:rid,kind,race_label:String(r.race_name||`${r.race_no||rid.slice(-2)}R`),race_date:date,post_time:hhmm,upstream_proxy:String(env.UPSTREAM_PROXY_URL||base),interval_ms:DEFAULT_INTERVAL_MS,post_ms:postMs,post_at_ms:postMs,fallback_end_at_ms:endMs,end_at_ms:endMs}); started++;
    }catch(_){ }
  }
  return {ok:true,date,manifest_races:races.length,eligible,started,skipped_refresh:skippedRefresh,force_start:!!forceStart,refresh_minutes:DISCOVER_REFRESH_MINUTES,arm_hours:armBeforeMs(env)/3600000,release_probe_ms:releaseProbeMs(env),stop_after_post_ms:DEFAULT_END_AFTER_MS};
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors()});
    if(url.pathname==='/health')return json({ok:true,version:VERSION,durable_object:true,alarm_interval_ms:DEFAULT_INTERVAL_MS,release_probe_ms:releaseProbeMs(env),arm_hours:armBeforeMs(env)/3600000,stop_after_post_ms:DEFAULT_END_AFTER_MS,stop_mode:'POST_PLUS_3M',odds_release_watch:true,scan_today_and_tomorrow:true,manifest_source:!!env.MANIFEST_SOURCE_URL,upstream_proxy:!!env.UPSTREAM_PROXY_URL,free_request_saver:true,direct_html_batch:true,batch_proxy_path:'/all-markets',legacy_proxy_fallback:String(env.ENABLE_LEGACY_PROXY_FALLBACK||'')==='1',discover_refresh_minutes:DISCOVER_REFRESH_MINUTES,jra_place_reconcile:true,stale_error_clear:true,github_archive:true,github_repo_configured:githubArchiveEnabled612(env),github_branch:githubBranch612(env),github_base_path:githubBasePath612(env),archive_format:'first_full_then_delta'});
    if(url.pathname==='/timeline/discover'){
      if(!tokenOk(request,env))return json({ok:false,error:'unauthorized'},401);
      return json(await discoverAndStart(env,url.searchParams.get('date')||jstYmd(),true));
    }
    const rid=String(url.searchParams.get('race_id')||'').replace(/\D/g,'');
    if(/^\/timeline\/(start|stop|status|history|archive)$/.test(url.pathname)){
      let body=null;
      if(request.method==='POST')body=await request.clone().json().catch(()=>({}));
      const rr=rid||String(body?.race_id||'').replace(/\D/g,'');
      if(!/^\d{10,14}$/.test(rr))return json({ok:false,error:'race_id required'},400);
      if((url.pathname.endsWith('/start')||url.pathname.endsWith('/stop')||url.pathname.endsWith('/archive'))&&!tokenOk(request,env))return json({ok:false,error:'unauthorized'},401);
      if(url.pathname.endsWith('/start')){
        const payload={...(body||{}),race_id:rr,upstream_proxy:String(body?.upstream_proxy||env.UPSTREAM_PROXY_URL||'')};
        return await doFetch(env,rr,'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      }
      if(url.pathname.endsWith('/stop'))return await doFetch(env,rr,'/stop',{method:'POST'});
      if(url.pathname.endsWith('/status'))return await doFetch(env,rr,'/status');
      if(url.pathname.endsWith('/archive'))return await doFetch(env,rr,'/archive',{method:'POST'});
      const q=new URLSearchParams(); if(url.searchParams.has('since'))q.set('since',url.searchParams.get('since')); if(url.searchParams.has('limit'))q.set('limit',url.searchParams.get('limit'));
      return await doFetch(env,rr,'/history?'+q.toString());
    }
    return json({ok:false,error:'route not found',version:VERSION},404);
  },
  async scheduled(controller,env,ctx){
    const now=Date.now();
    ctx.waitUntil(Promise.all([
      discoverAndStart(env,jstYmd(now),false),
      discoverAndStart(env,jstYmd(now+24*60*60*1000),false)
    ]));
  }
};
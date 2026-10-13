import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readPayclock } from './payclock-reader.mjs';
const within = (root, target) => { const p = path.relative(root, target); return p === '' || (!p.startsWith('..') && !path.isAbsolute(p)); };
export async function readBounded(root, file) {
  const base = await realpath(root), candidate = path.resolve(root, file);
  if (!within(path.resolve(root), candidate)) throw Error('Path outside source');
  const meta = await lstat(candidate);
  if (meta.isSymbolicLink() || !meta.isFile() || meta.size > 10_000_000) throw Error('Unsafe source file');
  const resolved = await realpath(candidate);
  if (!within(base, resolved)) throw Error('Path outside source');
  return readFile(resolved, 'utf8');
}
const text = (v, max=160) => typeof v === 'string' ? v.slice(0,max) : '';
export function normalizePartner(p) {
  if (!p || typeof p !== 'object' || !p.id || !p.status || !Number.isFinite(Date.parse(p.receivedAt))) return null;
  const o = p.fishbowlSalesOrder, items = Array.isArray(o?.items) ? o.items : [];
  const pushed = p.status === 'pushed' || p.fishbowlPush?.ok === true;
  const flagged = p.status === 'partial' || o?.meta?.needsReview === true || o?.customerMatch?.needsReview === true || items.some(x=>x.match?.needsReview === true);
  const review = flagged && !pushed;
  return {id:text(p.id), date:p.receivedAt, updated:p.processedAt || p.receivedAt, status:text(p.status), review,
    failed: ['agent_failed','push_failed'].includes(p.status), customer:text(o?.customerName) || 'Not extracted',
    po:text(o?.customerPO), so:text(o?.soNumber || p.fishbowlPush?.soNumber), lines:items.length,
    exported:!!p.fishbowlImportCsvPath, pushed, flagged};
}
export async function partnerSource(folder) {
  try {
    const files = (await readdir(folder)).filter(n=>n.endsWith('.json'));
    const records = [], errors = [];
    for (const file of files) {
      try { const r=normalizePartner(JSON.parse(await readBounded(folder,file))); if(r) records.push(r); else errors.push(file); }
      catch {errors.push(file);}
    }
    // Payload revisions normally reuse IDs. Keep newest if copies exist.
    const unique = new Map();
    for(const r of records) if(!unique.has(r.id) || r.updated > unique.get(r.id).updated) unique.set(r.id,r);
    return {state:'connected', records:[...unique.values()], errors:errors.length, detail:'Saved processing results; not the full Gmail backlog.'};
  } catch {return {state:'unavailable',records:[],errors:0,detail:'Payload folder unavailable.'};}
}
// FedFish Central serves history and blocking only to this computer, so Mira only ever calls it on loopback.
export function centralUrl(base, route) {
  const u=new URL(route, base);
  if(!['https:','http:'].includes(u.protocol) || !['localhost','127.0.0.1','[::1]'].includes(u.hostname) || u.username || u.password) throw Error('FedFish Central must be reached on this computer');
  return u;
}
const centralCas=new Map();
export async function centralRequest(central, method, route, body) {
  const u=centralUrl(central.url, route);
  let ca;
  if(u.protocol==='https:' && central.caFile){if(!centralCas.has(central.caFile))centralCas.set(central.caFile,await readFile(central.caFile,'utf8'));ca=centralCas.get(central.caFile);}
  const data=body===undefined?null:Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const req=(u.protocol==='https:'?https:http).request(u,{method,ca,agent:false,timeout:8000,headers:data?{'Content-Type':'application/json','Content-Length':data.length}:{}},res=>{
      const chunks=[];let size=0;
      res.on('data',c=>{size+=c.length;if(size>30_000_000)req.destroy(Error('FedFish Central response too large'));else chunks.push(c);});
      res.on('error',reject);
      res.on('end',()=>{let p;try{p=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(Error('FedFish Central sent an unreadable response'));}
        if(res.statusCode>=400)return reject(Object.assign(Error(typeof p?.error==='string'?p.error.slice(0,200):'FedFish Central HTTP '+res.statusCode),{status:res.statusCode}));
        resolve(p);});
    });
    req.on('timeout',()=>req.destroy(Error('FedFish Central did not answer')));
    req.on('error',reject);
    if(data)req.end(data);else req.end();
  });
}
const when=v=>typeof v==='string' && Number.isFinite(Date.parse(v))?v:null;
export function normalizeSend(s) {
  if(!s || !Number.isInteger(s.sequence) || typeof s.so_num!=='string' || typeof s.client_name!=='string' || !['succeeded','failed','unknown'].includes(s.outcome)) return null;
  return {sequence:s.sequence, so:text(s.so_num), po:text(s.po_number), shipTo:text(s.ship_to), pc:text(s.client_name), outcome:s.outcome,
    failed:s.outcome==='failed', error:text(s.error,300), at:when(s.occurred_at), legacy:s.source==='legacy-cache'};
}
export function normalizePc(p) {
  if(!p || typeof p.name!=='string' || !p.name) return null;
  return {name:p.name.slice(0,100), blocked:p.blocked===true, firstSeen:when(p.first_seen), lastSeen:when(p.last_seen), lastSend:when(p.last_send),
    computer:text(p.computer), user:text(p.windows_user), sends:Number(p.sends)||0, failed:Number(p.failed)||0};
}
// Central history is append-only, so after the first read only newer sends are fetched.
let fedfishHistory={url:null,after:0,rows:[]}, fedfishReading=null;
async function readFedfish(central, retried=false) {
  if(fedfishHistory.url!==central.url) fedfishHistory={url:central.url,after:0,rows:[]};
  for(let page=0;page<100;page++){
    const p=await centralRequest(central,'GET',`/v1/sends?after=${fedfishHistory.after}&limit=5000`);
    if(!Array.isArray(p.sends) || !Number.isInteger(p.next_after)) throw Error('Unexpected FedFish Central format');
    for(const s of p.sends){const r=normalizeSend(s);if(r)fedfishHistory.rows.push(r);}
    fedfishHistory.after=p.next_after;
    if(p.sends.length<5000) break;
  }
  const p=await centralRequest(central,'GET','/v1/pcs');
  if(!Array.isArray(p.pcs)) throw Error('Unexpected FedFish Central format');
  const pcs=p.pcs.map(normalizePc).filter(Boolean);
  // Fewer recorded sends than already read means Central's database was replaced (for example restored from a backup).
  if(!retried && pcs.reduce((n,x)=>n+x.sends,0)<fedfishHistory.rows.length){fedfishHistory={url:central.url,after:0,rows:[]};return readFedfish(central,true);}
  return {state:'connected',rows:fedfishHistory.rows,pcs,checkedAt:new Date().toISOString(),
    detail:'Every Synapse send FedFish Central has recorded from all FedFish PCs. A recorded send does not prove the order shipped.'};
}
export function fedfishSource(config) {
  const central=config.fedfishCentral;
  if(!central?.url) return Promise.resolve({state:'disabled',rows:[],pcs:[],detail:'FedFish Central connection not configured.'});
  fedfishReading??=readFedfish(central)
    .catch(()=>({state:'unavailable',rows:[],pcs:[],detail:'FedFish Central is not answering on this computer. It starts when you log in; Start FedFish Central.bat starts it by hand.'}))
    .finally(()=>{fedfishReading=null;});
  return fedfishReading;
}
export function setFedfishBlocked(config, name, blocked) {
  if(!config.fedfishCentral?.url) return Promise.reject(Error('FedFish Central connection not configured.'));
  return centralRequest(config.fedfishCentral,'POST','/v1/pcs',{name,blocked});
}
async function payclockSource(config) {
  if(config.payclock?.cacheSummary){try{return JSON.parse(await readFile(config.payclock.cacheSummary,'utf8'));}catch{}}
  return readPayclock(config.payclockExports);
}
let inventoryCache, inventoryExpiry=0;
export function inventoryUrl(value) {
  const u=new URL(value);
  if(u.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.pathname!=='/api/parts/inventory' || u.username || u.password) throw Error('Inventory must use the local read endpoint');
  u.search=''; u.searchParams.set('pageSize','1000');u.searchParams.set('pageNumber','1');u.searchParams.set('includeZeroQuantities','true');return u;
}
async function inventorySource(config) {
  if(!config.inventory.enabled) return {state:'disabled',rows:[],detail:'Inventory connection disabled.'};
  if(inventoryCache && Date.now()<inventoryExpiry) return inventoryCache;
  try {
    const u=inventoryUrl(config.inventory.url);
    const headers=process.env.MIR_INVENTORY_READ_TOKEN ? {Authorization:'Bearer '+process.env.MIR_INVENTORY_READ_TOKEN} : {};
    const res=await fetch(u,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!res.ok) throw Error(res.status===401?'Read credential required':'Inventory service unavailable');
    const p=await res.json();if(!Array.isArray(p.results)) throw Error('Unexpected inventory format');
    const all=[...p.results];let incomplete=false;
    const pages=Math.min(50,Math.max(1,Number(p.totalPages)||Math.ceil(Number(p.totalCount)/1000)));
    for(let page=2;page<=pages;page++){
      try {u.searchParams.set('pageNumber',String(page));const next=await fetch(u,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(12000)});if(!next.ok)throw Error();const data=await next.json();if(!Array.isArray(data.results))throw Error();all.push(...data.results);if(data.totalCount!==p.totalCount)incomplete=true;}
      catch {incomplete=true;break;}
    }
    // Same part can appear in multiple warehouses. The API omits warehouse IDs,
    // so retain rows; never collapse or sum quantities into an invented total.
    inventoryCache={state:'connected',rows:all.map(x=>({part:text(x.partNumber),description:text(x.partDescription),quantity:x.quantity==null?NaN:Number(x.quantity),uom:text(x.uom?.abbreviation)})),total:p.totalCount,
      partial:incomplete || Number(p.totalCount)!==all.length, checkedAt:new Date().toISOString(),detail:'Local GET API; cached 15 minutes. Rows may represent different warehouses; warehouse identifiers are absent. No cross-warehouse quantity totals.'};
  } catch(e) {inventoryCache={state:'unavailable',rows:[],detail:e.message==='Read credential required'?e.message:'Local inventory endpoint unavailable; no credentials borrowed.'};}
  inventoryExpiry=Date.now()+Math.max(1,config.inventory.cacheMinutes || 15)*60000;
  return inventoryCache;
}
export const dayKey=(value,tz='America/Los_Angeles')=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export function assess(sources, days=30, now=new Date(), tz='America/Los_Angeles') {
  const end=dayKey(now,tz);const startDate=new Date(end+'T12:00:00Z');startDate.setUTCDate(startDate.getUTCDate()-days+1);const start=startDate.toISOString().slice(0,10);
  const inPeriod=value=>{const d=dayKey(value,tz);return d>=start && d<=end;};
  const orders=sources.partner.records.filter(r=>inPeriod(r.date));
  const labor=sources.payclock.rows.filter(r=>r.date>=start && r.date<=end);
  // Past orders imported from old caches have no send time: they count toward each order's latest send, not toward a period.
  const newest=(a,b)=>a<b?1:a>b?-1:0, sendKey=r=>(r.at || '')+' '+String(r.sequence).padStart(12,'0');
  const sends=sources.fedfish.rows, sent=sends.filter(r=>r.at && inPeriod(r.at)).sort((a,b)=>newest(sendKey(a),sendKey(b))), latest=new Map();
  for(const r of sends) if(!latest.has(r.so) || sendKey(r)>sendKey(latest.get(r.so))) latest.set(r.so,r);
  const failing=[...latest.values()].filter(r=>r.failed).sort((a,b)=>newest(sendKey(a),sendKey(b)));
  const m={orders:orders.length,review:orders.filter(r=>r.review).length,failed:orders.filter(r=>r.failed).length,pushed:orders.filter(r=>r.pushed).length,
    pending:orders.filter(r=>r.status==='pending_agent').length,workedHours:Math.round(labor.reduce((s,r)=>s+(Number(r.hours)||0),0)*100)/100,
    reviewDays:labor.filter(r=>r.status==='review').length,laborRows:labor.length,
    overtimeHours:Math.round(labor.reduce((s,r)=>s+(Number(r.overtime)||0),0)*100)/100,
    overtimeKnown: labor.length>0 && labor.every(r=>r.overtime != null),zeroStock:sources.inventory.rows.filter(r=>Number.isFinite(r.quantity) && r.quantity<=0).length,
    fedfishSends:sent.length,fedfishFailed:sent.filter(r=>r.failed).length,fedfishFailing:failing.length};
  const insights=[];
  if(m.failed) insights.push({priority:'High',title:'Investigate processing failures',evidence:`${m.failed} saved orders have failed extraction or Fishbowl push in this period.`,recommendation:'Review these orders in AI Email Processor and identify the common failure before deciding on a retry.',measure:'Track the failed-order count and recurrence by cause.',basis:'AI Email Processor · selected period'});
  if(m.review) insights.push({priority:'High',title:'Clear the product and customer review queue',evidence:`${m.review} saved orders carry a review flag.`,recommendation:'Assign a daily human review window. Check product matches and customer mappings in the original system.',measure:'Reduce outstanding review flags after human verification.',basis:'AI Email Processor · selected period'});
  if(m.pending) insights.push({priority:'Medium',title:'Check pending extraction runs',evidence:`${m.pending} saved payloads are pending an agent.`,recommendation:'Check their original processing runs before resubmitting; incomplete or old payloads may not reflect current state.',measure:'Confirm which pending runs are still active.',basis:'AI Email Processor · selected period'});
  if(m.reviewDays) insights.push({priority:'High',title:'Resolve timesheet exceptions with payroll',evidence:`${m.reviewDays} exported employee-days need review.`,recommendation:'Have payroll verify missing or extra punches against source records. These flags alone do not measure employee performance.',measure:'Count verified exceptions before payroll approval.',basis:'Payclock · selected period'});
  if(sources.payclock.latestDay && sources.payclock.latestDay<start) insights.push({priority:'Medium',title:'Refresh the attendance evidence',evidence:`Latest exported work date is ${sources.payclock.latestDay}; selected period starts ${start}.`,recommendation:'Create a fresh export using the existing Payclock workflow. Current attendance and staffing cannot be inferred from historical exports.',measure:'Latest exported work date covers the reporting period.',basis:'Payclock · export coverage'});
  if(m.zeroStock) insights.push({priority:'Medium',title:'Review stock availability before commitments',evidence:`${m.zeroStock} returned inventory rows have zero available quantity${sources.inventory.partial ? ' in a partial API snapshot' : ''}. The same part may appear for multiple warehouses.`,recommendation:'Check the relevant warehouse before promising availability. Reorder quantities require warehouse identity, demand, supplier lead times and stock policies that are absent here.',measure:'Verify availability for the warehouse serving the order.',basis:'Inventory · current cached snapshot'});
  if(m.fedfishFailing) insights.push({priority:'High',title:'Check failed FedFish sends',evidence:`${m.fedfishFailing} sales orders have a failed latest Synapse send in FedFish Central.`,recommendation:'Verify Synapse state and the original error before any resend to avoid duplicate orders.',measure:'Confirm each failed send in the original application.',basis:'FedFish Central · all FedFish PCs'});
  if(!insights.length) insights.push({priority:'Info',title:'Build a reliable operating baseline',evidence:`${m.orders} saved orders and ${m.laborRows} exported employee-days cover this period.`,recommendation:'Confirm source coverage first, then track weekly exceptions and throughput. Missing records do not prove a healthy operation.',measure:'Complete reporting coverage for each source.',basis:'Connected source coverage'});
  const daily=[];for(let i=0;i<days;i++){const d=new Date(start+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);const key=d.toISOString().slice(0,10);daily.push({date:key,orders:orders.filter(r=>dayKey(r.date,tz)===key).length});}
  return {period:{start,end,days},metrics:m,insights,daily,orders:orders.sort((a,b)=>b.date.localeCompare(a.date)),labor,
    fedfish:{recent:sent.slice(0,15),failing:failing.slice(0,15),pcs:sources.fedfish.pcs || []}};
}
export async function snapshot(config,days=30) {
  const [partner,fedfish,payclock,inventory]=await Promise.all([partnerSource(config.partnerPayloads),fedfishSource(config),payclockSource(config),inventorySource(config)]);
  const sources={partner,fedfish,payclock,inventory};
  return {company:config.company,checkedAt:new Date().toISOString(),timezone:config.timezone,sources,...assess(sources,days,new Date(),config.timezone),
    ai:{enabled:config.ai.enabled,provider:config.ai.provider,configured:!!config.ai.model && (config.ai.provider==='ollama' || !!process.env.OPENAI_API_KEY),cloudAllowed:config.ai.allowCloudSummary},
    limits:['Saved results do not expose every queued email or packed shipment.','No order-to-shipment reconciliation without reliable shared identifiers.','No revenue, margin or labor-cost calculation: pricing and wage data are absent.','FedFish Central records what FedFish sent to Synapse, not whether the order shipped. Past orders imported from old FedFish caches have no send time.','Payclock is historical export coverage, not live attendance.','No productivity rankings or employment decisions from hours alone.']};
}
export function modelSummary(s) {
  return {company:s.company,checkedAt:s.checkedAt,period:s.period,metrics:s.metrics,
    sources:Object.fromEntries(Object.entries(s.sources).map(([k,v])=>[k,{state:v.state,detail:v.detail,latestDay:v.latestDay,partial:v.partial,errors:v.errors?.length || (typeof v.errors==='number'?v.errors:0)}])),
    assessments:s.insights,limitations:s.limits};
}

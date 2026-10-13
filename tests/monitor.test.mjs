import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {normalizePartner,normalizeSend,assess,modelSummary,readBounded,partnerSource,inventoryUrl,dayKey,centralUrl,fedfishSource,setFedfishBlocked} from '../monitor.mjs';
import {csvRows,zipMembers,readPayclock} from '../payclock-reader.mjs';
const base=new URL('../../../work/',import.meta.url);await mkdir(base,{recursive:true});
const folder=await mkdtemp(path.join(new URL(base).pathname.replace(/^\/([A-Za-z]:)/,'$1').replaceAll('%20',' '),'mira-tests-'));
const source=p=>({partner:{state:'connected',records:p,errors:0},fedfish:{state:'unavailable',rows:[],pcs:[]},payclock:{state:'connected',rows:[],files:[],errors:[],latestDay:'2026-08-31'},inventory:{state:'connected',rows:[],partial:false}});
test('pushed records with old review flags do not inflate the outstanding queue',()=>{
  const r=normalizePartner({id:'a',status:'pushed',receivedAt:'2026-10-07T12:00:00Z',fishbowlSalesOrder:{items:[{match:{needsReview:true}}]}});
  assert.equal(r.review,false);assert.equal(r.flagged,true);assert.equal(r.pushed,true);
});
test('missing/invalid source records are not fabricated into orders',()=>{assert.equal(normalizePartner({}),null);assert.equal(normalizePartner({id:'a',status:'parsed',receivedAt:'invalid'}),null);});
test('calendar reporting uses Pacific dates at midnight boundaries',()=>{
  assert.equal(dayKey('2026-10-07T02:00:00Z'),'2026-10-06');
  const r=normalizePartner({id:'a',status:'partial',receivedAt:'2026-10-07T02:00:00Z'});
  const a=assess(source([r]),7,new Date('2026-10-07T12:00:00Z'));
  assert.equal(a.period.start,'2026-10-01');assert.equal(a.metrics.orders,1);assert.equal(a.daily.find(x=>x.date==='2026-10-06').orders,1);
});
test('stale payroll exports are disclosed instead of inferring current attendance',()=>{
  const a=assess(source([]),30,new Date('2026-10-07T12:00:00Z'));
  assert.equal(a.metrics.laborRows,0);assert.equal(a.metrics.overtimeKnown,false);assert(a.insights.some(x=>x.title==='Refresh the attendance evidence'));
});
test('FedFish Central sends: latest send per order, and undated past orders stay out of period counts',()=>{
  const rows=[{sequence:1,so_num:'S1',client_name:'Shipping 1',outcome:'failed',occurred_at:null,source:'legacy-cache'},
    {sequence:2,so_num:'S2',client_name:'Shipping 1',outcome:'failed',occurred_at:'2026-10-06T18:00:00+00:00',error:'Synapse create-order failed (422)'},
    {sequence:3,so_num:'S1',client_name:'Packing',outcome:'succeeded',occurred_at:'2026-10-07T18:00:00+00:00'},
    {sequence:4,so_num:'S3',client_name:'Packing',outcome:'shipped'}].map(normalizeSend);
  assert.equal(rows[3],null);assert.equal(rows[0].legacy,true);
  const s=source([]);s.fedfish={state:'connected',rows:rows.slice(0,3),pcs:[]};
  const a=assess(s,7,new Date('2026-10-07T20:00:00Z'));
  assert.equal(a.metrics.fedfishSends,2);assert.equal(a.metrics.fedfishFailed,1);assert.equal(a.metrics.fedfishFailing,1);
  assert.deepEqual(a.fedfish.failing.map(r=>r.so),['S2']);assert.deepEqual(a.fedfish.recent.map(r=>r.so),['S1','S2']);
  assert(a.insights.some(x=>x.title==='Check failed FedFish sends'));
});
test('FedFish Central is only contacted on this computer',()=>{
  assert.equal(centralUrl('https://localhost:4319','/v1/pcs').pathname,'/v1/pcs');
  for(const u of ['https://IT-B-SERV:4319','https://192.168.9.51:4319','https://user:pw@localhost:4319','file:///C:/central'])assert.throws(()=>centralUrl(u,'/v1/pcs'));
});
test('FedFish Central history is read incrementally and blocks are forwarded',async()=>{
  const seen=[];let blocked=false;
  const sends=[{sequence:1,so_num:'S1',client_name:'Shipping 1',outcome:'succeeded',occurred_at:'2026-10-07T18:00:00+00:00'}];
  const central=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;seen.push(req.method+' '+req.url);
    const u=new URL(req.url,'http://127.0.0.1'),after=Number(u.searchParams.get('after'));res.setHeader('Content-Type','application/json');
    if(u.pathname==='/v1/sends'){const page=sends.filter(s=>s.sequence>after);return res.end(JSON.stringify({sends:page,next_after:page.at(-1)?.sequence ?? after}));}
    if(u.pathname==='/v1/pcs' && req.method==='GET')return res.end(JSON.stringify({pcs:[{name:'Shipping 1',blocked,sends:sends.length,failed:0,last_seen:'2026-10-07T18:00:00+00:00'}]}));
    if(u.pathname==='/v1/pcs' && req.method==='POST'){const p=JSON.parse(raw);if(p.name!=='Shipping 1'){res.statusCode=404;return res.end(JSON.stringify({error:`No FedFish PC named "${p.name}" has connected`}));}blocked=p.blocked;return res.end(raw);}
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>central.listen(0,'127.0.0.1',r));
  const config={fedfishCentral:{url:'http://127.0.0.1:'+central.address().port}};
  try{
    let f=await fedfishSource(config);assert.equal(f.state,'connected');assert.equal(f.rows.length,1);assert.equal(f.pcs[0].name,'Shipping 1');
    sends.push({sequence:2,so_num:'S2',client_name:'Shipping 1',outcome:'failed',occurred_at:'2026-10-07T19:00:00+00:00'});
    f=await fedfishSource(config);assert.equal(f.rows.length,2);assert(seen.includes('GET /v1/sends?after=1&limit=5000'));
    await setFedfishBlocked(config,'Shipping 1',true);f=await fedfishSource(config);assert.equal(f.pcs[0].blocked,true);
    await assert.rejects(()=>setFedfishBlocked(config,'Unknown',true),e=>e.status===404 && e.message.includes('Unknown'));
    sends.splice(0);f=await fedfishSource(config);assert.equal(f.rows.length,0,'a replaced Central database is read again from the start');
  }finally{await new Promise(r=>central.close(r));}
  assert.equal((await fedfishSource(config)).state,'unavailable');
});
test('inventory access permits only the fixed local GET endpoint',()=>{
  assert.equal(inventoryUrl('http://127.0.0.1:8080/api/parts/inventory').searchParams.get('includeZeroQuantities'),'true');
  for(const u of ['https://example.com/api/parts/inventory','http://127.0.0.1:8080/delete','http://user:pass@localhost/api/parts/inventory'])assert.throws(()=>inventoryUrl(u));
});
test('model summaries omit customer names, order IDs, employee records and raw bodies',()=>{
  const s={company:'Mir Mosaic',checkedAt:'now',period:{},metrics:{orders:1},sources:source([{customer:'SECRET CUSTOMER',id:'SECRET ID'}]),insights:[],limits:['No raw records']};
  s.sources.payclock.rows=[{employee:'SECRET EMPLOYEE',hours:8}];
  const summary=modelSummary(s),json=JSON.stringify(summary);assert(!json.includes('SECRET'));for(const v of Object.values(summary.sources)){assert.equal(v.records,undefined);assert.equal(v.rows,undefined);}
});
test('source reads preserve bytes and reject traversal',async()=>{
  const file=path.join(folder,'order.json');const raw=JSON.stringify({id:'a',status:'parsed',receivedAt:'2026-10-07T12:00:00Z'});await writeFile(file,raw);
  const hash=b=>createHash('sha256').update(b).digest('hex');const before=hash(await readFile(file));
  const p=await partnerSource(folder);assert.equal(p.records.length,1);assert.equal(hash(await readFile(file)),before);
  await assert.rejects(()=>readBounded(folder,'../outside.json'));
});
test('CSV parser preserves quoted names and deduplicates overlapping employee/day exports',async()=>{
  assert.equal(csvRows('name,date\n"Doe, Jane",2026-08-01\n')[0].name,'Doe, Jane');
  const exports=path.join(folder,'exports');await mkdir(exports);
  const headers='name,date,hours_worked,status\n';
  await writeFile(path.join(exports,'hours_daily_20260801_to_20260802.csv'),headers+'Jane,2026-08-01,8,ok\n');
  await new Promise(r=>setTimeout(r,20));await writeFile(path.join(exports,'hours_daily_20260801_to_20260803.csv'),headers+'Jane,2026-08-01,7,review\n');
  const p=await readPayclock(exports);assert.equal(p.rows.length,1);assert.equal(p.rows[0].hours,7);assert(!JSON.stringify(p).includes('Jane'));
});
test('invalid spreadsheet archives fail closed',()=>{assert.throws(()=>zipMembers(Buffer.from('invalid archive data')));});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createPayclockService,validateRange} from '../payclock-service.mjs';
import {csvRows} from '../payclock-reader.mjs';
import {createCorrections} from '../corrections.mjs';
import {readFile,mkdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url),'utf8'));
// Baseline parity includes the full fixture; inactive filtering is tested separately.
config.payclock.excludedEmployees=[];
test('date ranges reject invalid dates and bound device workload',()=>{
  validateRange('2026-09-01','2026-09-15');validateRange('2026-09-01','2026-09-01');
  validateRange('2020-01-01','2026-10-12',36524);
  for(const pair of [['2026-02-30','2026-03-01'],['2026-09-02','2026-09-01'],['2026-01-01','2026-12-31'],['--host','2026-09-15']])assert.throws(()=>validateRange(...pair));
});
test('saved CSV reports persist, reject incomplete coverage, and export filtered Excel',async t=>{
  const parent=path.join(root,'tests','scratch');await mkdir(parent,{recursive:true});const folder=await mkdtemp(path.join(parent,'service-'));
  assert(path.relative(parent,folder).startsWith('service-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  await Promise.all(['payclock-report.py','payclock-cache.py','punch-review.py'].map(name=>copyFile(path.join(root,name),path.join(folder,name))));
  const service=createPayclockService(config,folder),files=await service.sources();
  assert(files.length>=2);assert(files.every(f=>!Object.hasOwn(f,'file')));
  const file=files.find(f=>f.name==='punches_20260810_to_20260823.csv');
  await assert.rejects(()=>service.start({source:'csv',file:'../../config.json',start:'2026-08-10',end:'2026-08-23'}));
  await assert.rejects(()=>service.start({source:'csv',file:file.id,start:'2026-08-10',end:'2026-09-01'}));
  const job=await service.start({source:'csv',file:file.id,start:'2026-08-10',end:'2026-08-23'});
  await assert.rejects(()=>service.start({source:'clock',start:'2026-08-10',end:'2026-08-23'}),e=>e.status===409);
  let result;for(let i=0;i<100;i++){result=service.get(job.id);if(result.state!=='running')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result.state,'ready',result.error);assert.equal(result.report.punchCount,1716);assert.equal(result.report.dailyHeaders.length,17);assert.equal(service.get('unknown'),null);
  const id=result.report.totals[0].employeeId;
  await assert.rejects(()=>service.excel({id:job.id,filters:{sheet:'daily',team:'all',employee:'999999',day:'',sortColumn:2,sortDirection:1}}));
  const excel=await service.excel({id:job.id,filters:{sheet:'daily',team:'all',employee:id,day:'',sortColumn:2,sortDirection:-1}});
  for(let i=0;i<100;i++){result=service.get(excel.id);if(result.state!=='running')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result.state,'ready',result.error);const download=service.download(excel.id);assert(download.filename.endsWith('.xlsx'));assert.equal(download.buffer.subarray(0,2).toString(),'PK');
  const reopened=createPayclockService(config,folder);const latest=await reopened.latest();
  const expected=new Map();
  for(const source of files.slice().reverse()){
    for(const [key,r] of expected)if(r.timestamp.slice(0,10)>=source.start&&r.timestamp.slice(0,10)<=source.end)expected.delete(key);
    for(const r of csvRows(await readFile(path.join(config.payclockExports,source.name),'utf8')))expected.set([r.employee_id,r.timestamp,r.workcode,r.source].join('|'),r);
  }
  assert.equal(latest.punchCount,1716);assert.equal(latest.cache.punches,expected.size);
  const selection=['2026-08-10','2026-08-12'];
  const selected=await reopened.start({source:'cache',start:selection[0],end:selection[1],selectedDates:selection});
  for(let i=0;i<100;i++){result=reopened.get(selected.id);if(result.state!=='running')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result.state,'ready',result.error);assert.deepEqual(result.report.selectedDates,selection);
  assert(result.report.daily.every(r=>selection.includes(r.values[2])));
  assert.deepEqual(result.report.fetchedRanges,[]);
  const row=result.report.daily.find(r=>r.punches.length===4),raw=row.punches.slice(),edits=await createCorrections(folder);
  edits.save({employee:row.employeeId,day:row.values[2],revision:0,note:'Test local disabled extra',punches:raw.map((time,i)=>({time,enabled:i!==2,role:['in','lunchOut','lunchIn','out'][i]}))},'Emin');assert.throws(()=>edits.save({employee:row.employeeId,day:row.values[2],revision:1,original:raw.slice(1),note:'Outdated clock snapshot',punches:raw.map((time,i)=>({time,enabled:true,role:['in','lunchOut','lunchIn','out'][i]}))},'Fatima'),e=>e.status===409);edits.close();
  const correction=await reopened.start({source:'cache',start:row.values[2],end:row.values[2]});
  for(let i=0;i<100;i++){result=reopened.get(correction.id);if(result.state!=='running')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result.state,'ready',result.error);const changed=result.report.daily.find(r=>r.employeeId===row.employeeId);assert.equal(changed.punches.length,3);assert.deepEqual(changed.originalPunches,raw);assert.equal(changed.audit[0].actor,'Emin');assert.equal(result.report.adjustmentsRevision,1);assert.equal(result.report.cache.punches,expected.size);
});

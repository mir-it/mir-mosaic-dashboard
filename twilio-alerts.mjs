import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {createEmployeePhones} from './employee-phones.mjs';
export async function createAlertSms(root,fetcher=fetch){
 const folder=path.join(root,'data','alerts');await mkdir(folder,{recursive:true});const file=path.join(folder,'twilio.json'),queueFile=path.join(folder,'employee-lunch-sms.json');const phones=await createEmployeePhones(root);let queue;try{queue=JSON.parse(await readFile(queueFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;queue=[];}let busy=false;
 const save=async()=>{await writeFile(queueFile+'.tmp',JSON.stringify(queue,null,2));await rename(queueFile+'.tmp',queueFile);};
 async function config(){try{const c=JSON.parse(await readFile(file,'utf8'));return {...c,ready:c.enabled===true&&/^AC[0-9a-f]{32}$/i.test(c.accountSid||'')&&/^[0-9a-f]{32}$/i.test(c.authToken||'')&&/^\+[1-9]\d{7,14}$/.test(c.from||'')};}catch{return {ready:false};}}
 return {
  phones,
  async status(){const c=await config();const problem=queue.findLast(q=>['unknown','failed'].includes(q.state));return {ready:c.ready,mode:'employee-lunch-only',assigned:Object.values(phones.list()).filter(p=>p.phone).length,pending:queue.filter(q=>q.state==='pending').length,problem:problem?.error||null};},
  async processLunch(events,today){if(busy)return;busy=true;try{const eligible=events.filter(e=>e.kind==='lunch'&&e.lunchOutMissing===true&&e.day===today);const active=new Map(eligible.map(e=>[e.id,e]));
   for(const q of queue)if(q.state==='pending'&&(q.day!==today||!active.has(q.id)||phones.list()[q.employee]?.phone!==q.to))q.state='cancelled';
   for(const e of eligible){const phone=phones.list()[e.employee]?.phone;if(!phone||queue.some(q=>q.id===e.id&&q.state!=='cancelled'))continue;queue.push({id:e.id,employee:e.employee,day:today,to:phone,body:'Mir Mosaic: '+e.name+', no lunch-out punch is recorded for you today, '+today+', after five hours from your first punch.',state:'pending',createdAt:new Date().toISOString()});}
   await save();const c=await config();if(!c.ready)return;
   for(const q of queue){if(q.state!=='pending')continue;q.state='unknown';await save();try{const r=await fetcher('https://api.twilio.com/2010-04-01/Accounts/'+c.accountSid+'/Messages.json',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(c.accountSid+':'+c.authToken).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:q.to,From:c.from,Body:q.body}),signal:AbortSignal.timeout(30000)});const value=await r.json();if(!r.ok||!value.sid){q.state='failed';q.error='Twilio rejected lunch SMS'+(Number.isInteger(value.code)?' (code '+value.code+')':'.');await save();continue;}q.sid=value.sid;q.state='accepted';q.acceptedAt=new Date().toISOString();await save();}catch{q.error='SMS acceptance unconfirmed; check Twilio logs before retrying.';await save();}}
  }finally{busy=false;}}
 };
}

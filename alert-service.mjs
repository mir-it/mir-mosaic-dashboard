import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';import path from 'node:path';
import {attendanceAlerts,alertMessage} from './attendance-alerts.mjs';import {shiftDay,localParts} from './payclock-scheduler.mjs';
export async function createAttendanceService(root,payclock,gmail,now=()=>new Date(),dashboardUrl='http://192.168.9.51:4320/payclock',sms=null){
 const folder=path.join(root,'data','alerts');await mkdir(folder,{recursive:true});const settingsFile=path.join(folder,'settings.json'),stateFile=path.join(folder,'delivery.json');
 let settings;try{settings=JSON.parse(await readFile(settingsFile,'utf8'));}catch{settings={enabled:true,recipients:['emin@mir-mosaic.com','fatima@mir-mosaic.com'],lateCount:3,absenceDays:3,excludedEmployees:[],excusedDays:[],timeZone:'America/Los_Angeles'};await writeFile(settingsFile,JSON.stringify(settings,null,2));}
 let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch{state={delivered:{},history:[]};}state.warehouseDelivered??={};let busy=false,sending=false,preview=[];
 const save=async()=>{await writeFile(stateFile+'.tmp',JSON.stringify(state,null,2));await rename(stateFile+'.tmp',stateFile);};
 async function scan(pull){if(busy)throw Object.assign(Error('An attendance scan is already running.'),{status:409});busy=true;try{const today=localParts(now(),settings.timeZone).date,job=await payclock.start({source:pull?'auto':'cache',start:shiftDay(today,-45),end:today,saveView:false});let value;do{await new Promise(r=>setTimeout(r,500));value=payclock.get(job.id);}while(value?.state==='running');if(value?.state!=='ready')throw Error(value?.error||'Attendance data unavailable.');const groups=new Map(value.report.daily.map(r=>[r.employeeId,r.group]));preview=attendanceAlerts(value.report,settings,now()).map(e=>({...e,group:groups.get(e.employee)}));state.lastScan=new Date().toISOString();state.error=null;await save();return preview;}finally{busy=false;}}
 const service={
  async status(){return {settings,sms:sms?await sms.status():null,gmail:await gmail.status(),busy,lastScan:state.lastScan,lastSent:state.lastSent,error:state.error,deliveryUnknown:state.inFlight||null,preview,history:state.history.slice(-20)};},
  async configure(input){const warehouseRecipients=input.warehouseRecipients===undefined?(settings.warehouseRecipients||[]):String(input.warehouseRecipients).split(/[;,\s]+/).filter(Boolean);if(warehouseRecipients.length>20||warehouseRecipients.some(s=>!/^[-.\w+]+@[-.\w]+\.[a-z]{2,}$/i.test(s)))throw Error('Enter valid warehouse recipient email addresses.');const recipients=String(input.recipients||'').split(/[;,\s]+/).filter(Boolean);if(recipients.length>20||recipients.some(s=>!/^[-.\w+]+@[-.\w]+\.[a-z]{2,}$/i.test(s)))throw Error('Enter valid recipient email addresses.');for(const key of ['lateCount','absenceDays'])if(!Number.isInteger(input[key])||input[key]<1||input[key]>20)throw Error('Thresholds must be between 1 and 20.');const excusedDays=String(input.excusedDays||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{const [employee,start,end]=line.split(/[,\s]+/);const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d))&&new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d;if(!/^\d+$/.test(employee||'')||!valid(start)||!valid(end)||start>end)throw Error('Use one approved-leave line per employee: ID, YYYY-MM-DD, YYYY-MM-DD.');return {employee,start,end};});if(excusedDays.length>500)throw Error('Too many leave exceptions.');settings={...settings,warehouseRecipients,excusedDays,enabled:Boolean(input.enabled),recipients,lateCount:input.lateCount,absenceDays:input.absenceDays,excludedEmployees:String(input.excludedEmployees||'').split(/[,\s]+/).filter(x=>/^\d+$/.test(x))};await writeFile(settingsFile+'.tmp',JSON.stringify(settings,null,2));await rename(settingsFile+'.tmp',settingsFile);return settings;},
  async retryUnconfirmed(){state.inFlight=null;state.error=null;await save();},
  preview:()=>scan(false),
  async sendNow(){
   if(busy||sending)throw Object.assign(Error('An attendance scan or delivery is already running.'),{status:409});
   if(state.inFlight)throw Object.assign(Error('Check the unconfirmed delivery in Gmail Sent before retrying.'),{status:409});
   if(!settings.recipients.length&&!(settings.warehouseRecipients||[]).length)throw Error('Save at least one recipient first.');
   sending=true;
   try{if(!(await gmail.status()).connected)throw Error('Connect it@ Gmail first.');const events=await scan(true);let sentCount=0,emails=0;
    const streams=[{key:'all',recipients:settings.recipients,delivered:state.delivered,events},{key:'warehouse',recipients:settings.warehouseRecipients||[],delivered:state.warehouseDelivered,events:events.filter(e=>e.group==='Warehouse')}];
    for(const stream of streams){if(!stream.recipients.length)continue;const fresh=stream.events.filter(e=>!stream.delivered[e.id]);if(!fresh.length)continue;
     state.inFlight={at:new Date().toISOString(),stream:stream.key,ids:fresh.map(e=>e.id),recipients:[...stream.recipients]};await save();
     const message=alertMessage(fresh,localParts(now(),settings.timeZone).date,dashboardUrl);if(stream.key==='warehouse')message.subject='Warehouse · '+message.subject;
     const messageId=await gmail.send(state.inFlight.recipients,message),sentAt=new Date().toISOString();
     for(const e of fresh)stream.delivered[e.id]={sentAt,messageId};
     state.history.push({stream:stream.key,sentAt,messageId,count:fresh.length,recipients:state.inFlight.recipients,items:fresh.map(e=>({employee:e.employee,name:e.name,kind:e.kind,description:e.description}))});state.lastSent=sentAt;state.inFlight=null;await save();sentCount+=fresh.length;emails++;
     if(sms&&stream.key==='all'){try{await sms.enqueue(messageId,message.subject+'\n\n'+message.text);await sms.drain();}catch{state.error='Email sent; SMS queue could not be updated.';await save();}}
    }
    return {sent:emails>0,count:sentCount,message:emails?'Sent '+emails+' attendance email(s).':'No new attendance alerts to send. Previously sent issues are not repeated.'};
   }catch(e){state.error=e.message;await save().catch(()=>{});throw e;}finally{sending=false;}
  },
  async tick(){if(sms)await sms.drain().catch(()=>{});if(busy||sending||!settings.enabled||(!settings.recipients.length&&!(settings.warehouseRecipients||[]).length)||!(await gmail.status()).connected||state.inFlight)return;const {hour}=localParts(now(),settings.timeZone);if(hour<6||hour>=21)return;try{await service.sendNow();}catch{} }

 };return service;
}

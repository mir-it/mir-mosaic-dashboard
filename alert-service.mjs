import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';import path from 'node:path';
import {attendanceAlerts,alertMessage} from './attendance-alerts.mjs';import {shiftDay,localParts} from './payclock-scheduler.mjs';
export async function createAttendanceService(root,payclock,gmail,now=()=>new Date(),dashboardUrl='http://192.168.9.51:4320/payclock'){
 const folder=path.join(root,'data','alerts');await mkdir(folder,{recursive:true});const settingsFile=path.join(folder,'settings.json'),stateFile=path.join(folder,'delivery.json');
 let settings;try{settings=JSON.parse(await readFile(settingsFile,'utf8'));}catch{settings={enabled:true,recipients:['emin@mir-mosaic.com','fatima@mir-mosaic.com'],lateCount:3,absenceDays:3,excludedEmployees:[],excusedDays:[],timeZone:'America/Los_Angeles'};await writeFile(settingsFile,JSON.stringify(settings,null,2));}
 let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch{state={delivered:{},history:[]};}let busy=false,sending=false,preview=[];
 const save=async()=>{await writeFile(stateFile+'.tmp',JSON.stringify(state,null,2));await rename(stateFile+'.tmp',stateFile);};
 async function scan(pull){if(busy)throw Object.assign(Error('An attendance scan is already running.'),{status:409});busy=true;try{const today=localParts(now(),settings.timeZone).date,job=await payclock.start({source:pull?'auto':'cache',start:shiftDay(today,-45),end:today,saveView:false});let value;do{await new Promise(r=>setTimeout(r,500));value=payclock.get(job.id);}while(value?.state==='running');if(value?.state!=='ready')throw Error(value?.error||'Attendance data unavailable.');preview=attendanceAlerts(value.report,settings,now());state.lastScan=new Date().toISOString();state.error=null;await save();return preview;}finally{busy=false;}}
 const service={
  async status(){return {settings,gmail:await gmail.status(),busy,lastScan:state.lastScan,lastSent:state.lastSent,error:state.error,deliveryUnknown:state.inFlight||null,preview,history:state.history.slice(-20)};},
  async configure(input){const recipients=String(input.recipients||'').split(/[;,\s]+/).filter(Boolean);if(recipients.length>20||recipients.some(s=>!/^[-.\w+]+@[-.\w]+\.[a-z]{2,}$/i.test(s)))throw Error('Enter valid recipient email addresses.');for(const key of ['lateCount','absenceDays'])if(!Number.isInteger(input[key])||input[key]<1||input[key]>20)throw Error('Thresholds must be between 1 and 20.');const excusedDays=String(input.excusedDays||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{const [employee,start,end]=line.split(/[,\s]+/);const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d))&&new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d;if(!/^\d+$/.test(employee||'')||!valid(start)||!valid(end)||start>end)throw Error('Use one approved-leave line per employee: ID, YYYY-MM-DD, YYYY-MM-DD.');return {employee,start,end};});if(excusedDays.length>500)throw Error('Too many leave exceptions.');settings={...settings,excusedDays,enabled:Boolean(input.enabled),recipients,lateCount:input.lateCount,absenceDays:input.absenceDays,excludedEmployees:String(input.excludedEmployees||'').split(/[,\s]+/).filter(x=>/^\d+$/.test(x))};await writeFile(settingsFile+'.tmp',JSON.stringify(settings,null,2));await rename(settingsFile+'.tmp',settingsFile);return settings;},
  async retryUnconfirmed(){state.inFlight=null;state.error=null;await save();},
  preview:()=>scan(false),
  async sendNow(){
   if(busy||sending)throw Object.assign(Error('An attendance scan or delivery is already running.'),{status:409});
   if(state.inFlight)throw Object.assign(Error('Check the unconfirmed delivery in Gmail Sent before retrying.'),{status:409});
   if(!settings.recipients.length)throw Error('Save at least one recipient first.');
   sending=true;
   try{if(!(await gmail.status()).connected)throw Error('Connect it@ Gmail first.');const events=await scan(true),fresh=events.filter(e=>!state.delivered[e.id]);if(!fresh.length)return {sent:false,count:0,message:'No new attendance alerts to send. Previously sent issues are not repeated.'};
    state.inFlight={at:new Date().toISOString(),ids:fresh.map(e=>e.id),recipients:[...settings.recipients]};await save();
    const messageId=await gmail.send(state.inFlight.recipients,alertMessage(fresh,localParts(now(),settings.timeZone).date,dashboardUrl));const sentAt=new Date().toISOString();
    for(const e of fresh)state.delivered[e.id]={sentAt,messageId};
    state.history.push({sentAt,messageId,count:fresh.length,recipients:state.inFlight.recipients,items:fresh.map(e=>({employee:e.employee,name:e.name,kind:e.kind,description:e.description}))});state.lastSent=sentAt;state.inFlight=null;await save();return {sent:true,count:fresh.length,message:'Email alert sent with '+fresh.length+' attendance items.'};
   }catch(e){state.error=e.message;await save().catch(()=>{});throw e;}finally{sending=false;}
  },
  async tick(){if(busy||sending||!settings.enabled||!settings.recipients.length||!(await gmail.status()).connected||state.inFlight)return;const {hour}=localParts(now(),settings.timeZone);if(hour<6||hour>=21)return;try{await service.sendNow();}catch{} }

 };return service;
}

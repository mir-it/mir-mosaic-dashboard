import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
export function localParts(now,timeZone='America/Los_Angeles'){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,hour:Number(parts.hour)};
}
export function shiftDay(date,n){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
export function dueDate(now,state,timeZone){const p=localParts(now,timeZone),due=p.hour>=23?p.date:shiftDay(p.date,-1);return due>=state.installedDate&&due>(state.completedDate||'')?due:null;}
export function createPayclockScheduler(service,root,timeZone='America/Los_Angeles'){
  const folder=path.join(root,'data','payclock'),file=path.join(folder,'nightly.json');let state=null,running=false,retryAt=0;
  async function save(){await mkdir(folder,{recursive:true});await writeFile(file+'.tmp',JSON.stringify(state,null,2));await rename(file+'.tmp',file);}
  async function initialize(now){if(state)return;try{state=JSON.parse(await readFile(file,'utf8'));}catch{state={installedDate:localParts(now,timeZone).date};await save();}}
  return {
    async status(){await initialize(new Date());return {...state,running,timeZone,hour:23};},
    async tick(now=new Date()){
      if(running||now.getTime()<retryAt)return;running=true;
      try{
        await initialize(now);const due=dueDate(now,state,timeZone);if(!due)return;
        state.lastAttempt=now.toISOString();
        // Every read includes all employees. A later-day read finalizes yesterday.
        const job=await service.start({start:shiftDay(due,-1),end:due,saveView:false});
        let result;do{await new Promise(r=>setTimeout(r,500));result=service.get(job.id);}while(result?.state==='running');
        if(result?.state!=='ready')throw Error(result?.error||'The scheduled report was unavailable.');
        state.completedDate=due;state.lastSuccess=new Date().toISOString();state.error=null;
        state.statistics={date:due,punches:result.report.daily.filter(r=>r.values[2]===due).reduce((n,r)=>n+r.punches.length,0),employeeDays:result.report.daily.filter(r=>r.values[2]===due).length};
        await save();
      }catch(e){if(state){state.error=e.message;await save().catch(()=>{});}retryAt=Date.now()+300000;}
      finally{running=false;}
    }
  };
}

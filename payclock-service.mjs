import {spawn} from 'node:child_process';
import {readdir,lstat,realpath,mkdir,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function validateRange(start,end,maxDays=92){
  const valid=s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  if(!valid(start)||!valid(end))throw Error('Choose valid start and end dates.');
  const days=(Date.parse(end)-Date.parse(start))/86400000;
  if(days<0||days>maxDays)throw Error(`Choose an inclusive range of up to ${maxDays+1} days, with the start before the end.`);
}

export function createPayclockService(config,root){
  const jobs=new Map();let busy=false;
  let initialization=null;
  const output=path.join(root,'data','payclock');
  const cleanup=()=>{for(const [id,j] of jobs)if(j.state!=='running'&&Date.now()-j.created>1800000)jobs.delete(id);};
  async function calculate(request,job,id){
    const folder=path.join(output,'jobs',id),input=path.join(folder,'request.json'),result=path.join(folder,'result.json');
    try{
      await mkdir(folder,{recursive:true});await writeFile(input,JSON.stringify(request),{flag:'wx'});
      // File handoff avoids Windows named-pipe restrictions; no shell or user-supplied executable.
      if(request.action==='excel')request.excelFile=path.join(folder,'table.xlsx');
      await writeFile(input,JSON.stringify(request));
      const code=await new Promise((resolve,reject)=>{
        const child=spawn(config.payclock.python,['-B',path.join(root,'payclock-report.py'),input,result],{cwd:root,windowsHide:true,stdio:'ignore',timeout:180000});
        child.on('error',reject);child.on('close',(code)=>child.killed?reject(Error('The report timed out. Try a shorter range or a saved CSV.')):resolve(code));
      });
      if((await lstat(result)).size>30_000_000)throw Error('The report is too large. Choose a shorter range.');
      const report=JSON.parse(await readFile(result,'utf8'));if(code!==0||report.error)throw Error(report.error||'Could not calculate the report.');
      if(request.action==='excel'){
        if((await lstat(request.excelFile)).size>30_000_000)throw Error('The report is too large. Choose a shorter range.');
        job.excel=await readFile(request.excelFile);
      }else job.report=report;
      job.state='ready';
    }catch(e){job.state='failed';job.error=/^(Could not|The report)/.test(e.message)?e.message:'Could not run the Payclock report. Check Python and the clock connection.';}
    finally{busy=false;await Promise.allSettled([unlink(input),unlink(result),...(request.excelFile?[unlink(request.excelFile)]:[])]);await rmdir(folder).catch(()=>{});}
  }
  async function files(){
    const result=[];
    for(const [kind,folder] of [['export',config.payclockExports],['dashboard',output]]){
      let names;try{names=await readdir(folder);}catch{continue;}
      for(const name of names){
        const match=/^punches_(\d{8})_to_(\d{8})(?:_[a-f0-9]{32})?\.csv$/.exec(name);if(!match)continue;
        const file=path.join(folder,name),meta=await lstat(file);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>20_000_000)continue;
        const relative=path.relative(await realpath(folder),await realpath(file));if(relative.startsWith('..')||path.isAbsolute(relative))continue;
        const date=s=>s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6);
        result.push({id:kind+':'+name,name,start:date(match[1]),end:date(match[2]),modified:meta.mtime.toISOString(),file});
      }
    }
    return result.sort((a,b)=>b.modified.localeCompare(a.modified));
  }
  const service={
    invalidate(){initialization=null;},
    remember(report){cleanup();const id=randomUUID();jobs.set(id,{state:'ready',report,created:Date.now()});return id;},
    async sources(){return (await files()).map(({file,...r})=>r);},
    async latest(){
      if(!initialization)initialization=(async()=>{
        const available=await files();
        if(!available.length)return;
        let previous;try{previous=JSON.parse(await readFile(path.join(output,'last-report.json'),'utf8'));}catch{}
        const newest=available[0];
        const job=await service.start({source:'cache',start:previous?.start||newest.start,end:previous?.end||newest.end,selectedDates:previous?.selectedDates});
        while(jobs.get(job.id)?.state==='running')await new Promise(r=>setTimeout(r,100));
        if(jobs.get(job.id)?.state==='failed')throw Error(jobs.get(job.id).error);
      })().catch(e=>{initialization=null;throw e;});
      await initialization;
      try{return JSON.parse(await readFile(path.join(output,'last-report.json'),'utf8'));}catch{return null;}
    },
    async start(input){
      validateRange(input.start,input.end,input.source==='cache'?36524:92);cleanup();
      if(busy)throw Object.assign(Error('A clock report is already loading. Please wait.'),{status:409});
      input={...input,source:input.source||'auto'};
      if(!['auto','clock','csv','cache'].includes(input.source))throw Error('Invalid timestamp request.');
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:config.timezone||'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      if(input.source!=='cache'&&input.end>today)throw Error('Choose dates up to today.');
      if(input.selectedDates!==undefined&&(!Array.isArray(input.selectedDates)||input.selectedDates.length===0||input.selectedDates.length>36525||input.selectedDates.some(d=>typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||d<input.start||d>input.end||d>today)))throw Error('Invalid calendar selection.');
      const available=await files();
      let csv;
      if(input.source==='csv'){
        const selected=available.find(f=>f.id===input.file);
        if(!selected)throw Error('Choose an available punch CSV.');
        if(input.start<selected.start||input.end>selected.end)throw Error('The selected CSV does not cover the whole requested date range. Choose another file or read the clock.');
        csv=selected.file;
      }
      if(busy)throw Object.assign(Error('A clock report is already loading. Please wait.'),{status:409});
      const id=randomUUID(),job={state:'running',created:Date.now()};jobs.set(id,job);busy=true;
      while(jobs.size>8){const oldest=[...jobs].find(([,j])=>j.state!=='running');if(!oldest)break;jobs.delete(oldest[0]);}
      const request={excludedEmployees:config.payclock.excludedEmployees||[],project:config.payclock.project,host:config.payclock.host,output,csv,selectedDates:input.selectedDates,start:input.start,end:input.end,source:input.source,today,saveView:input.saveView!==false,files:available.slice().reverse()};
      void calculate(request,job,id);
      return {id,state:job.state};
    },
    async excel(input){
      cleanup();if(busy)throw Object.assign(Error('A report is already loading. Please wait.'),{status:409});
      const report=input.id?jobs.get(input.id)?.report:await service.latest();
      if(!report)throw Error('Load a report before downloading Excel.');
      const f=input.filters;
      if(!f||!['daily','totals','review'].includes(f.sheet)||!['all','Office','Warehouse'].includes(f.team)||typeof f.employee!=='string'||(f.employee!=='all'&&!(report.employees||report.totals).some(r=>r.employeeId===f.employee))||typeof f.day!=='string'||(f.day&&(f.day<report.start||f.day>report.end||!/^\d{4}-\d{2}-\d{2}$/.test(f.day)))||![1,-1].includes(f.sortDirection))throw Error('Invalid Excel filters.');
      const cols=f.sheet==='chart'?2:f.sheet==='totals'?9:17;
      if(!Number.isInteger(f.sortColumn)||f.sortColumn<0||f.sortColumn>=cols)throw Error('Invalid sort column.');
      const matching=r=>(f.team==='all'||r.group===f.team)&&(f.employee==='all'||r.employeeId===f.employee);
      const rows=f.sheet==='chart'?report.payrollChart.map(values=>({values})):f.sheet==='totals'?report.totals.filter(matching):report.daily.filter(r=>matching(r)&&(!f.day||r.values[2]===f.day)&&(f.sheet!=='review'||!r.values[15].startsWith('ok')||r.audit?.length&&!r.audit[0].restoreOriginal));
      rows.sort((a,b)=>{const x=a.values[f.sortColumn],y=b.values[f.sortColumn];if(x==null)return y==null?0:1;if(y==null)return -1;return (typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),undefined,{numeric:true}))*f.sortDirection;});
      if(busy)throw Object.assign(Error('A report is already loading. Please wait.'),{status:409});
      const id=randomUUID(),job={state:'running',created:Date.now(),kind:'excel',filename:`payclock-${f.sheet}-${report.start}-to-${report.end}.xlsx`};jobs.set(id,job);busy=true;
      void calculate({action:'excel',project:config.payclock.project,report,filters:f,orderedValues:rows.map(r=>r.values),correctedRows:rows.map(r=>Boolean(r.audit?.length&&!r.audit[0].restoreOriginal))},job,id);
      return {id,state:'running'};
    },
    download(id){cleanup();const job=jobs.get(id);return job?.state==='ready'&&job.excel?{buffer:job.excel,filename:job.filename}:null;},
    get(id){cleanup();const job=jobs.get(id);if(!job)return null;return {state:job.state,...(job.state==='ready'?job.kind==='excel'?{download:'/api/payclock/download/'+id}:{report:job.report}:job.state==='failed'?{error:job.error}:{})};}
  };
  return service;
}

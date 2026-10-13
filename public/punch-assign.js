export const punchRoles=['in','lunchOut','lunchIn','out'];
const defaultTimes=['08:00:00','12:00:00','13:00:00','17:00:00'];
const seconds=time=>{const p=String(time).split(':').map(Number);return p.length>=2&&p.every(Number.isFinite)?p[0]*3600+p[1]*60+(p[2]||0):NaN;};
function combinations(values,count){if(!count)return [[]];const result=[];for(let i=0;i<=values.length-count;i++)for(const tail of combinations(values.slice(i+1),count-1))result.push([values[i],...tail]);return result;}
export function assignPunchRoles(entries,expectedTimes=defaultTimes){
 const result=entries.map(p=>({...p,role:p.enabled?p.role:'extra'})),targets=expectedTimes.map(seconds);
 const active=result.map((p,index)=>({p,index,time:seconds(p.time)})).filter(x=>x.p.enabled&&Number.isFinite(x.time)).sort((a,b)=>a.time-b.time);
 const reserved=new Set(result.filter(p=>p.enabled&&!Number.isFinite(seconds(p.time))&&punchRoles.includes(p.role)).map(p=>p.role));
 const available=[0,1,2,3].filter(i=>!reserved.has(punchRoles[i]));const n=Math.min(active.length,available.length);let best=null;
 for(const chosen of combinations(active.map((_,i)=>i),n))for(const roles of combinations(available,n)){const cost=chosen.reduce((sum,index,i)=>sum+Math.abs(active[index].time-targets[roles[i]]),0);if(!best||cost<best.cost)best={cost,chosen,roles};}
 for(const x of active)result[x.index].role='extra';
 if(best)best.chosen.forEach((index,i)=>result[active[index].index].role=punchRoles[best.roles[i]]);
 return result;
}
export function suggestMissingPunch(entries,expectedTimes=defaultTimes){
 const assigned=assignPunchRoles(entries,expectedTimes),active=assigned.filter(p=>p.enabled),missing=punchRoles.filter(role=>!active.some(p=>p.role===role));
 if(!missing.length)return null;
 return {time:'',role:missing[0],enabled:true};
}
export function insertMissingPunch(entries,expectedTimes=defaultTimes){const assigned=assignPunchRoles(entries,expectedTimes),missing=suggestMissingPunch(assigned,expectedTimes);if(!missing)return null;const roleIndex=punchRoles.indexOf(missing.role);let index=assigned.findIndex(p=>p.enabled&&punchRoles.indexOf(p.role)>roleIndex);if(index<0)index=assigned.length;assigned.splice(index,0,missing);return {entries:assigned,index,punch:missing};}

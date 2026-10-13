export const punchRoles=['in','lunchOut','lunchIn','out'];
const defaultTimes=['08:00:00','12:00:00','13:00:00','17:00:00'];
const seconds=time=>{const p=String(time).split(':').map(Number);return p.length>=2&&p.every(Number.isFinite)?p[0]*3600+p[1]*60+(p[2]||0):NaN;};
const clock=value=>{const s=Math.max(0,Math.min(86399,Math.round(value)));return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':');};
function combinations(values,count){if(!count)return [[]];const result=[];for(let i=0;i<=values.length-count;i++)for(const tail of combinations(values.slice(i+1),count-1))result.push([values[i],...tail]);return result;}
export function assignPunchRoles(entries,expectedTimes=defaultTimes){
 const result=entries.map(p=>({...p})),targets=expectedTimes.map(seconds);
 const active=result.map((p,index)=>({p,index,time:seconds(p.time)})).filter(x=>x.p.enabled&&Number.isFinite(x.time)).sort((a,b)=>a.time-b.time);
 const n=Math.min(active.length,4);let best=null;
 for(const chosen of combinations(active.map((_,i)=>i),n))for(const roles of combinations([0,1,2,3],n)){const cost=chosen.reduce((sum,index,i)=>sum+Math.abs(active[index].time-targets[roles[i]]),0);if(!best||cost<best.cost)best={cost,chosen,roles};}
 for(const x of active)result[x.index].role='extra';
 if(best)best.chosen.forEach((index,i)=>result[active[index].index].role=punchRoles[best.roles[i]]);
 return result;
}
export function suggestMissingPunch(entries,expectedTimes=defaultTimes){
 const assigned=assignPunchRoles(entries,expectedTimes),active=assigned.filter(p=>p.enabled),missing=punchRoles.filter(role=>!active.some(p=>p.role===role));
 if(!missing.length)return null;
 const role=missing[0],index=punchRoles.indexOf(role),before=active.filter(p=>punchRoles.indexOf(p.role)>=0&&punchRoles.indexOf(p.role)<index).map(p=>seconds(p.time)),after=active.filter(p=>punchRoles.indexOf(p.role)>index).map(p=>seconds(p.time));
 const low=before.length?Math.max(...before)+1:0,high=after.length?Math.min(...after)-1:86399;if(low>high)return null;
 let time=Math.max(low,Math.min(high,seconds(expectedTimes[index])));const used=new Set(active.map(p=>seconds(p.time)));while(used.has(time)&&time<high)time++;if(used.has(time))return null;
 return {time:clock(time),role,enabled:true};
}

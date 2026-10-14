import {createHash} from 'node:crypto';
import {shiftDay,localParts} from './payclock-scheduler.mjs';
const minute=t=>{if(!t)return null;const [h,m,s=0]=t.split(':').map(Number);return h*60+m+s/60;};
const weekday=d=>{const n=new Date(d+'T12:00:00Z').getUTCDay();return n!==0&&n!==6;};
export function attendanceAlerts(report,settings,now=new Date()){
 const today=localParts(now,settings.timeZone||'America/Los_Angeles').date;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:settings.timeZone||'America/Los_Angeles',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));const current=Number(parts.hour)*60+Number(parts.minute);
 const start=shiftDay(today,-30),complete=new Set(report.cache?.completeDates||[]),excluded=new Set(settings.excludedEmployees||[]),events=[];
 const leave=settings.excusedDays||[];const excused=(employee,day)=>leave.some(e=>e.employee===employee&&e.start<=day&&e.end>=day);
 const employees=new Map();for(const r of report.daily){if(!employees.has(r.employeeId))employees.set(r.employeeId,[]);employees.get(r.employeeId).push(r);}
 const emit=(employee,name,kind,key,description,evidence)=>events.push({id:createHash('sha256').update(kind+'|'+employee+'|'+key).digest('hex'),employee,name,kind,description,evidence});
 for(const [employee,rows] of employees){if(excluded.has(employee))continue;const name=rows[0].values[1]||employee,days=new Map(rows.map(r=>[r.values[2],r]));
   const late=rows.filter(r=>r.values[2]>=start&&r.values[2]<=today&&weekday(r.values[2])&&!excused(employee,r.values[2])&&r.punches.length&&minute(r.punches[0])>510);
   if(late.length>=(settings.lateCount||3)){const reached=today.slice(0,7);emit(employee,name,'late',reached,'First recorded punch after 8:30 AM on '+late.length+' weekdays in the last 30 days.',late.map(r=>r.values[2]+' '+r.punches[0]));}
   const recent=rows.filter(r=>r.values[2]>=start&&r.values[2]<today&&r.punches.length);if(recent.length){let consecutive=[];for(let d=shiftDay(today,-1);d>=start;d=shiftDay(d,-1)){if(!weekday(d))continue;if(excused(employee,d)||!complete.has(d)||days.get(d)?.punches.length)break;consecutive.unshift(d);}if(consecutive.length>=(settings.absenceDays||3)){const first=rows.map(r=>r.values[2]).sort()[0];if(first<consecutive[0])emit(employee,name,'missing',consecutive[0],'No punches recorded on '+consecutive.length+' consecutive completed weekdays. Confirm schedule, approved leave and clock usage before treating this as an absence.',consecutive);}}
   for(const row of rows){const day=row.values[2];if(day!==today||!row.punches.length||excused(employee,day))continue;const first=minute(row.punches[0]),deadline=first+240;if(current<deadline)continue;const assigned=row.audit?.[0]&&!row.audit[0].restoreOriginal?row.audit[0].punches:row.suggestion?.punches;const lunchOut=minute(assigned?.find(p=>p.enabled&&p.role==='lunchOut')?.time??(!assigned?row.values[6]:null));if(lunchOut===null||lunchOut>=deadline)emit(employee,name,'lunch',day,lunchOut===null?'Possible lunch delay: no lunch-out punch recorded before the fifth work hour starts. Verify missing punches.':'Lunch-out punch recorded at or after the start of the fifth work hour.',[day+' first punch '+row.punches[0],lunchOut===null?'Lunch out not recorded':'Lunch out '+row.values[6],'Deadline is four elapsed hours after arrival; verify assignments.']);}
 }
 return events;
}
export function alertMessage(events,date){return {subject:'Mir Mosaic attendance review · '+date,text:'Attendance items requiring manager review. These are clock-record observations, not confirmed absences or misconduct.\n\n'+events.map(e=>e.name+' (ID '+e.employee+')\n'+e.description+'\n'+e.evidence.join('\n')).join('\n\n')+'\n\nReview schedules, approved leave, missing punches and saved local corrections in the company dashboard. No clock records were changed.'};}

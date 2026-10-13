import {assignPunchRoles,suggestMissingPunch} from './punch-assign.js';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decimal=n=>n==null?'':Number(n).toFixed(2);
let report=null,reportId=null,sheet='daily',page=1,sortColumn=2,sortDirection=1,selectedDay='',shown=[],columns=[];
const pageSize=50;
let today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('end').value=today;$('start').value=today.slice(0,8)+'01';
function refreshToday(){today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());$('start').max=today;}
async function request(url,options){refreshToday();const r=await fetch(url,options);const p=await r.json();if(!r.ok)throw Error(p.error||'Request failed.');return p;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let rangeBusy=false;
async function fetchReport(start,end,saveView=true,localOnly=false,selectedDates=null){
  const job=await request('/api/payclock/reports',{method:'POST',headers:{'Content-Type':'application/json','X-Mir-Request':'dashboard'},body:JSON.stringify({start,end,saveView,...(selectedDates?{selectedDates}:{}),...(localOnly?{source:'cache'}:{})})});
  let result;do{await pause(500);result=await request('/api/payclock/reports/'+job.id);}while(result.state==='running');
  if(result.state!=='ready')throw Error(result.error||'Could not read timestamps.');
  return {report:result.report,id:job.id};
}
async function loadRange(localOnly=false,showStatistics=false){
  if(rangeBusy||dayBusy)return;rangeBusy=true;$('time-error').hidden=true;$('load-report').disabled=true;
  $('load-status').textContent=localOnly?'Calculating statistics from local timestamps…':'Loading saved days and fetching only missing or partial days…';
  const team=$('team').value,employee=$('employee').value;
  try{const start=$('start').value,end=$('end').value;let value;if(!localOnly&&end>today){await fetchReport(start,today,false);value=await fetchReport(start,end,true,true);}else value=await fetchReport(start,end,true,localOnly);displayReport(value.report,value.id);$('team').value=team;populateEmployees();if([...$('employee').options].some(o=>o.value===employee))$('employee').value=employee;render();if(showStatistics)$('report').scrollIntoView({behavior:'smooth',block:'start'});}
  catch(e){$('time-error').textContent=e.message;$('time-error').hidden=false;$('load-status').textContent='Could not complete this range. Already saved timestamps are retained.';}
  finally{rangeBusy=false;$('load-report').disabled=false;updateDayButtons();renderCalendar();}
}
$('range-form').addEventListener('submit',e=>{e.preventDefault();calendarDates=null;loadRange();});
async function loadCalendar(fetchMissing=true){
  if(rangeBusy||dayBusy)return;const dates=[...(calendarDates||[])].filter(d=>d<=today).sort();if(!dates.length)return;
  rangeBusy=true;updateDayButtons();renderCalendar();$('time-error').hidden=true;$('load-status').textContent=fetchMissing?'Fetching missing selected days for all employees…':'Showing saved statistics for selected days…';
  try{const spans=[];for(const d of dates){const last=spans.at(-1);if(last&&shiftDate(last[1],1)===d)last[1]=d;else spans.push([d,d]);}if(fetchMissing)for(const [start,end] of spans){for(let first=start;first<=end;first=shiftDate(first,93)){const last=shiftDate(first,92);await fetchReport(first,last>end?end:last,false);}}const value=await fetchReport(dates[0],dates.at(-1),true,true,dates);displayReport(value.report,value.id);}
  catch(e){$('time-error').textContent=e.message;$('time-error').hidden=false;}
  finally{rangeBusy=false;updateDayButtons();renderCalendar();}
}
$('calendar-fetch').addEventListener('click',()=>loadCalendar(true));
$('calendar-show').addEventListener('click',()=>loadCalendar(false));
function displayReport(value,id){
  for(const row of value.daily||[])if(typeof row.values[16]==='string')row.values[16]=row.values[16].replace(/Local correction by /g,'Correction by ');
  report=value;reportId=id;if(value.selectedDates)calendarDates=new Set(value.selectedDates);selectedDay='';page=1;sheet='daily';sortColumn=2;sortDirection=1;$('team').value='all';
  populateEmployees();$('report').hidden=false;
  $('load-status').textContent=report.punchCount?`Loaded ${report.punchCount} cached timestamps. Choose an employee for their profile.`:'No timestamps are cached in this range.';
  const missingDays=report.cache?.missingDates?.filter(d=>d<=today&&(!report.selectedDates||report.selectedDates.includes(d)))||[];
  if(missingDays.length)$('load-status').textContent+=` ${missingDays.length} days are missing or partial; Fetch fills gaps (up to 93 days at a time).`;
  if(report.cache?.partialDates?.some(d=>d>=report.start&&d<=report.end))$('load-status').textContent+=' Current or unfinished days remain partial; Fetch or the nightly pull refreshes them.';
  $('range-title').textContent=report.start+' — '+report.end;
  $('source-note').textContent='Local database · '+(report.cache?.punches||0)+' timestamps · '+(report.cache?.completeDates?.length||0)+' complete days · Updated '+new Date(report.cache?.updatedAt||report.generatedAt).toLocaleString();
  calendarMonth=report.end.slice(0,7);render();renderCalendar();
}
function populateEmployees(){
  const previous=$('employee').value,team=$('team').value;
  $('employee').innerHTML='<option value="all">All employees</option>'+(report.employees||report.totals).filter(r=>team==='all'||r.group===team).map(r=>`<option value="${esc(r.employeeId)}">${esc(r.name||r.values?.[1]||'Unnamed')} · ${esc(r.employeeId)}</option>`).join('');
  $('employee').value=[...$('employee').options].some(o=>o.value===previous)?previous:'all';
}
function matching(r){return ($('team').value==='all'||r.group===$('team').value)&&($('employee').value==='all'||r.employeeId===$('employee').value);}
function render(){
  if(!report)return;
  const daily=report.daily.filter(matching),totals=report.totals.filter(matching);
  const sum=i=>totals.reduce((n,r)=>n+(r.values[i]||0),0);
  $('time-metrics').innerHTML=[['Worked hours',decimal(sum(2)),'Includes provisional review hours'],['Regular / overtime',decimal(sum(3))+' / '+decimal(sum(4)),'Payroll decimal hours'],['Employees',totals.length,'With timestamps in this range'],['Days needing review',sum(7),'Employee-days; inspect before approval']].map(([k,v,n])=>`<div class="metric"><div class="metric-label">${k}</div><div class="metric-value">${v}</div><small>${n}</small></div>`).join('');
  const byDate=new Map();for(const r of daily){const d=r.values[2],b=byDate.get(d)||{regular:0,overtime:0,review:0};b.regular+=r.values[10]||0;b.overtime+=r.values[11]||0;b.review+=r.values[15].startsWith('ok')?0:1;byDate.set(d,b);}
  const dates=[];if((Date.parse(report.end)-Date.parse(report.start))/86400000>92){dates.push(...[...byDate.keys()].sort());}else for(let d=new Date(report.start+'T12:00:00Z');d.toISOString().slice(0,10)<=report.end;d.setUTCDate(d.getUTCDate()+1))dates.push(d.toISOString().slice(0,10));
  if(report.selectedDates){const selected=new Set(report.selectedDates);for(let i=dates.length-1;i>=0;i--)if(!selected.has(dates[i]))dates.splice(i,1);}
  const max=Math.max(1,...[...byDate.values()].map(b=>b.regular+b.overtime));
  $('time-chart').innerHTML=dates.map(d=>{const b=byDate.get(d),reg=(b?.regular||0)/max*100,ot=(b?.overtime||0)/max*100,total=(b?.regular||0)+(b?.overtime||0);return `<button class="day-bar" data-date="${d}" aria-pressed="${d===selectedDay}" aria-label="${d}: ${b?decimal(total)+' payroll hours, '+b.review+' review days':'no records'}" title="${d}: ${b?decimal(total)+' payroll hours':'no records'}"><span class="day-total">${b?decimal(total):'—'}</span><svg viewBox="0 0 24 110" aria-hidden="true"><rect x="2" y="${105-reg}" width="20" height="${reg}" fill="#567c65"/><rect x="2" y="${105-reg-ot}" width="20" height="${ot}" fill="#bb814a"/></svg><span>${d.slice(5)}</span>${b?.review?'<span aria-hidden="true">⚑</span>':'<span aria-hidden="true">·</span>'}</button>`;}).join('');
  $('clear-day').hidden=!selectedDay;$('clear-day').textContent='Clear day: '+selectedDay;
  $('review-patterns').innerHTML=(report.reviewPatterns||[]).map((p,index)=>{const count=report.daily.filter(r=>matching(r)&&r.suggestion?.flags?.includes(p.pattern)).length;return count?`<button type="button" class="review-pattern-button" data-pattern="${index}"><b>${count}</b> employee-days · ${esc(p.pattern)} <span aria-hidden="true">→</span></button>`:'';}).join('')||'<p>No punch-count patterns requiring review in this selection.</p>';
  renderEmployeeProfile();
  renderTable();
}
function isCorrected(r){return Boolean(r.audit?.length&&!r.audit[0].restoreOriginal);}
function inReviewList(r){return !r.values[15].startsWith('ok')||isCorrected(r);}
function tableRows(){
  if(sheet==='totals')return report.totals.filter(matching);
  return report.daily.filter(r=>matching(r)&&(!selectedDay||r.values[2]===selectedDay)&&(sheet!=='review'||inReviewList(r)));
}
function isDecimal(i){return sheet==='totals'?i>=2&&i<=5:i>=9&&i<=14;}
function renderTable(){
  $('review-pattern-panel').hidden=sheet!=='review';
  columns=sheet==='totals'?report.totalHeaders:report.dailyHeaders;
  shown=tableRows().slice().sort((a,b)=>{const x=a.values[sortColumn],y=b.values[sortColumn];if(x==null)return y==null?0:1;if(y==null)return -1;return (typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),undefined,{numeric:true}))*sortDirection;});
  const pages=Math.max(1,Math.ceil(shown.length/pageSize));page=Math.min(page,pages);
  document.querySelectorAll('[data-sheet]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sheet===sheet)));
  $('table-description').textContent=sheet==='totals'?`${shown.length} employees · Whole selected range; click an employee to see daily detail.`:`${shown.length} employee-days${selectedDay?' on '+selectedDay:''} · All Excel columns retained. Click a row for every punch and a timeline. Scroll horizontally for calculations and notes.`;
  $('time-head').innerHTML='<tr>'+columns.map((h,i)=>`<th aria-sort="${i===sortColumn?(sortDirection===1?'ascending':'descending'):'none'}"><button data-sort="${i}">${esc(h)}${i===sortColumn?(sortDirection===1?' ↑':' ↓'):''}</button></th>`).join('')+'</tr>';
  $('time-body').innerHTML=shown.slice((page-1)*pageSize,page*pageSize).map((r,j)=>{const index=(page-1)*pageSize+j;return `<tr ${sheet==='daily'||sheet==='review'?`data-day="${index}" class="${isCorrected(r)?'corrected-row':r.values[15].startsWith('ok')?'':'review-row'}"`:sheet==='totals'?`data-employee="${esc(r.employeeId)}"`:''}>${r.values.map((v,i)=>`<td class="${typeof v==='number'?'numeric':''}">${i===1?`<button class="order-link" ${sheet==='totals'?`data-employee="${esc(r.employeeId)}"`:`data-day="${index}"`}>${esc(v||'Unnamed employee')}</button>`:(i===15&&isCorrected(r)?'<span class="corrected-label">Corrected</span> ':'')+esc(isDecimal(i)?decimal(v):v)}</td>`).join('')}</tr>`;}).join('')||`<tr><td colspan="${columns.length}" class="empty">No records match these filters.</td></tr>`;
  $('time-page').textContent=`Page ${page} of ${pages} · ${shown.length} rows`;$('time-prev').disabled=page<=1;$('time-next').disabled=page>=pages;
}
$('team').addEventListener('change',()=>{populateEmployees();page=1;render();});
$('employee').addEventListener('change',()=>{page=1;render();});
$('clear-day').addEventListener('click',()=>{selectedDay='';page=1;render();});
$('time-chart').addEventListener('click',e=>{const b=e.target.closest('[data-date]');if(!b)return;selectedDay=b.dataset.date;sheet='daily';page=1;sortColumn=1;render();});
$('report-sheets').addEventListener('click',e=>{const b=e.target.closest('[data-sheet]');if(!b)return;sheet=b.dataset.sheet;sortColumn=sheet==='daily'||sheet==='review'?2:0;sortDirection=1;page=1;renderTable();});
$('time-head').addEventListener('click',e=>{const b=e.target.closest('[data-sort]');if(!b)return;const i=Number(b.dataset.sort);sortDirection=i===sortColumn?-sortDirection:1;sortColumn=i;page=1;renderTable();});
$('time-prev').addEventListener('click',()=>{page--;renderTable();});$('time-next').addEventListener('click',()=>{page++;renderTable();});
$('time-body').addEventListener('click',e=>{
  const employee=e.target.closest('[data-employee]');if(employee){$('employee').value=employee.dataset.employee;sheet='daily';selectedDay='';sortColumn=2;sortDirection=1;page=1;render();return;}
  const day=e.target.closest('[data-day]');if(day)openWorkerDay(shown[Number(day.dataset.day)]);
});
let activeWorker=null,activeWorkerDay='',dayBusy=false,dayGeneration=0;
function showDay(row){
  activeWorker=row.employeeId;activeWorkerDay=row.values[2];$('worker-day-status').textContent=activeWorkerDay+((report?.cache?.completeDates||[]).includes(activeWorkerDay)?' · Cached':' · Partial / not fetched');updateDayButtons();
  $('day-title').textContent=(row.values[1]||row.employeeId)+' · '+row.values[2];$('day-note').textContent=row.values[15]+' · '+(row.values[16]||'Four punches paired around lunch.');
  const minutes=t=>{const [h,m,s]=t.split(':').map(Number);return h*60+m+s/60;};
  const punches=row.punches.map(minutes),segments=[];
  for(let i=0;i+1<punches.length;i+=2)segments.push(`<rect x="${punches[i]/1440*960+20}" y="25" width="${(punches[i+1]-punches[i])/1440*960}" height="22" rx="3" fill="#567c65"/>`);
  $('punch-timeline').innerHTML=`<svg viewBox="0 0 1000 85" role="img" aria-label="Consecutive work intervals and all punches across a 24-hour day"><rect x="20" y="25" width="960" height="22" rx="3" fill="#e5e8dd"/>${segments.join('')}${punches.map((m,i)=>`<circle cx="${m/1440*960+20}" cy="36" r="4" fill="${i===punches.length-1&&punches.length%2?'#a65c30':'#193d36'}"><title>Punch ${i+1}: ${esc(row.punches[i])}</title></circle>`).join('')}${[0,6,12,18,24].map(h=>`<text x="${h/24*950+20}" y="70" text-anchor="${h===24?'end':'start'}" fill="#69746d" font-size="15">${String(h).padStart(2,'0')}:00</text>`).join('')}</svg>`;
  $('punch-list').innerHTML=row.punches.map((t,i)=>`<li>Punch ${i+1}: <b>${esc(t)}</b></li>`).join('');
  $('day-values').innerHTML=report.dailyHeaders.map((h,i)=>`<dt>${esc(h)}</dt><dd>${esc(i>=9&&i<=14?decimal(row.values[i]):row.values[i])||'—'}</dd>`).join('');
  renderPunchEditor(row);
  if(!$('day-dialog').open)$('day-dialog').showModal();
}
function openWorkerDay(row){showDay(row);if(!(report?.cache?.completeDates||[]).includes(row.values[2])||row.values[2]===today)navigateWorkerDay(0);}
$('day-close').addEventListener('click',()=>$('day-dialog').close());
$('download-time').addEventListener('click',async()=>{
  $('download-time').disabled=true;$('download-time').textContent='Generating Excel…';
  try{
    const job=await request('/api/payclock/excel',{method:'POST',headers:{'Content-Type':'application/json','X-Mir-Request':'dashboard'},body:JSON.stringify({id:reportId,filters:{sheet,team:$('team').value,employee:$('employee').value,day:selectedDay,sortColumn,sortDirection}})});
    let result;do{await pause(500);result=await request('/api/payclock/reports/'+job.id);}while(result.state==='running');
    if(result.state!=='ready')throw Error(result.error);
    const a=document.createElement('a');a.href=result.download;a.download='';a.click();
  }catch(e){$('time-error').textContent=e.message;$('time-error').hidden=false;}
  finally{$('download-time').disabled=false;$('download-time').textContent='Download this table as Excel';}
});
function renderEmployeeProfile(){
  const id=$('employee').value;$('employee-profile').hidden=id==='all';if(id==='all')return;
  const rows=report.daily.filter(r=>r.employeeId===id).sort((a,b)=>a.values[2].localeCompare(b.values[2]));
  const known=report.employees?.find(r=>r.employeeId===id);
  const total=report.totals.find(r=>r.employeeId===id)||{group:known?.group||'',values:[id,known?.name||id,0,0,0,0,0,0]};
  const minutes=t=>{const [h,m,s]=t.split(':').map(Number);return h*60+m+s/60;};
  const average=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const clock=m=>m==null?'—':String(Math.floor(Math.round(m)/60)).padStart(2,'0')+':'+String(Math.round(m)%60).padStart(2,'0');
  const starts=rows.filter(r=>r.punches.length).map(r=>minutes(r.punches[0]));
  const finishes=rows.filter(r=>r.punches.length>=2&&r.punches.length%2===0).map(r=>minutes(r.punches.at(-1)));
  const lunches=rows.filter(r=>r.values[13]!=null);
  $('profile-title').textContent=(total.values[1]||'Employee')+' · '+id;
  $('profile-subtitle').textContent=total.group+' · '+rows.length+' recorded days · '+report.start+' to '+report.end;
  $('profile-stats').innerHTML=[['Average first punch',clock(average(starts)),'Recorded days only'],['Average last paired punch',clock(average(finishes)),'Even punch-count days'],['Average lunch',lunches.length?Math.round(average(lunches.map(r=>r.values[13]))*60)+' min':'—','Four-punch days only'],['Overtime share',total.values[5]?Math.round(total.values[4]/total.values[5]*100)+'%':'—','Of recorded payroll hours']].map(([k,v,n])=>`<div class="profile-stat"><small>${k}</small><b>${v}</b><small>${n}</small></div>`).join('');
  $('employee-timelines').innerHTML='<div class="timeline-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>'+rows.map(r=>{
    const pts=r.punches.map(minutes),segments=[];for(let i=0;i+1<pts.length;i+=2)segments.push(`<rect x="${pts[i]/1440*500}" y="4" width="${(pts[i+1]-pts[i])/1440*500}" height="14" rx="2" fill="#567c65"/>`);
    const lunch=pts.length===4?`<rect x="${pts[1]/1440*500}" y="4" width="${(pts[2]-pts[1])/1440*500}" height="14" fill="#cfaa75"/>`:'';
    return `<button class="employee-day" data-profile-day="${r.values[2]}" aria-label="View punches on ${r.values[2]}"><span>${r.values[2].slice(5)}${r.values[15].startsWith('ok')?'':' ⚑'}</span><svg viewBox="0 0 500 22" aria-hidden="true"><rect width="500" height="22" fill="#edf0e7"/>${lunch}${segments.join('')}${pts.map(x=>`<circle cx="${x/1440*500}" cy="11" r="2.5" fill="#193d36"/>`).join('')}</svg><strong>${decimal(r.values[9])||'—'}h</strong></button>`;
  }).join('');
  const weeks=new Map();for(const r of rows){const d=new Date(r.values[2]+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));const k=d.toISOString().slice(0,10);const w=weeks.get(k)||{regular:0,ot:0};w.regular+=r.values[10]||0;w.ot+=r.values[11]||0;weeks.set(k,w);}
  const max=Math.max(1,...[...weeks.values()].map(w=>w.regular+w.ot));
  $('employee-weeks').innerHTML=[...weeks].map(([date,w])=>`<div class="week-row"><span>Week of ${date.slice(5)}</span><svg viewBox="0 0 300 18" aria-label="${decimal(w.regular)} regular and ${decimal(w.ot)} overtime payroll hours"><rect width="300" height="18" rx="3" fill="#edf0e7"/><rect width="${w.regular/max*300}" height="18" fill="#567c65"/><rect x="${w.regular/max*300}" width="${w.ot/max*300}" height="18" fill="#bb814a"/></svg><b>${decimal(w.regular+w.ot)}h</b></div>`).join('')+'<p class="caption">Green: regular · Amber: overtime. Partial weeks reflect this range.</p>';
  const maxLunch=Math.max(1,...lunches.map(r=>r.values[13]*60));
  $('employee-lunch').innerHTML=lunches.length?`<svg viewBox="0 0 400 100" class="lunch-trend" role="img" aria-label="Lunch minutes over recorded days"><line x1="10" y1="85" x2="390" y2="85" stroke="#c7cec3"/><polyline points="${lunches.map((r,i)=>`${10+i/Math.max(1,lunches.length-1)*380},${85-r.values[13]*60/maxLunch*65}`).join(' ')}" fill="none" stroke="#bb814a" stroke-width="2"/>${lunches.map((r,i)=>`<circle cx="${10+i/Math.max(1,lunches.length-1)*380}" cy="${85-r.values[13]*60/maxLunch*65}" r="4" fill="#bb814a"><title>${r.values[2]}: ${Math.round(r.values[13]*60)} min</title></circle>`).join('')}<text x="10" y="99" font-size="11" fill="#69746d">${lunches[0].values[2]}</text><text x="390" y="99" text-anchor="end" font-size="11" fill="#69746d">${lunches.at(-1).values[2]}</text></svg><p class="caption">Maximum observed: ${Math.round(maxLunch)} minutes. Hover a point for its date and duration.</p>`:'<p class="caption">No complete lunch intervals in this range.</p>';
  const review=rows.filter(inReviewList);
  $('employee-exceptions').innerHTML=review.map(r=>`<button class="exception-day" data-profile-day="${r.values[2]}"><b>${r.values[2]}</b><span>${esc(r.values[16]||r.values[15])}</span></button>`).join('')||'<p class="caption">No recorded days require review.</p>';
}
$('employee-profile').addEventListener('click',e=>{const b=e.target.closest('[data-profile-day]');if(b){const row=report.daily.find(r=>r.employeeId===$('employee').value&&r.values[2]===b.dataset.profileDay);if(row)openWorkerDay(row);}});
$('worker-open').addEventListener('click',()=>{const employee=$('employee').value;if(employee==='all')return;const row=report.daily.find(r=>r.employeeId===employee);if(row)openWorkerDay(row);else{activeWorker=employee;activeWorkerDay=report.start;$('day-title').textContent='Employee '+employee+' · '+activeWorkerDay;$('day-note').textContent='Loading timestamps…';$('punch-timeline').replaceChildren();$('punch-list').replaceChildren();$('day-values').replaceChildren();if(!$('day-dialog').open)$('day-dialog').showModal();navigateWorkerDay(0);}});
let calendarMonth=today.slice(0,7),calendarDates=null,calendarAnchor=null;
function selectRange(start,end){calendarAnchor=null;calendarDates=new Set();for(let d=start;d<=end;d=shiftDate(d,1))if(d<=today)calendarDates.add(d);}
function shiftDate(date,n){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function renderCalendar(){
  refreshToday();
  if(calendarDates===null)selectRange($('start').value,$('end').value);
  const selectedDates=[...calendarDates].sort();
  $('calendar-selection').textContent=selectedDates.length?selectedDates.length+' days selected · '+selectedDates[0]+' — '+selectedDates.at(-1):'No days selected';
  $('calendar-fetch').disabled=rangeBusy||dayBusy||!selectedDates.length;
  $('calendar-show').disabled=rangeBusy||dayBusy||!selectedDates.length;
  $('calendar-show').textContent=selectedDates.length===1?'Show selected day':'Show selected days';
  const first=new Date(calendarMonth+'-01T12:00:00Z'),offset=(first.getUTCDay()+6)%7;
  $('calendar-month').textContent=first.toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
  const complete=new Set(report?.cache?.completeDates||report?.cache?.coveredDates||[]),partial=new Set(report?.cache?.partialDates||[]),counts=report?.cache?.dayCounts||{};
  $('calendar-days').innerHTML=Array.from({length:42},(_,i)=>{
    const d=shiftDate(calendarMonth+'-01',i-offset),other=d.slice(0,7)!==calendarMonth,future=d>today,state=partial.has(d)||d===today&&complete.has(d)?'partial':complete.has(d)?'cached':'missing',selected=calendarDates.has(d);
    return `<button type="button" data-calendar-date="${d}" class="calendar-day ${state} ${other?'other-month':''} ${selected?'selected':''}" ${future||rangeBusy||dayBusy?'disabled':''} aria-label="${d}: ${state==='cached'?'full day cached; '+(counts[d]||0)+' timestamps':state==='partial'?'partial day; will update':'not yet fetched'}" aria-pressed="${selected}"><b>${Number(d.slice(8))}</b><small>${state==='cached'?(counts[d]||0)+' punches':state==='partial'?'Partial':future?'':'Fetch'}</small></button>`;
  }).join('');
}
$('calendar-toggle').addEventListener('click',()=>{const open=$('calendar-panel').hidden;$('calendar-panel').hidden=!open;$('calendar-toggle').setAttribute('aria-expanded',String(open));$('calendar-toggle').textContent=open?'Hide calendar':'View calendar';renderCalendar();});
$('calendar-days').addEventListener('click',e=>{const b=e.target.closest('[data-calendar-date]');if(!b||rangeBusy||dayBusy)return;const date=b.dataset.calendarDate;if(calendarAnchor&&date!==calendarAnchor){const [start,end]=[date,calendarAnchor].sort();for(let d=start;d<=end;d=shiftDate(d,1))calendarDates.add(d);calendarAnchor=null;}else if(calendarDates.has(date)){calendarDates.delete(date);calendarAnchor=null;}else{calendarDates.add(date);calendarAnchor=date;}const dates=[...calendarDates].sort();if(dates.length){$('start').value=dates[0];$('end').value=dates.at(-1);}$('load-status').textContent=dates.length+' days selected. Press Fetch missing days in the calendar.';renderCalendar();});
for(const id of ['start','end'])$(id).addEventListener('change',()=>{calendarDates=null;renderCalendar();});
$('period-presets').addEventListener('click',e=>{refreshToday();const b=e.target.closest('[data-period]');if(!b||rangeBusy||dayBusy)return;const anchor=$('start').value||today;let start=anchor,end=anchor;const date=new Date(anchor+'T12:00:00Z');if(b.dataset.period==='day'){start=shiftDate(today,-1);end=start;}else if(b.dataset.period==='week'){const now=new Date(today+'T12:00:00Z');end=shiftDate(today,-((now.getUTCDay()+6)%7)-1);start=shiftDate(end,-6);}else if(['two','four'].includes(b.dataset.period)){const now=new Date(today+'T12:00:00Z');end=shiftDate(today,-((now.getUTCDay()+6)%7)-1);start=shiftDate(end,1-(b.dataset.period==='two'?14:28));}else if(b.dataset.period==='total'){start=report?.cache?.start;end=report?.cache?.end;if(!start||!end){$('load-status').textContent='Fetch a day first to start your local history.';return;}}$('start').value=start;$('end').value=end;selectRange(start,end);calendarMonth=start.slice(0,7);renderCalendar();document.querySelectorAll('[data-period]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));loadRange(true,true);});
for(const [id,n] of [['calendar-prev',-1],['calendar-next',1]])$(id).addEventListener('click',()=>{const d=new Date(calendarMonth+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);calendarMonth=d.toISOString().slice(0,7);renderCalendar();});
function updateDayButtons(){ $('worker-prev').disabled=dayBusy||rangeBusy;$('worker-next').disabled=dayBusy||rangeBusy||activeWorkerDay>=today;$('load-report').disabled=dayBusy||rangeBusy;$('calendar-fetch').disabled=dayBusy||rangeBusy||calendarDates?.size===0;$('calendar-show').disabled=dayBusy||rangeBusy||calendarDates?.size===0; }
async function navigateWorkerDay(n){
  if(dayBusy||rangeBusy||!activeWorker)return;const day=shiftDate(activeWorkerDay,n);if(day>today)return;
  const employee=activeWorker,generation=++dayGeneration;dayBusy=true;updateDayButtons();renderCalendar();$('worker-day-status').textContent='Loading '+day+'…';
  try{
    const value=await fetchReport(day,day,false);
    if(report){report.cache=value.report.cache;renderCalendar();}
    if(generation!==dayGeneration)return;
    let row=value.report.daily.find(r=>r.employeeId===employee);
    if(!row){const known=(value.report.employees||[]).find(r=>r.employeeId===employee);row={employeeId:employee,punches:[],values:[null,known?.name||employee,day,new Date(day+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long',timeZone:'UTC'}),0,'','','','',null,null,null,null,null,null,'No punches','This day was fetched for all employees; there are no recorded punches for this employee.']};}
    showDay(row);$('worker-day-status').textContent=day+(value.report.cache.partialDates.includes(day)?' · Partial':' · Cached');
  }catch(e){if(generation===dayGeneration)$('worker-day-status').textContent=e.message;}
  finally{dayBusy=false;updateDayButtons();renderCalendar();}
}
$('worker-prev').addEventListener('click',()=>navigateWorkerDay(-1));$('worker-next').addEventListener('click',()=>navigateWorkerDay(1));
$('day-dialog').addEventListener('close',()=>{dayGeneration++;});
async function initialize(){
  $('start').max=today;
  request('/api/payclock/schedule').then(s=>{$('schedule-status').textContent='Automatic pull: 11 PM Pacific while this computer and dashboard are running. Yesterday is finalized; today remains partial.'+(s.lastSuccess?' Last completed: '+new Date(s.lastSuccess).toLocaleString()+'.':'')+(s.error?' Last attempt: '+s.error:'');}).catch(()=>{});
  try{$('load-status').textContent='Loading your saved local history…';const value=await request('/api/payclock/latest');if(value.report){$('start').value=value.report.start;$('end').value=value.report.end;displayReport(value.report,value.id);}else{$('load-status').textContent='Select a day or range to fetch missing timestamps.';renderCalendar();}}
  catch(e){$('time-error').textContent=e.message;$('time-error').hidden=false;renderCalendar();}
}
initialize();
setInterval(()=>{const previous=today;refreshToday();if(today!==previous)renderCalendar();},60000);

let editingRow=null;
const roleOptions=[['in','Arrival'],['lunchOut','Lunch out'],['lunchIn','Lunch in'],['out','Departure'],['extra','Extra / unassigned']];
function editorEntry(p){return `<div class="punch-edit"><label><input type="checkbox" class="punch-enabled" ${p.enabled?'checked':''}> Include</label><input class="punch-time" type="time" step="1" value="${esc(p.time)}" aria-label="Punch time"><select class="punch-role" aria-label="Punch assignment">${roleOptions.map(([role,label])=>`<option value="${role}" ${role===p.role?'selected':''}>${label}</option>`).join('')}</select></div>`;}
function changeSummary(edit,previous){const baseline=previous?.punches||(edit.original||[]).map(time=>({time,enabled:true,role:null}));const before=new Map(baseline.map(p=>[p.time,p])),after=new Map(edit.punches.map(p=>[p.time,p])),changes=[];for(const p of edit.punches){const old=before.get(p.time);if(!old)changes.push('Added '+p.time+' as '+p.role);else{if(p.enabled!==old.enabled)changes.push((p.enabled?'Enabled ':'Disabled ')+p.time);if(p.role!==old.role)changes.push(p.time+' assigned '+p.role);}}for(const p of baseline)if(!after.has(p.time))changes.push('Removed local entry '+p.time);return changes.join('; ')||'Punch entries unchanged; reason updated';}
function renderPunchEditor(row){editingRow=row;$('correction-undo').disabled=!row.audit?.length;$('correction-original').disabled=!row.audit?.length||Boolean(row.audit[0].restoreOriginal);$('correction-note').value='';$('correction-status').textContent='';const suggestion=row.suggestion;$('punch-suggestion').textContent=suggestion?`Suggested assignments (${suggestion.confidence} confidence): ${suggestion.flags.join('; ')||'No punch-count issue'}. Based on ${suggestion.basis}.`:'No suggestion available. Review every assignment.';
 const entries=(row.audit?.[0]?.punches?.map(p=>({...p}))||suggestion?.punches||row.punches.map((time,i)=>({time,enabled:true,role:roleOptions[Math.min(i,4)][0]})));if(row.audit?.length){const seen=new Set(entries.map(p=>p.time)),original=new Set(row.audit[0].original||[]);for(const time of row.originalPunches||[])if(!seen.has(time)&&!original.has(time))entries.push({time,role:'extra',enabled:true});}$('punch-editor').innerHTML=entries.map(editorEntry).join('');
 $('correction-history').innerHTML=(row.audit||[]).map((a,index)=>`<details><summary>${esc(a.actor)} · ${esc(new Date(a.at).toLocaleString())} · ${esc(a.note)}</summary><p>${esc(changeSummary(a,row.audit[index+1]))}</p><p>Revision ${a.id}. Saved entries: ${a.punches.map(p=>esc(p.time)+' '+esc(roleOptions.find(x=>x[0]===p.role)?.[1]||p.role)+(p.enabled?'':' [disabled]')).join('; ')}</p></details>`).join('')||'<p>No local corrections.</p>';
 $('punch-list').innerHTML=(row.originalPunches||row.punches).map((t,i)=>`<li>Original clock punch ${i+1}: <b>${esc(t)}</b></li>`).join('');
}
function draftPunches(){return [...$('punch-editor').querySelectorAll('.punch-edit')].map(el=>{let time=el.querySelector('.punch-time').value;if(time.length===5)time+=':00';return {time,role:el.querySelector('.punch-role').value,enabled:el.querySelector('.punch-enabled').checked};});}
function expectedPunchTimes(){return editingRow?.suggestion?.expectedTimes||['08:00:00','12:00:00','13:00:00','17:00:00'];}
function reassignDraft(){const assigned=assignPunchRoles(draftPunches(),expectedPunchTimes());[...$('punch-editor').querySelectorAll('.punch-edit')].forEach((el,i)=>el.querySelector('.punch-role').value=assigned[i].role);$('correction-status').textContent='Draft assignments updated from enabled punches. Verify the suggestions before saving.';return assigned;}
$('punch-editor').addEventListener('change',e=>{if(e.target.classList.contains('punch-enabled'))reassignDraft();});
$('punch-add').addEventListener('click',()=>{const assigned=reassignDraft(),suggested=suggestMissingPunch(assigned,expectedPunchTimes());if(!suggested){$('correction-status').textContent='All four shift roles are already assigned, or no valid time gap is available. Exclude an extra punch or adjust its assignment first.';return;}$('punch-editor').insertAdjacentHTML('beforeend',editorEntry(suggested));reassignDraft();const label=roleOptions.find(r=>r[0]===suggested.role)?.[1]||suggested.role;$('correction-status').textContent='Suggested '+label+' at '+suggested.time+'. Verify or edit this estimated time before saving.';});
$('correction-save').addEventListener('click',async()=>{
 if(!editingRow||rangeBusy||dayBusy)return;const row=editingRow,employee=row.employeeId,day=row.values[2];const punches=[...$('punch-editor').querySelectorAll('.punch-edit')].map(el=>{let time=el.querySelector('.punch-time').value;if(time.length===5)time+=':00';return {time,role:el.querySelector('.punch-role').value,enabled:el.querySelector('.punch-enabled').checked};});
 $('correction-save').disabled=true;try{await request('/api/payclock/adjustments',{method:'POST',headers:{'Content-Type':'application/json','X-Mir-Request':'dashboard'},body:JSON.stringify({employee,day,revision:row.revision||0,original:row.originalPunches||row.punches,note:$('correction-note').value,punches})});const savedSheet=sheet,savedSort=sortColumn,savedDirection=sortDirection;const team=$('team').value,selectedEmployee=$('employee').value;const current=await fetchReport(report.start,report.end,true,true,report.selectedDates||null);displayReport(current.report,current.id);sheet=savedSheet;sortColumn=savedSort;sortDirection=savedDirection;$('team').value=team;populateEmployees();$('employee').value=selectedEmployee;render();let changed=report.daily.find(r=>r.employeeId===employee&&r.values[2]===day);if(!changed){const detail=await fetchReport(day,day,false,true);changed=detail.report.daily.find(r=>r.employeeId===employee);}if(changed)showDay(changed);$('correction-status').textContent='Saved locally. All users share this correction; clock records were not changed.';}
 catch(e){$('correction-status').textContent=e.message;}finally{$('correction-save').disabled=false;}
});
setInterval(async()=>{if(!report||rangeBusy||dayBusy||$('day-dialog').open||$('pattern-dialog').open)return;let ownsBusy=false;try{const value=await request('/api/payclock/revision');if(value.revision!==(report.adjustmentsRevision||0)&&!rangeBusy&&!dayBusy){ownsBusy=true;rangeBusy=true;const savedSheet=sheet,savedSort=sortColumn,savedDirection=sortDirection;const team=$('team').value,employee=$('employee').value;const updated=await fetchReport(report.start,report.end,true,true,report.selectedDates||null);displayReport(updated.report,updated.id);sheet=savedSheet;sortColumn=savedSort;sortDirection=savedDirection;$('team').value=team;populateEmployees();$('employee').value=employee;render();}}catch{}finally{if(ownsBusy)rangeBusy=false;}},15000);

$('correction-reload').addEventListener('click',()=>navigateWorkerDay(0));

async function undoCorrection(originalClock){if(!editingRow||rangeBusy||dayBusy)return;const row=editingRow;$('correction-undo').disabled=true;$('correction-original').disabled=true;try{await request('/api/payclock/undo',{method:'POST',headers:{'Content-Type':'application/json','X-Mir-Request':'dashboard'},body:JSON.stringify({employee:row.employeeId,day:row.values[2],revision:row.revision||0,original:row.originalPunches||row.punches,originalClock})});const detail=await fetchReport(row.values[2],row.values[2],false,true);const changed=detail.report.daily.find(r=>r.employeeId===row.employeeId);if(changed)showDay(changed);else{$('day-dialog').close();}const savedSheet=sheet,savedSort=sortColumn,savedDirection=sortDirection;const team=$('team').value,employee=$('employee').value;const value=await fetchReport(report.start,report.end,true,true,report.selectedDates||null);displayReport(value.report,value.id);sheet=savedSheet;sortColumn=savedSort;sortDirection=savedDirection;$('team').value=team;populateEmployees();$('employee').value=employee;render();$('correction-status').textContent='Change reversed locally. History retained.';}catch(e){$('correction-status').textContent=e.message;}finally{if(editingRow){$('correction-undo').disabled=!editingRow.audit?.length;$('correction-original').disabled=!editingRow.audit?.length||Boolean(editingRow.audit[0].restoreOriginal);}}}
$('correction-undo').addEventListener('click',()=>undoCorrection(false));$('correction-original').addEventListener('click',()=>undoCorrection(true));

let patternIndex=null,patternPage=1,patternRows=[];
function showPattern(index){patternIndex=index;patternPage=1;renderPatternList();if(!$('pattern-dialog').open)$('pattern-dialog').showModal();}
function renderPatternList(){const pattern=report?.reviewPatterns?.[patternIndex];if(!pattern)return;patternRows=report.daily.map((row,index)=>({row,index})).filter(({row})=>matching(row)&&row.suggestion?.flags?.includes(pattern.pattern)).sort((a,b)=>a.row.values[2].localeCompare(b.row.values[2])||a.row.values[1].localeCompare(b.row.values[1]));const pages=Math.max(1,Math.ceil(patternRows.length/50));patternPage=Math.min(patternPage,pages);$('pattern-title').textContent=pattern.pattern;$('pattern-description').textContent=patternRows.length+' matching employee-days · '+report.start+' — '+report.end+'. Uses your team and employee filters. Select a day to inspect original punches and suggestions.';$('pattern-body').innerHTML=patternRows.slice((patternPage-1)*50,patternPage*50).map(({row,index})=>`<tr><td><button class="order-link" data-pattern-row="${index}">${esc(row.values[1]||row.employeeId)}</button></td><td>${esc(row.values[2])}</td><td>${esc((row.originalPunches||row.punches).join(' · '))}</td><td>${esc(row.values[15])}${row.audit?.length?' · Correction recorded':''}</td><td><button data-pattern-row="${index}">View day</button></td></tr>`).join('')||'<tr><td colspan="5">No matching days.</td></tr>';$('pattern-page').textContent='Page '+patternPage+' of '+pages;$('pattern-prev').disabled=patternPage<=1;$('pattern-next').disabled=patternPage>=pages;}
$('review-patterns').addEventListener('click',e=>{const button=e.target.closest('[data-pattern]');if(button)showPattern(Number(button.dataset.pattern));});
$('pattern-close').addEventListener('click',()=>$('pattern-dialog').close());
$('pattern-prev').addEventListener('click',()=>{patternPage--;renderPatternList();});$('pattern-next').addEventListener('click',()=>{patternPage++;renderPatternList();});
$('pattern-body').addEventListener('click',e=>{const button=e.target.closest('[data-pattern-row]');if(!button)return;const row=report.daily[Number(button.dataset.patternRow)];if(row){$('pattern-dialog').close();openWorkerDay(row);}});

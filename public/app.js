let state, page=0;
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={partner:'AI Email Processor',fedfish:'FedFish Central',payclock:'Payclock',inventory:'Available Inventory'};
const number=v=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(v);
function date(v){return v?new Intl.DateTimeFormat('en-US',{timeZone:state?.timezone || 'America/Los_Angeles',month:'short',day:'numeric',year:'numeric'}).format(new Date(v.length===10?v+'T12:00:00Z':v)):'Unknown';}
function renderOrders(){
  const filter=$('filter').value, all=state.orders.filter(x=>filter==='all' || x[filter]);
  const pages=Math.max(1,Math.ceil(all.length/12));page=Math.min(page,pages-1);
  const rows=all.slice(page*12,page*12+12);
  $('orders').innerHTML=rows.map(x=>`<tr><td><b>${esc(x.customer)}</b><small>PO ${esc(x.po || 'not extracted')}</small></td><td>${esc(date(x.date))}</td><td><span class="pill ${x.failed || x.review?'':'green'}">${esc(x.status.replaceAll('_',' '))}</span>${x.review?'<small>Review flag present</small>':''}</td><td>${x.lines}</td><td>${esc(x.so || 'Not recorded')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No saved orders match this period and filter.</td></tr>';
  $('order-count').textContent=all.length+' matching saved orders. Status reflects the latest saved payload, not verified fulfillment.';
  $('page-label').textContent=`Page ${page+1} of ${pages}`;$('prev').disabled=page===0;$('next').disabled=page>=pages-1;
}
const clock=v=>new Date(v).toLocaleTimeString('en-US',{timeZone:state?.timezone || 'America/Los_Angeles',hour:'numeric',minute:'2-digit'});
function seen(v){if(!v)return 'Never';const minutes=Math.round((Date.now()-Date.parse(v))/60000);return minutes<1?'Just now':minutes<60?minutes+' min ago':date(v)+' '+clock(v);}
const outcomes={succeeded:['Succeeded','green'],failed:['Failed','warn'],unknown:['Unknown','']};
const plural=(n,word)=>n+' '+word+(n===1?'':'s');
function renderFedfish(){
  const f=state.fedfish,src=state.sources.fedfish,m=state.metrics,failing=$('send-filter').value==='failing';
  $('fedfish-summary').textContent=src.state==='connected'?`${plural(m.fedfishSends,'send')} in this period · ${m.fedfishFailed} failed · ${plural(f.pcs.length,'PC')}`:'FedFish Central unavailable';
  $('pcs').innerHTML=f.pcs.map(p=>{
    // FedFish checks in every five minutes while it is open.
    const connected=!p.blocked && p.lastSeen && Date.now()-Date.parse(p.lastSeen)<15*60000;
    return `<tr><td><b>${esc(p.name)}</b><small>${esc([p.computer,p.user].filter(Boolean).join(' · ') || 'Computer not reported')}</small></td><td><span class="pill ${p.blocked?'warn':connected?'green':''}">${p.blocked?'Blocked':connected?'Connected':'Not connected'}</span></td><td>${esc(seen(p.lastSeen))}</td><td>${p.sends}${p.failed?`<small>${p.failed} failed</small>`:''}</td><td><button class="small" data-pc="${esc(p.name)}" >View</button></td></tr>`;
  }).join('') || `<tr><td colspan="5" class="empty">${esc(src.state==='connected'?'No FedFish PC has connected yet.':src.detail)}</td></tr>`;
  $('sends').innerHTML=(failing?f.failing:f.recent).map(r=>{const [label,tone]=outcomes[r.outcome];
    return `<tr><td><b>${esc(r.so)}</b><small>PO ${esc(r.po || 'not recorded')}</small></td><td>${esc(r.shipTo || 'Not recorded')}</td><td>${esc(r.pc)}</td><td>${r.at?esc(date(r.at)+' '+clock(r.at)):'Before Central (no time)'}</td><td><span class="pill ${tone}">${label}</span>${r.error?`<small>${esc(r.error)}</small>`:''}</td></tr>`;
  }).join('') || `<tr><td colspan="5" class="empty">${failing?'No order has a failed latest send.':'No FedFish sends in this period.'}</td></tr>`;
}
function render(){
  const s=state,m=s.metrics,p=s.period;
  $('updated').textContent='Observed '+date(s.checkedAt)+' · '+new Date(s.checkedAt).toLocaleTimeString('en-US',{timeZone:s.timezone,hour:'numeric',minute:'2-digit'})+' PT';
  const connected=Object.values(s.sources).filter(x=>x.state==='connected').length;
  $('brief-title').textContent=m.failed || m.review ? 'Start with the exceptions your team can resolve.' : 'Start with the evidence you can trust.';
  $('brief-text').textContent=`${m.orders} saved orders cover ${date(p.start)}–${date(p.end)}. ${m.review} carry review flags and ${m.failed} have a recorded processing failure. ${connected} of 4 sources are readable. `+(m.laborRows?`${number(m.workedHours)} worked hours appear in the selected period.`:'No exported worked hours cover this window; current attendance is unknown.');
  $('brief-foot').textContent='Recommendations are advisory. Model '+(s.ai.enabled && s.ai.configured?'configured; request advice below.':'not connected; these assessments use transparent local rules.')+' Order history and payload inspection are read-only.';
  const metrics=[['Saved orders',m.orders,'Observed in selected period'],['Orders needing review',m.review,'Flagged orders not yet pushed'],['Exported worked hours',m.laborRows?number(m.workedHours):'—',m.laborRows?'Includes provisional review days':'No export coverage in this period'],['Zero-quantity inventory rows',s.sources.inventory.state==='connected'?m.zeroStock:'—',s.sources.inventory.partial?'Partial snapshot · warehouse identity absent':'Current snapshot · warehouse identity absent']];
  $('metrics').innerHTML=metrics.map(([label,value,note])=>`<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><small>${note}</small></div>`).join('');
  const max=Math.max(1,...s.daily.map(x=>x.orders));
  $('chart').innerHTML=`<svg viewBox="0 0 ${s.daily.length*14} 180" preserveAspectRatio="none" role="img" aria-label="Saved order count by received date; maximum ${max} orders in one day">${s.daily.map((x,i)=>{const h=Math.max(2,x.orders/max*165);return `<rect x="${i*14}" y="${180-h}" width="10" height="${h}" rx="2" fill="#567c65"><title>${esc(x.date)}: ${x.orders} saved orders</title></rect>`;}).join('')}</svg>`;
  $('period-label').textContent=date(p.start)+' — '+date(p.end);
  $('coverage').innerHTML=Object.entries(s.sources).map(([k,v])=>`<div class="source-health"><span>${names[k]}</span><span class="health ${v.state!=='connected' || k==='payclock' && v.latestDay<p.start?'warn':''}">${v.state==='connected'?(k==='payclock' && v.latestDay<p.start?'Historical exports':'Readable'):'Unavailable'}</span></div>`).join('');
  $('insights').innerHTML=s.insights.map(x=>`<article class="insight ${x.priority==='High'?'high':''}"><span class="pill">${esc(x.priority)} priority</span><h3>${esc(x.title)}</h3><p class="evidence">${esc(x.evidence)}</p><p>${esc(x.recommendation)}</p><div class="measure"><b>Measure progress</b><br>${esc(x.measure)}</div><div class="basis">${esc(x.basis)}</div></article>`).join('');
  $('source-list').innerHTML=Object.entries(s.sources).map(([k,v])=>{
    let note=k==='partner'?`${v.records.length} readable saved payloads · ${v.errors} skipped records`:k==='payclock'?`${v.files.length} export files · latest work date ${v.latestDay || 'unknown'} · ${v.errors.length} skipped files`:k==='fedfish'?`${plural(v.total,'recorded send')} · ${plural(v.pcs.length,'FedFish PC')}${v.pcs.some(p=>p.blocked)?' · '+v.pcs.filter(p=>p.blocked).length+' blocked':''}`:`${v.rows.length} inventory rows returned${v.total!=null?' of '+v.total:''}${v.partial?' · partial coverage':''}`;
    return `<div class="source-card"><h3>${names[k]}</h3><span class="pill ${v.state==='connected'?'green':''}">${esc(v.state)}</span><p>${esc(v.detail)}</p><small>${esc(note)}</small>${k==='payclock'?'<p><a class="timestamp-link" href="/payclock">View timestamps →</a></p>':''}${k==='inventory' && v.checkedAt?`<p>Snapshot: ${esc(date(v.checkedAt))} ${esc(new Date(v.checkedAt).toLocaleTimeString())}</p>`:''}</div>`;
  }).join('');
  $('limitations').innerHTML=s.limits.map(x=>'<li>'+esc(x)+'</li>').join('');
  $('model-state').textContent=s.ai.enabled && s.ai.configured?`Model configured (${s.ai.provider}). ${s.ai.provider==='openai'?'Questions and aggregate summaries are sent to OpenAI only when you ask.':'Summary advice uses the local model.'}`:'AI model not connected. Local assessments work now; see the setup guide to connect a local model or explicitly enable cloud summaries.';
  $('overview-links').innerHTML=[['FedFish','/fedfish',plural(s.sources.fedfish.total,'recorded send')+' · '+plural(s.fedfish.pcs.length,'PC'),'Browse shared history and inspect payloads'],['Payclock','/payclock',s.sources.payclock.latestDay?'Cached through '+s.sources.payclock.latestDay:'No timestamps cached','Explore employee hours and timestamps'],['AI Email Processor','/email',m.orders+' saved orders · '+m.review+' needing review','Review email processing and order results']].map(([title,url,value,note])=>`<a class="system-card" href="${url}"><h2>${title} ↗</h2><strong>${esc(value)}</strong><p>${note}</p></a>`).join('');
  if(screen==='/email')$('metrics').innerHTML=[['Saved orders',m.orders],['Needs review',m.review],['Pushed to Fishbowl',m.pushed],['Processing failures',m.failed]].map(([label,value])=>`<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`).join('');
  renderOrders();renderFedfish();
}
async function load(){
  $('refresh').disabled=true;
  try{const r=await fetch('/api/snapshot?days='+$('period').value);const s=await r.json();if(!r.ok)throw Error(s.error);state=s;$('error').hidden=true;render();}
  catch(e){$('error').textContent=e.message || 'Could not read sources.';$('error').hidden=false;}
  finally{$('refresh').disabled=false;}
}
$('period').addEventListener('change',()=>{page=0;load();});$('refresh').addEventListener('click',load);
$('filter').addEventListener('change',()=>{page=0;renderOrders();});$('send-filter').addEventListener('change',renderFedfish);
$('pcs').addEventListener('click',e=>{const b=e.target.closest('button[data-pc]');if(b)openHistory(b.dataset.pc);});
$('prev').addEventListener('click',()=>{page--;renderOrders();});$('next').addEventListener('click',()=>{page++;renderOrders();});
$('download').addEventListener('click',()=>{
  if(!state)return;
  const s=state;const report=`# Mir Mosaic — Operating briefing\n\nObserved: ${s.checkedAt}\nPeriod: ${s.period.start} to ${s.period.end}\nEngine: local rules; recommendations require human review\n\n## Metrics\n${Object.entries(s.metrics).map(([k,v])=>'- '+k+': '+v).join('\n')}\n\n## Assessments\n${s.insights.map(x=>`### ${x.title}\nEvidence: ${x.evidence}\nRecommendation: ${x.recommendation}\nMeasure: ${x.measure}\nSource: ${x.basis}`).join('\n\n')}\n\n## Source coverage\n${Object.entries(s.sources).map(([k,v])=>`${names[k]}: ${v.state}. ${v.detail}`).join('\n')}\n\n## Limitations\n${s.limits.map(x=>'- '+x).join('\n')}\n`;
  const url=URL.createObjectURL(new Blob([report],{type:'text/markdown'}));const a=document.createElement('a');a.href=url;a.download='mir-briefing-'+s.period.end+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('ask-form').addEventListener('submit',async e=>{e.preventDefault();$('ask-button').disabled=true;$('answer').hidden=false;$('answer').textContent='Reviewing the available summary…';try{const r=await fetch('/api/advice',{method:'POST',headers:{'Content-Type':'application/json','X-Mir-Request':'dashboard'},body:JSON.stringify({question:$('question').value,days:Number($('period').value)})});const p=await r.json();if(!r.ok)throw Error(p.error);$('answer').textContent=p.answer;}catch(e){$('answer').textContent=e.message;}finally{$('ask-button').disabled=false;}});
let historyPc='',historyPageNumber=1,historyPages=1,historyRequest=0,detailRequest=0;
async function openHistory(pc){historyPc=pc;historyPageNumber=1;$('history-query').value='';$('fedfish-history').hidden=false;await loadHistory();$('fedfish-history').scrollIntoView({behavior:'smooth'});}
async function loadHistory(){
  const request=++historyRequest;
  $('history-title').textContent=historyPc?historyPc+' · Order history':'All PCs · Order history';
  $('history-status').textContent='Loading orders…';$('history-rows').replaceChildren();$('history-page').textContent='';
  $('history-prev').disabled=true;$('history-next').disabled=true;
  try{
    const params=new URLSearchParams({pc:historyPc,page:String(historyPageNumber),pageSize:$('history-size').value,q:$('history-query').value});
    const response=await fetch('/api/fedfish/history?'+params);const h=await response.json();if(!response.ok)throw Error(h.error);
    if(request!==historyRequest)return;
    historyPageNumber=h.page;historyPages=h.pages;
    $('history-status').textContent=h.total+' recorded orders / attempts · includes undated imports';
    $('history-rows').innerHTML=h.rows.map(r=>`<tr data-sequence="${r.sequence}"><td><button class="order-link" data-sequence="${r.sequence}" aria-label="View payload for ${esc(r.so)}">${esc(r.so)}</button><small>PO ${esc(r.po||'not recorded')}</small></td><td>${esc(r.shipTo||'Not recorded')}</td><td>${esc(r.pc)}</td><td>${r.at?esc(date(r.at)+' '+clock(r.at)):'Unknown'}${r.legacy?'<small>Imported cache</small>':''}</td><td><span class="pill ${outcomes[r.outcome][1]}">${outcomes[r.outcome][0]}</span></td></tr>`).join('')||'<tr><td colspan="5" class="empty">No matching records.</td></tr>';
    $('history-page').textContent=`Page ${h.page} of ${h.pages}`;$('history-prev').disabled=h.page<=1;$('history-next').disabled=h.page>=h.pages;
  }catch(e){if(request===historyRequest)$('history-status').textContent=e.message||'Could not load history.';}
}
async function showOrder(sequence){
  const request=++detailRequest;
  $('detail-title').textContent='Order details';$('detail-status').textContent='Loading saved payload…';$('detail-content').hidden=true;
  if(!$('order-dialog').open)$('order-dialog').showModal();
  try{
    const response=await fetch('/api/fedfish/order?sequence='+sequence);const event=await response.json();if(!response.ok)throw Error(event.error);
    if(request!==detailRequest)return;
    $('detail-title').textContent=event.so_num+' · Saved order';$('detail-status').textContent='Read-only copy from FedFish Central';
    const fields=[['FedFish PC',event.client_name],['Sent by',event.actor||'Not recorded in this cache'],['Send time',event.occurred_at?date(event.occurred_at)+' '+clock(event.occurred_at):'Unknown — no send timestamp recorded'],['Ship date in payload',event.payload?.header?.ship_date||'Not provided'],['Received by Central',event.received_at?date(event.received_at)+' '+clock(event.received_at):'Unknown'],['Result',outcomes[event.outcome]?.[0]||'Unknown'],['Record',event.sequence]];
    $('detail-meta').innerHTML=fields.map(([key,value])=>`<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
    $('detail-payload').textContent=JSON.stringify(event.payload,null,2);
    $('detail-response').textContent=Object.hasOwn(event,'response')?JSON.stringify(event.response,null,2):'No response was recorded.';
    $('detail-content').hidden=false;
  }catch(e){if(request===detailRequest)$('detail-status').textContent=e.message||'Could not load this order.';}
}
$('history-rows').addEventListener('click',e=>{const row=e.target.closest('[data-sequence]');if(row)showOrder(Number(row.dataset.sequence));});
$('history-all').addEventListener('click',()=>openHistory(''));
$('history-search').addEventListener('submit',e=>{e.preventDefault();historyPageNumber=1;loadHistory();});
$('history-size').addEventListener('change',()=>{historyPageNumber=1;loadHistory();});
$('history-prev').addEventListener('click',()=>{if(historyPageNumber>1){historyPageNumber--;loadHistory();}});
$('history-next').addEventListener('click',()=>{if(historyPageNumber<historyPages){historyPageNumber++;loadHistory();}});
$('detail-close').addEventListener('click',()=>$('order-dialog').close());
$('order-dialog').addEventListener('close',()=>{detailRequest++;});
const screen=location.pathname;
function screenLayout(){
  const overview=screen==='/',email=screen==='/email',fedfish=screen==='/fedfish',adviser=screen==='/adviser';
  document.body.classList.add(overview?'page-overview':email?'page-email':fedfish?'page-fedfish':'page-adviser');
  document.querySelectorAll('[data-route]').forEach(a=>{if(a.dataset.route===screen)a.setAttribute('aria-current','page');});
  $('activity').hidden=!email;$('fedfish').hidden=!fedfish;$('assessments').hidden=!adviser;$('adviser').hidden=!adviser;$('sources').hidden=!adviser;
  document.querySelector('.briefing').hidden=!overview;$('metrics').hidden=!(overview||email);document.querySelector('.split').hidden=!email;
  $('overview-links').hidden=!overview;
  $('overview').textContent=overview?'Your company, at a glance.':email?'AI Email Processor':fedfish?'FedFish Central':'Assessments & strategy';
  document.querySelector('header p').textContent=overview?'Open a system to explore its activity and details.':email?'Saved email extraction, review and Fishbowl processing results.':fedfish?'Company-wide order history, connected PCs and saved payloads.':'Evidence, recommendations and questions for Mira.';
  document.title=(overview?'Overview':email?'AI Email Processor':fedfish?'FedFish':'Mira')+' · Mir Mosaic';
}
screenLayout();load();setInterval(load,60000);

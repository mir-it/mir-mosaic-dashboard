import {centralRequest} from './monitor.mjs';

export function historyPage(rows, {pc='',page=1,pageSize=20,query=''}={}) {
  if(!Number.isSafeInteger(page) || page<1 || ![20,50,100].includes(pageSize) || pc.length>100 || query.length>160) throw Error('Invalid history filters.');
  const term=query.trim().toLowerCase();
  const matching=rows.filter(r=>(!pc || r.pc.toLowerCase()===pc.toLowerCase()) && (!term || [r.so,r.po,r.shipTo].some(v=>String(v||'').toLowerCase().includes(term)))).sort((a,b)=>b.sequence-a.sequence);
  const pages=Math.max(1,Math.ceil(matching.length/pageSize));page=Math.min(page,pages);
  return {rows:matching.slice((page-1)*pageSize,page*pageSize),total:matching.length,page,pages,pageSize,pc};
}

export async function orderDetail(config, sequence) {
  if(!Number.isSafeInteger(sequence) || sequence<1) throw Error('Invalid order record.');
  const result=await centralRequest(config.fedfishCentral,'GET',`/v1/events?after=${sequence-1}&limit=1`);
  const event=result.events?.[0];
  return event?.sequence===sequence?event:null;
}

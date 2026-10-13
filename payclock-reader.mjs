import {readFile,readdir,stat,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';
const decode=s=>String(s??'').replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,(_,n,name)=>n?String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n)):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name]));
const attr=(s,key)=>decode(s.match(new RegExp('(?:^|\\s)'+key+'="([^"]*)"'))?.[1] || '');
const content=s=>decode([...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m=>m[1]).join(''));
// ZIP central directory gives safe member bounds; no extraction or source writes.
export function zipMembers(buffer){
  let end=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw Error('Invalid XLSX archive');
  const count=buffer.readUInt16LE(end+10);let offset=buffer.readUInt32LE(end+16),total=0;const entries=new Map();
  for(let i=0;i<count;i++){
    if(buffer.readUInt32LE(offset)!==0x02014b50)throw Error('Invalid ZIP directory');
    const method=buffer.readUInt16LE(offset+10),compressed=buffer.readUInt32LE(offset+20),size=buffer.readUInt32LE(offset+24),nameLen=buffer.readUInt16LE(offset+28),extra=buffer.readUInt16LE(offset+30),comment=buffer.readUInt16LE(offset+32),local=buffer.readUInt32LE(offset+42);
    total+=size;if(total>40_000_000)throw Error('Export too large');
    const name=buffer.subarray(offset+46,offset+46+nameLen).toString('utf8');entries.set(name,{method,compressed,size,local});offset+=46+nameLen+extra+comment;
  }
  return name=>{
    const e=entries.get(name);if(!e)return null;
    if(buffer.readUInt32LE(e.local)!==0x04034b50)throw Error('Invalid ZIP member');
    const start=e.local+30+buffer.readUInt16LE(e.local+26)+buffer.readUInt16LE(e.local+28);
    if(start+e.compressed>buffer.length)throw Error('Invalid ZIP bounds');
    const b=buffer.subarray(start,start+e.compressed);
    const data=e.method===0?b:e.method===8?inflateRawSync(b,{maxOutputLength:40_000_000}):null;
    if(!data || data.length!==e.size)throw Error('Invalid ZIP compression');return data.toString('utf8');
  };
}
export function xlsxDaily(buffer){
  const get=zipMembers(buffer);const book=get('xl/workbook.xml') || '';
  const sheet=[...book.matchAll(/<sheet\s([^>]+)\/?\s*>/g)].find(m=>attr(m[1],'name')==='Daily Hours');
  if(!sheet)throw Error('Daily Hours sheet missing');
  const id=attr(sheet[1],'r:id');const rel=[...(get('xl/_rels/workbook.xml.rels')||'').matchAll(/<Relationship\s([^>]+)\/?\s*>/g)].find(m=>attr(m[1],'Id')===id);
  if(!rel)throw Error('Sheet relationship missing');
  let target=attr(rel[1],'Target').replace(/^\//,'');if(!target.startsWith('xl/'))target='xl/'+target;
  const strings=[...(get('xl/sharedStrings.xml')||'').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(m=>content(m[1]));
  const xml=get(target);if(!xml)throw Error('Sheet unavailable');
  const rows=[];
  for(const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)){
    const values=[];
    for(const c of row[1].matchAll(/<c\s([^>]+?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const ref=attr(c[1],'r').replace(/\d/g,'');let col=0;for(const ch of ref)col=col*26+ch.charCodeAt(0)-64;
      const body=c[2] || '',type=attr(c[1],'t'),v=decode(body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1] || '');
      values[col-1]=type==='inlineStr'?content(body):type==='s'?strings[Number(v)] || '':v;
    }
    rows.push(values);
  }
  const headers=rows.shift() || [];
  if(!headers.includes('Date') || !headers.includes('Hours Worked') || !headers.includes('Name'))throw Error('Unsupported daily headers');
  return rows.map(values=>{
    const r=Object.fromEntries(headers.map((h,i)=>[h,values[i] || '']));
    const raw=r.Date;const date=/^\d{4}-\d{2}-\d{2}/.test(raw)?raw.slice(0,10):raw && Number.isFinite(Number(raw))?new Date(Date.UTC(1899,11,30)+Number(raw)*86400000).toISOString().slice(0,10):'';
    return {employee:r.Name,date,hours:r['Hours Worked'],overtime:r['Overtime Hours'],status:r.Status};
  });
}
export function csvRows(raw){
  const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<raw.length;i++){const c=raw[i];if(c==='"'){if(quoted && raw[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===',' && !quoted){row.push(value);value='';}else if(c==='\n' && !quoted){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value='';}else value+=c;}
  if(value || row.length){row.push(value.replace(/\r$/,''));rows.push(row);}
  const headers=(rows.shift() || []).map(x=>x.replace(/^\uFEFF/,''));return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i] || ''])));
}
const num=v=>v==null || v==='' || !Number.isFinite(Number(v))?null:Number(v);
export async function readPayclock(folder){
  try{
    const root=await realpath(folder),files=[];
    for(const name of await readdir(folder)){
      if(!/^hours_(?:(?:office|warehouse)_)?\d{8}_to_\d{8}\.xlsx$/.test(name) && !/^hours_daily_\d{8}_to_\d{8}\.csv$/.test(name))continue;
      const file=path.join(folder,name),meta=await lstat(file);if(meta.isSymbolicLink() || !meta.isFile() || meta.size>10_000_000)continue;
      const rel=path.relative(root,await realpath(file));if(rel.startsWith('..') || path.isAbsolute(rel))continue;files.push({name,file,time:meta.mtimeMs});
    }
    files.sort((a,b)=>a.time-b.time);const unique=new Map(),errors=[];
    for(const file of files){try{
      const b=await readFile(file.file);const rows=file.name.endsWith('.xlsx')?xlsxDaily(b):csvRows(b.toString('utf8')).map(r=>({employee:r.name || r.employee_id,date:r.date,hours:r.hours_worked,overtime:null,status:r.status}));
      for(const r of rows){if(!r.employee || !/^\d{4}-\d{2}-\d{2}$/.test(r.date))continue;unique.set(r.employee.trim().toLowerCase()+'|'+r.date,{...r,hours:num(r.hours),overtime:num(r.overtime),group:file.name.includes('_office_')?'Office':file.name.includes('_warehouse_')?'Warehouse':'Unspecified'});}
    }catch{errors.push(file.name);}}
    const rows=[...unique.values()];return {state:files.length && rows.length?'connected':'unavailable',rows:rows.map(({employee,...r})=>r),files:files.map(f=>f.name),errors,
      employees:new Set(rows.map(r=>r.employee.toLowerCase())).size,latestDay:rows.length?rows.map(r=>r.date).sort().at(-1):null,
      detail:'Saved exports only; overlapping employee/day rows use the newest export. Employee names and punches are excluded.'};
  }catch{return {state:'unavailable',rows:[],files:[],errors:['Export folder unavailable'],employees:0,latestDay:null,detail:'Saved export folder unavailable.'};}
}

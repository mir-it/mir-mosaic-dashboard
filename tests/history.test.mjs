import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {historyPage,orderDetail} from '../history.mjs';
test('PC history includes undated imports, has stable pages and searches all records',()=>{
  const rows=Array.from({length:45},(_,i)=>({sequence:i+1,so:'SO'+i,pc:i===0?'Other':'Remote India',po:'PO'+i,at:null,legacy:true}));
  const first=historyPage(rows,{pc:'remote india'}),second=historyPage(rows,{pc:'Remote India',page:2}),last=historyPage(rows,{pc:'Remote India',page:99});
  assert.equal(first.total,44);assert.equal(first.pages,3);assert.equal(first.rows.length,20);assert.equal(last.rows.length,4);
  assert(!second.rows.some(r=>first.rows.some(a=>a.sequence===r.sequence)));
  assert.equal(historyPage(rows,{pc:'Remote India',query:'po44'}).rows[0].so,'SO44');
  assert.equal(historyPage(rows,{pc:'Absent'}).total,0);
  assert.throws(()=>historyPage(rows,{page:-1}));assert.throws(()=>historyPage(rows,{pageSize:10000}));
});
test('detail preserves full payload and response and never substitutes a different record',async()=>{
  const event={sequence:7,payload:{header:{ship_date:'08/10/2026'},text:'<script>untrusted</script>'},response:{messages:['accepted']}};
  const server=http.createServer((req,res)=>{assert.equal(req.method,'GET');res.end(JSON.stringify({events:[event]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const config={fedfishCentral:{url:'http://127.0.0.1:'+server.address().port}};
    assert.deepEqual(await orderDetail(config,7),event);assert.equal(await orderDetail(config,6),null);
    await assert.rejects(()=>orderDetail(config,-1));
  }finally{await new Promise(r=>server.close(r));}
});

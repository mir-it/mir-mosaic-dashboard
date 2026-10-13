import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createAccess} from '../access.mjs';import {createCorrections} from '../corrections.mjs';
test('individual PINs, server expiry, logout and rate limiting',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mir-access-'));t.after(()=>rm(root,{recursive:true,force:true}));const auth=await createAccess(root),lines=(await readFile(path.join(root,'data/access/initial-pins.txt'),'utf8')).split('\n');assert.equal(new Set(lines.map(l=>l.split(': ')[1])).size,4);
 const req={headers:{},socket:{remoteAddress:'127.0.0.1'}},pin=lines[0].split(': ')[1];const login=auth.login(req,'Bayel',pin);req.headers.cookie=login.cookie.split(';')[0];assert.equal(auth.session(req).name,'Bayel');const now=Date.now;t.after(()=>Date.now=now);Date.now=()=>login.session.expires+1;assert.equal(auth.session(req),null);Date.now=now;
 auth.login(req,'Bayel',pin);auth.logout(req);assert.equal(auth.session(req),null);for(let i=0;i<8;i++)assert.throws(()=>auth.login(req,'Bayel','xxxx'));assert.throws(()=>auth.login(req,'Bayel',pin),e=>e.status===429);
 const stored=await readFile(path.join(root,'data/access/users.json'),'utf8');assert(!stored.includes('"pin"'));
});
test('optional reasons and audited undo preserve earlier revisions',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mir-undo-')),store=await createCorrections(root);
 const base={employee:'1',day:'2026-10-12',revision:0,note:'',punches:[{time:'08:00:00',role:'in',enabled:true},{time:'17:00:00',role:'out',enabled:true}]};
 const first=store.save(base,'Bayel');const second=store.save({...base,revision:first.revision,punches:[{time:'08:00:00',role:'in',enabled:true},{time:'18:00:00',role:'out',enabled:true}]},'Emin');
 const undone=store.undo({employee:base.employee,day:base.day,revision:second.revision},'Fatima');assert.equal(store.get(base.employee,base.day)[0].punches[1].time,'17:00:00');assert.equal(store.get(base.employee,base.day)[0].actor,'Fatima');assert.equal(store.get(base.employee,base.day).length,3);
 store.undo({employee:base.employee,day:base.day,revision:undone.revision,originalClock:true},'Tatyana');assert.equal(store.get(base.employee,base.day)[0].restoreOriginal,1);assert.equal(store.get(base.employee,base.day).length,4);store.close();
});
test('local changes preserve audit, actor identity, persistence and reject stale revisions',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mir-edits-'));const store=await createCorrections(root);const input={employee:'1',day:'2026-10-12',revision:0,note:'Missing lunch return confirmed',punches:[{time:'08:00:00',role:'in',enabled:true},{time:'17:00:00',role:'out',enabled:true}]};
 const first=store.save(input,'Tatyana');assert.equal(store.get('1','2026-10-12')[0].actor,'Tatyana');assert.throws(()=>store.save(input,'Emin'),e=>e.status===409);store.save({...input,revision:first.revision,note:'Added confirmed lunch',punches:[...input.punches,{time:'12:00:00',role:'lunchOut',enabled:true},{time:'13:00:00',role:'lunchIn',enabled:true}]},'Fatima');assert.equal(store.get('1','2026-10-12').length,2);assert.equal(store.version(),2);
});

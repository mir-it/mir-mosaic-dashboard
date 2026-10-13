import test from 'node:test';
import assert from 'node:assert/strict';
import {localParts,dueDate,createPayclockScheduler} from '../payclock-scheduler.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('nightly schedule uses Pacific time, catches up, and waits on installation day',()=>{
  const state={installedDate:'2026-10-12'};
  assert.equal(dueDate(new Date('2026-10-13T05:59:00Z'),state),null);
  assert.equal(dueDate(new Date('2026-10-13T06:00:00Z'),state),'2026-10-12');
  assert.equal(dueDate(new Date('2026-10-14T18:00:00Z'),state),'2026-10-13');
  assert.equal(dueDate(new Date('2026-10-13T18:00:00Z'),{...state,completedDate:'2026-10-12'}),null);
  assert.equal(localParts(new Date('2026-11-03T07:00:00Z')).hour,23);
});
test('scheduled read requests whole days, preserves view, and persists completion',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mir-schedule-'));t.after(()=>rm(root,{recursive:true,force:true}));const calls=[];
  const service={start:async input=>{calls.push(input);return {id:'test'};},get:()=>({state:'ready',report:{daily:[{values:['','','2026-10-12'],punches:['08:00','16:00']}]}})};
  const scheduler=createPayclockScheduler(service,root);
  await scheduler.tick(new Date('2026-10-12T18:00:00Z'));
  await scheduler.tick(new Date('2026-10-13T06:00:00Z'));
  assert.deepEqual(calls,[{start:'2026-10-11',end:'2026-10-12',saveView:false}]);
  const reopened=createPayclockScheduler(service,root);await reopened.tick(new Date('2026-10-13T18:00:00Z'));assert.equal(calls.length,1);
  assert.equal((await reopened.status()).statistics.punches,2);
});

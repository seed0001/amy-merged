import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCalendar} from './calendar.js';
import {runScheduledActivity} from './scheduled-activity.js';
import {chat} from './llm.js';

test('scheduled activity executes a local tool workflow with owner and source context',async()=>{
  const calls=[];let steps=0;
  const event={id:5,owner:'owner',title:'Research and change scene',instructions:'Research a topic then change the background.',timezone:'America/Chicago',next_at:123};
  const tools={enabledTools:(ctx)=>{assert.equal(ctx.client,'client');return ['web_search','avatar_background'].map(name=>({type:'function',function:{name,parameters:{type:'object',properties:{}}}}));},
    runTool:async(name,args,ctx)=>{calls.push(name);assert.equal(ctx.speaker.id,'owner');assert.equal(ctx.perms.owner,true);assert.equal(ctx.userText,event.instructions);return `[${name}: ok] done`;}};
  const result=await runScheduledActivity(event,{client:'client',guild:'source-server'},{isOwner:id=>id==='owner',permissions:()=>({owner:true}),tools,
    llm:{chat,agentStep:async()=>++steps<=2?{content:'',tool_calls:[{id:String(steps),function:{name:steps===1?'web_search':'avatar_background',arguments:'{}'}}]}:{content:'Research completed and background changed.'}}});
  assert.deepEqual(calls,['web_search','avatar_background']);assert.match(result,/Tool results/);assert.match(result,/background changed/);
  await assert.rejects(runScheduledActivity({...event,owner:'revoked'},{},{isOwner:()=>false}),/no longer authorized/);
});
test('activity delivery retries do not repeat actions, including partial failures',async()=>{
  const db=new DatabaseSync(':memory:');let now=Date.parse('2026-11-02T12:00:00Z');
  const calendar=createCalendar(db,()=>now);
  const e=calendar.save({kind:'activity',title:'Change scene',instructions:'Change background',repeat:'once',at:'2026-11-02T12:01:00Z'},'owner');
  now=e.next_at;let runs=0,deliveries=0;
  const generate=async()=>{runs++;throw new Error('Stopped after first action');};
  await calendar.tick({generate,deliver:async()=>{throw new Error('DM unavailable');}});
  now+=5*60000;
  await calendar.tick({generate,deliver:async(event,text)=>{deliveries++;assert.match(text,/partially completed/);}});
  assert.equal(runs,1);assert.equal(deliveries,1);assert.equal(calendar.list('owner')[0].enabled,false);db.close();
});
test('interrupted activity receipt prevents repeating side effects after lease expires',async()=>{
  const db=new DatabaseSync(':memory:');let now=Date.parse('2026-11-02T12:00:00Z');const calendar=createCalendar(db,()=>now);
  const e=calendar.save({kind:'activity',title:'Task',instructions:'Do task',repeat:'once',at:'2026-11-02T12:01:00Z'},'owner');now=e.next_at;
  db.prepare('UPDATE calendar_events SET content = ?, lease_until = ? WHERE id = ?').run('Execution began; inspect tool logs.',now+60000,e.id);
  now+=60001;let ran=false;
  await calendar.tick({generate:async()=>{ran=true;return 'bad';},deliver:async(_,text)=>assert.match(text,/inspect tool logs/)});
  assert.equal(ran,false);db.close();
});

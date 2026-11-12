import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationBudget, replyReason, humanControl, budgetPrompt } from './conversation-budget.js';
const topics=['How does SQLite recover committed journals?','Which codec preserves speech quality?','Why does the scheduler miss deadlines?','How should the parser resolve pronouns?','Which memory record supplies this source?','What makes the rendering pipeline stall?','Where can the calendar find timezone rules?'];
const amy={id:'amy',name:'Amy'},alex={id:'alex',name:'Alex'},nova={id:'nova',name:'Nova'};
function setup(){
  const file=path.join(mkdtempSync(path.join(tmpdir(),'conversation-budget-')),'shared.db');
  const left=new DatabaseSync(file),right=new DatabaseSync(file);
  let now=1000000;
  const a=createConversationBudget(left,{now:()=>now}),b=createConversationBudget(right,{now:()=>now});
  for(const me of [amy,alex,nova])a.register(me);
  return {a,b,left,right,file,advance:(ms=11000)=>now+=ms,close:()=>{left.close();right.close();}};
}
test('name acknowledgments, agreement and goodbye never earn a reply',()=>{
  for(const text of ['Thanks, Amy.','Agreed, Alex.','Goodbye, Nova.','Amy, go ahead.','Got it, Alex.'])assert.equal(replyReason(text,[],['Amy','Alex','Nova']),null,text);
  assert.equal(replyReason('Amy, which test should we run?',[],['Amy']),'question');
  assert.equal(replyReason('The measured result shows the cache halves latency.'),'new-point');
  assert.equal(replyReason('I still need to test the database recovery.'),'unfinished-task');
});
test('both bots observe one exchange and one event; only one owns a response',()=>{
  const s=setup();try{
    const event=s.a.observe('text:1',{eventId:'m1',speaker:nova,peer:true,text:'Amy and Alex, which test should we run?'});
    const duplicate=s.b.observe('text:1',{eventId:'m1',speaker:nova,peer:true,text:event.text});
    assert.equal(event.exchangeId,duplicate.exchangeId);
    assert.equal(s.a.snapshot('text:1').turns,1);
    const first=s.b.claim('text:1',duplicate,alex);
    const other=s.a.claim('text:1',event,amy);
    assert.ok(first);assert.equal(other,null);
    assert.equal(s.a.snapshot('text:1').pending.owner,'alex');
    assert.equal(s.a.snapshot('text:1').mentions.amy,1);
    assert.equal(s.a.snapshot('text:1').mentions.alex,1);
  }finally{s.close();}
});
test('an acknowledgment with a name cannot restart a completed thought',()=>{
  const s=setup();try{
    const event=s.a.observe('voice:1',{speaker:alex,peer:true,text:'Thanks, Amy.'});
    assert.equal(s.a.claim('voice:1',event,amy),null);
    assert.equal(s.b.snapshot('voice:1').turns,1);
  }finally{s.close();}
});
test('six turns favor quiet closure but useful work can continue',()=>{
  const s=setup();try{
    let event;
    for(let i=0;i<6;i++){event=s.a.observe('voice:2',{eventId:'e'+i,speaker:alex,peer:true,text:`Amy, ${topics[i]}`});s.advance();}
    const lease=s.b.claim('voice:2',event,amy);
    assert.ok(lease);assert.equal(lease.softClosing,true);
    assert.match(budgetPrompt(lease),/finish the useful thought quietly/i);
    assert.doesNotMatch(budgetPrompt(lease),/said your name|six bot/);
    const out=s.a.complete('voice:2',lease,amy,'The result shows the recovery path preserves every committed record.');
    assert.equal(out.noReply,true);
    assert.equal(s.b.claim('voice:2',out,alex,{allowUnaddressed:true,candidates:['alex']}),null);
  }finally{s.close();}
});
test('keep talking extends the discussion but repetition still stops a turn',()=>{
  const s=setup();try{
    const human=s.a.observe('voice:3',{speaker:{id:'owner',name:'Owner'},peer:false,owner:true,text:'Keep talking.'});
    assert.equal(human.control,'extend');
    let event;
    for(let i=0;i<7;i++){event=s.a.observe('voice:3',{eventId:'r'+i,speaker:alex,peer:true,text:`Amy, ${topics[i]}`});s.advance();}
    const lease=s.b.claim('voice:3',event,amy);assert.ok(lease);assert.equal(lease.extended,true);assert.equal(lease.softClosing,false);
    s.b.release('voice:3',lease);s.advance();
    event=s.a.observe('voice:3',{eventId:'repeat',speaker:alex,peer:true,text:`Amy, ${topics[6]}`});
    assert.equal(event.reason,null);assert.equal(s.b.claim('voice:3',event,amy),null);
  }finally{s.close();}
});
test('wrap closes and stop invalidates pending speech across both processes',()=>{
  const s=setup();try{
    let event=s.a.observe('text:2',{speaker:alex,peer:true,text:'Amy, which test should we run?'});
    const lease=s.a.claim('text:2',event,amy);assert.ok(lease);
    s.b.observe('text:2',{speaker:{id:'owner'},peer:false,text:'Stop.'});
    assert.equal(s.a.valid('text:2',lease),false);
    assert.equal(s.a.complete('text:2',lease,amy,'A late reply.'),false);
    assert.equal(s.a.snapshot('text:2').mode,'stopped');
    s.advance();s.b.observe('text:2',{speaker:{id:'owner'},peer:false,text:'What is the next useful step?'});
    assert.equal(s.a.snapshot('text:2').mode,'open');
    s.advance();s.b.observe('text:2',{speaker:{id:'owner'},peer:false,text:'Wrap it up.'});
    assert.equal(s.a.snapshot('text:2').mode,'closed');
  }finally{s.close();}
});
test('human contributions reset the shared budget; idle bot chatter does not',()=>{
  const s=setup();try{
    s.a.observe('voice:4',{speaker:alex,peer:true,text:'Amy, why does recovery need a journal?'});
    s.advance(300000);
    s.b.observe('voice:4',{speaker:nova,peer:true,text:'Alex, which durable writes need a journal?'});
    assert.equal(s.a.snapshot('voice:4').turns,2);
    s.a.observe('voice:4',{speaker:{id:'human'},peer:false,text:'Compare the failure cases.'});
    const shared=s.b.snapshot('voice:4');assert.equal(shared.turns,0);assert.equal(shared.lastHuman.id,'human');
  }finally{s.close();}
});
test('quoted or negated room controls do not stop discussion',()=>{
  for(const text of ['She told him to stop talking.','Do not stop.','"Wrap it up", he said.','If I say stop, will you stop?'])assert.equal(humanControl(text,true),null,text);
  assert.equal(humanControl('Wrap it up.'),'wrap');
  assert.equal(humanControl('Keep talking.',true),'extend');
});
test('a fresh human stop cancels an older pending human reply even after resuming',()=>{
  const s=setup();try{
    const first=s.a.observe('text:3',{speaker:{id:'owner'},peer:false,text:'Explain the journal.'});
    assert.equal(s.a.canReply('text:3',first),true);
    s.b.observe('text:3',{speaker:{id:'owner'},peer:false,text:'Stop.'});
    s.advance();s.b.observe('text:3',{speaker:{id:'owner'},peer:false,text:'Now discuss something else.'});
    assert.equal(s.a.canReply('text:3',first),false);
  }finally{s.close();}
});

test('separate OS processes cannot both claim the same speaking turn',async()=>{
  const s=setup();try{
    const event=s.a.observe('text:race',{eventId:'race',speaker:nova,peer:true,text:'Amy and Alex, which test should we run?'});
    const url=new URL('./conversation-budget.js',import.meta.url).href;
    const code=`import {DatabaseSync} from 'node:sqlite';import {createConversationBudget} from ${JSON.stringify(url)};const db=new DatabaseSync(process.argv[1]);const b=createConversationBudget(db,{now:()=>1000000});const me=JSON.parse(process.argv[2]);const token=b.claim('text:race',JSON.parse(process.argv[3]),me);process.stdout.write(JSON.stringify(Boolean(token)));db.close();`;
    const run=promisify(execFile);
    const results=await Promise.all([amy,alex].map((me)=>run(process.execPath,['--input-type=module','-e',code,s.file,JSON.stringify(me),JSON.stringify(event)])));
    assert.equal(results.filter((r)=>r.stdout==='true').length,1);
  }finally{s.close();}
});
test('a split outgoing reply remains one turn and carries the no-reply marker',()=>{
  const s=setup();try{
    const incoming=s.a.observe('text:chunks',{eventId:'ask',speaker:alex,peer:true,text:'Amy, what is the tested result?'});
    const token=s.a.claim('text:chunks',incoming,amy);assert.ok(token);
    const whole=s.a.complete('text:chunks',token,amy,'The measured result shows the journal preserves committed records. The second measured result shows recovery is durable.');
    const count=s.a.snapshot('text:chunks').turns;
    const piece=s.b.observe('text:chunks',{eventId:'piece',speaker:amy,peer:true,text:'The second measured result shows recovery is durable.'});
    assert.equal(piece.eventId,whole.eventId);
    assert.equal(s.a.snapshot('text:chunks').turns,count);
  }finally{s.close();}
});

test('keep talking preserves a useful in-flight reply instead of cancelling it',()=>{
  const s=setup();try{
    const question=s.a.observe('voice:continue',{speaker:alex,peer:true,text:'Amy, which recovery scenario should we test?'});
    const token=s.a.claim('voice:continue',question,amy);assert.ok(token);
    s.b.observe('voice:continue',{speaker:{id:'owner'},peer:false,owner:true,text:'Keep talking.'});
    assert.equal(s.a.valid('voice:continue',token),true);
    assert.ok(s.a.complete('voice:continue',token,amy,'The measured result shows recovery preserves committed writes.'));
  }finally{s.close();}
});
test('keep talking after quiet gives only one companion the next turn',()=>{
  const s=setup();try{
    const event=s.a.observe('voice:restart',{speaker:{id:'owner'},peer:false,owner:true,text:'Keep talking.'});
    const first=s.a.claim('voice:restart',event,alex,{allowUnaddressed:true,candidates:['alex','amy']});
    const second=s.b.claim('voice:restart',event,amy,{allowUnaddressed:true,candidates:['alex','amy']});
    assert.ok(first);assert.equal(second,null);
  }finally{s.close();}
});

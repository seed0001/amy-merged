import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReflections, reflections } from './reflections.js';
import { createGoalWorker } from './goal-work.js';
import { createProjects } from './projects.js';
import { selectResearch } from './research-policy.js';
import * as pressure from './pressure.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(),'champ-goals-'));
  const file = path.join(dir,'reflections.json');
  let now = Date.now();
  return { dir, file, store: createReflections(file,() => now), advance: (ms) => { now += ms; } };
}

test('goal content, route and criteria are runtime choices; pivot retains experiences', () => {
  const {store,file} = setup();
  const first = store.add('goal','Write a quiet story about a lighthouse',{activity:'writing',criteria:'A complete private first draft',reason:'I want to explore this image'});
  store.recordWork(first.id,{eventId:'draft-1',status:'written',evidence:{file:'draft.md',memoryIds:[12]},summary:'First scene completed'});
  const next = store.pivot(first.id,'Research how lighthouse lenses work',{activity:'research',reason:'The optical details interest me more'});
  assert.equal(store.list().find((g) => g.id===first.id).replacementGoal,next.id);
  assert.equal(store.list().find((g) => g.id===first.id).dropped>0,true);
  const reopened=createReflections(file);
  assert.equal(reopened.experiences()[0].memoryIds[0],12);
  assert.equal(reopened.select().goal.id,next.id);
  assert.equal(reopened.list().length,2);
});

test('reviews of actual outcomes change later choices without preset interests', () => {
  const {store,advance}=setup();
  const research=store.add('goal','Study unusual natural patterns',{activity:'research',bucket:'curiosity',fit:0.5});
  const writing=store.add('goal','Write about unusual natural patterns',{activity:'writing',bucket:'restlessness',fit:0.5});
  store.recordWork(research.id,{eventId:'r',status:'done',evidence:{sources:['https://example.test']},summary:'A researched result'});
  store.recordWork(writing.id,{eventId:'w',status:'written',evidence:{file:'story.md'},summary:'A draft'});
  advance(46*60000);
  store.review('r',-0.8,'This avenue felt repetitive.');
  store.review('w',0.9,'The draft was satisfying to make.');
  assert.equal(store.select({buckets:{curiosity:0.8,restlessness:0.5}}).goal.id,writing.id);
  store.review('r',1,'A new connection changed my view.');
  store.review('w',-0.5,'I no longer enjoy this writing direction.');
  assert.equal(store.select({buckets:{curiosity:0.8,restlessness:0.5}}).goal.id,research.id);
  assert.throws(() => store.review('imagined',1,'Invented result'));
});

test('completion needs recorded successful work and grants one evidence-linked reward', () => {
  const {store}=setup();
  const goal=store.add('goal','Make a short private essay',{activity:'writing'});
  assert.throws(() => store.finish(goal.id),/recorded successful/);
  store.recordWork(goal.id,{eventId:'failed',status:'failed',evidence:{message:'provider offline'},summary:'No draft'});
  assert.throws(() => store.finish(goal.id));
  store.recordWork(goal.id,{eventId:'written',status:'written',evidence:{file:'essay.md'},summary:'Draft saved'});
  const done=store.finish(goal.id);
  assert.equal(done.completionExperience.outcome,'completed');
  assert.equal(done.completionExperience.evidence,'written');
  assert.equal(store.finish(goal.id),null);
  assert.equal(store.experiences().filter((e) => e.outcome==='completed').length,1);
});

test('self-directed adoption is grounded and does not require a hard-coded goal', () => {
  const {store}=setup();
  const context='A remembered conversation about a quiet coastline made me curious.';
  assert.throws(() => store.decide({action:'adopt',text:'Invented',reason:'because',evidence:'not in context'},{thoughtId:1,context}));
  const goal=store.decide({action:'adopt',text:'Write a coastline sketch',activity:'writing',reason:'I want to explore that atmosphere',evidence:'quiet coastline'},{thoughtId:1,context});
  store.decide({action:'drop',id:goal.id,reason:'This no longer fits the setup'},{thoughtId:2,context});
  assert.equal(store.select(),null);
  assert.match(store.promptBlock(),/no longer fits/);
});

test('idle writing uses saved memories and creates a private artifact, not an external action', async () => {
  const {store,dir}=setup();
  const goal=store.add('goal','Write a sea poem',{activity:'writing',criteria:'A short private draft'});
  let request;
  const work=createGoalWorker({store,root:path.join(dir,'work'),recall:() => [{id:8,content:'I enjoyed the coast.'}],generate:async(messages) => { request=messages; return 'The sea folds light into the shore.'; }});
  const result=await work(goal.id);
  assert.match(readFileSync(result.file,'utf8'),/The sea folds/);
  assert.match(request[1].content,/enjoyed the coast/);
  assert.equal(result.verifiedPublic,false);
  assert.equal(store.experiences()[0].memoryIds[0],8);
  assert.equal(store.experiences()[0].outcome,'written');
});

test('pause or drop while a worker is generating prevents late artifacts and rewards', async () => {
  const {store,dir}=setup();
  const goal=store.add('goal','Write a private draft',{activity:'writing'});
  const work=createGoalWorker({store,root:dir,recall:() => [],generate:async() => {store.drop(goal.id,'Changed direction');return 'A late draft';}});
  const result=await work(goal.id);
  assert.equal(result.decision.status,'skipped');
  assert.equal(store.experiences().length,0);
});

test('project goals produce private plans and keep the existing project confirmation boundary', async () => {
  const {store,dir}=setup();
  const goal=store.add('goal','Build a small map viewer',{activity:'project',criteria:'A runnable map viewer'});
  const work=createGoalWorker({store,root:dir,recall:() => [],generate:async() => 'Plan: define the map and its data source.'});
  await work(goal.id);
  assert.equal(store.experiences()[0].outcome,'planned');
  assert.throws(() => store.finish(goal.id));
  const db=new DatabaseSync(':memory:');
  try {
    const projects=createProjects(db);
    const ctx={perms:{owner:true},speaker:{id:'owner'},conversation:'chat',turn:'1',userText:'Make a map'};
    const proposal=projects.propose({title:'Map',brief:'A small runnable map viewer',goal_id:goal.id},ctx);
    assert.equal(proposal.goal_id,goal.id);
    let starts=0;
    assert.throws(() => projects.start(proposal.id,{...ctx,userText:'yes'},() => {starts++;return {id:1};}));
    assert.equal(starts,0);
    projects.start(proposal.id,{...ctx,turn:'2',userText:'Yes, do it.'},() => {starts++;return {id:1};});
    assert.equal(starts,1);
  } finally {db.close();}
});

test('research selection excludes writing, paused and dropped goals', () => {
  const now=Date.now();
  const goals=[{id:1,kind:'goal',text:'Write a story about ocean waves',activity:'writing',at:now},
    {id:2,kind:'goal',text:'Research how ocean waves form',activity:'research',dropped:now,at:now},
    {id:3,kind:'goal',text:'Research the tides and lunar forces',activity:'research',at:now}];
  assert.equal(selectResearch({goals,now}).selected.goalId,3);
});

test('actual completion feeds pressure once; unsupported or repeated rewards do not', () => {
  const store=reflections();
  const goal=store.add('goal','Write a private test draft',{activity:'writing',bucket:'restlessness'});
  store.recordWork(goal.id,{eventId:'pressure-draft',status:'written',evidence:{file:'draft.md'},summary:'Saved draft'});
  const completed=store.finish(goal.id).completionExperience;
  const previous=pressure.cfg.enabled;pressure.cfg.enabled=true;
  try {
    pressure.state.buckets.restlessness=0.8;
    assert.equal(pressure.onGoalExperience(completed),true);
    assert.ok(pressure.state.buckets.restlessness<0.8);
    const value=pressure.state.buckets.restlessness;
    assert.equal(pressure.onGoalExperience(completed),false);
    assert.equal(pressure.onGoalExperience({...completed,id:'invented'}),false);
    assert.equal(pressure.state.buckets.restlessness,value);
  } finally {pressure.cfg.enabled=previous;}
});

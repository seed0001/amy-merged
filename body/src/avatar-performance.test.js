import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createPerformance,availablePerformance} from './avatar-performance.js';
import {FACE_PRESETS,applyFacePerformance,activeAnimation} from './dashboard/public/avatar-performance.js';
const shapes=[...new Set(Object.values(FACE_PRESETS).flatMap(pose=>Object.keys(pose)))];
test('expressions expire, explicit holds take priority over background thinking, and settings persist',()=>{
  let time=1000;const file=path.join(mkdtempSync(path.join(os.tmpdir(),'champ-performance-')),'state.json');const events=[];
  const available=()=>({shapes,bones:['RightArm','RightForeArm','RightHand']});
  const control=createPerformance({file,now:()=>time,available,emit:event=>events.push(event)});
  control.command({action:'pose',expression:'smile',duration:0,strength:.8});
  assert.equal(control.command({action:'pose',expression:'blink'},'background').skipped,true);
  time+=10000;assert.equal(control.state().face.name,'smile');
  control.command({action:'reset'});control.command({action:'pose',expression:'blink'},'background');
  assert.equal(control.state().face.source,'background');time+=1000;assert.equal(control.state().face,null);
  control.command({action:'settings',gain:2.5,autonomous:'off',gaze:'camera'});
  assert.equal(control.command({action:'gesture',gesture:'wave'},'background').skipped,true);
  const resumed=createPerformance({file,available,emit:()=>{}}).state();assert.equal(resumed.gain,2.5);assert.equal(resumed.gaze,'camera');assert.equal(resumed.autonomous,false);
  // Shapes this avatar doesn't have are dropped; with none left and no expression named, nothing moves.
  assert.throws(()=>control.command({action:'pose',shapes:[{name:'nonexistent',value:.5}]}),/Choose a listed expression or provide named morph shapes/);
  assert.throws(()=>control.command({action:'settings',gain:10}),/gain must/);
  assert.ok(events.length>=4);
});
test('mouth-close overrides audio, facial gain is capped, and poses release without sticking',()=>{
  const state={gain:3,face:{name:'mouth_closed',shapes:{jawOpen:0,mouthClose:1},at:1000,duration:3,strength:1},motion:{name:'yawn',at:1000,duration:4,strength:1}};
  const weights=new Map([['jawOpen',.7],['viseme_aa',.8],['mouthSmileLeft',.9],['eyeWideLeft',.7]]);
  applyFacePerformance(weights,state,2000);assert.equal(weights.get('jawOpen'),0);assert.equal(weights.get('viseme_aa'),0);assert.equal(weights.get('mouthClose'),1);assert.equal(weights.get('eyeWideLeft'),1);
  const released=new Map([['jawOpen',.6],['viseme_aa',.8]]);applyFacePerformance(released,{...state,motion:null},5000);
  assert.equal(released.get('jawOpen'),.6);assert.equal(released.get('viseme_aa'),.8);
  assert.equal(activeAnimation(state.face,5000),null);
  const blink={gain:1,face:{name:'blink',shapes:{eyeBlinkLeft:1,eyeBlinkRight:1},at:0,duration:.4,strength:1}};
  const lids=new Map();applyFacePerformance(lids,blink,200);assert.equal(lids.get('eyeBlinkLeft'),1);
});
test('arm gestures require a rig and reject infinite or invalid movements',()=>{
  let time=1000;const file=path.join(mkdtempSync(path.join(os.tmpdir(),'champ-motion-')),'state.json');
  const control=createPerformance({file,now:()=>time,available:()=>({shapes,bones:['RightArm']}),emit:()=>{}});
  control.command({action:'gesture',gesture:'wave',duration:3});assert.equal(control.state().motion.name,'wave');
  time+=3100;assert.equal(control.state().motion,null);
  assert.throws(()=>control.command({action:'gesture',gesture:'wave',duration:0}),/positive duration/);
  const unrigged=createPerformance({file,available:()=>({shapes:[],bones:[]}),emit:()=>{}});
  assert.throws(()=>unrigged.command({action:'gesture',gesture:'wave'}),/arm rig/);
  assert.throws(()=>unrigged.command({action:'gesture',gesture:'yawn'}),/jaw shape/);
  assert.deepEqual(Object.keys(availablePerformance()).sort(),['bones','shapes']);
});

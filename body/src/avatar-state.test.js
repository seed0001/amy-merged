import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAvatarState} from './avatar-state.js';
import {pcmEnvelope,prepareDiscordSpeech,startDiscordSpeech,stopDiscordSpeech,activeDiscordSpeech} from './discord-avatar.js';
import {appearancePart,motionMask} from './dashboard/public/avatar-appearance.js';

test('cosmetic data survives a new session and stays separate from pictures',()=>{
  const file=path.join(mkdtempSync(path.join(os.tmpdir(),'avatar-')),'appearance.json');const events=[];
  const state=createAvatarState(file,e=>events.push(e));
  state.set('main',{hair:'purple',eyes:'green',lipstick:'rose',makeupIntensity:.4});
  const resumed=createAvatarState(file,()=>{});
  assert.equal(resumed.get().hair,'#8053ad');assert.equal(resumed.get().eyes,'#408b57');
  assert.equal(events.length,1);assert.match(resumed.prompt(),/#8053ad/);
  assert.doesNotMatch(resumed.prompt(),/data:image|<img|base64/);
  assert.throws(()=>state.set('main',{hair:'imaginary'}));
  assert.equal(resumed.get().hair,'#8053ad');
  state.set('main',{},true);assert.equal(resumed.get().hair,null);
});
test('unmeasured defaults are not invented appearance facts',()=>{
  const state=createAvatarState(path.join(os.tmpdir(),'nonexistent-avatar-'+Date.now()),()=>{});
  assert.equal(state.get().eyes,null);assert.match(state.prompt(),/not been measured/);
});

test('known original traits reach prompts, overrides win and other models do not inherit them',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'avatar-description-'));
  const model=path.join(dir,'original.glb'),other=path.join(dir,'other.glb');
  writeFileSync(model,'original model');writeFileSync(other,'different model');
  const file=path.join(dir,'state.json');
  const state=createAvatarState(file,()=>{});
  state.describeModel(model,{hair:'brown',eyes:'green/hazel',lipstick:'reddish-brown lips',eyeshadow:'warm brown/gold',blush:'subtle rosy cheeks'});
  const prompt=createAvatarState(file,()=>{}).prompt('main',model);
  assert.match(prompt,/hair: brown/);assert.match(prompt,/eyes: green\/hazel/);
  assert.match(prompt,/lipstick: reddish-brown/);assert.match(prompt,/eyeshadow: warm brown\/gold/);
  state.set('main',{hair:'purple'});
  assert.match(state.prompt('main',model),/hair: purple \(saved cosmetic override\)/);
  state.set('main',{},true);
  assert.match(state.prompt('main',model),/hair: brown/);
  assert.doesNotMatch(state.prompt('main',other),/eyes: green\/hazel|hair: brown/);
});
test('mouth motion follows PCM energy and silence, with no audio in browser packet',()=>{
  const silence=Buffer.alloc(7680);const tone=Buffer.alloc(7680);
  for(let i=0;i<tone.length;i+=4){const n=Math.round(Math.sin(i/4*.12)*12000);tone.writeInt16LE(n,i);tone.writeInt16LE(n,i+2);}
  const result=pcmEnvelope(Buffer.concat([tone,silence]));assert.equal(result.frames.length,2);
  assert.ok(result.frames[0].open>0);assert.equal(result.frames[1].open,0);
  const packet=startDiscordSpeech({type:'start',id:'first',character:'main',conversation:'test',...result});
  assert.equal(activeDiscordSpeech()[0].id,'first');assert.equal(packet.audio,undefined);assert.equal(packet.clip,undefined);
  stopDiscordSpeech('test','old');assert.equal(activeDiscordSpeech().length,1);
  stopDiscordSpeech('test','first');assert.equal(activeDiscordSpeech().length,0);
});
test('material classification leaves lashes and teeth unchanged and missing morphs have zero makeup',()=>{
  assert.equal(appearancePart('avaturn_hair_0'),'hair');assert.equal(appearancePart('Eye_Mesh'),'eyes');assert.equal(appearancePart('Eyelash_Mesh'),null);
  assert.deepEqual([...motionMask({geometry:{attributes:{position:{count:2}}},morphTargetDictionary:{}},['mouthPucker'])],[0,0]);
});
test('invalid speech fails instead of emitting fake lip movement',async()=>{
  await assert.rejects(prepareDiscordSpeech(Buffer.from('not an ogg'),'hello','test'));
});

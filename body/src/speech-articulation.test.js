import test from 'node:test';
import assert from 'node:assert/strict';
import {speechPhones} from './speech-phonemes.js';
import {compileArticulation,sampleArticulation,smoothSpeech} from './dashboard/public/speech-articulation.js';
import {applyFacePerformance} from './dashboard/public/avatar-performance.js';
test('pronunciation distinguishes lip-bite, tongue, and lip closure sounds, rather than letter names',async()=>{
  const phones=await speechPhones('Five blue things.');const visemes=phones.map(phone=>phone.viseme);
  assert.ok(visemes.includes('FF'));assert.ok(visemes.includes('PP'));assert.ok(visemes.includes('TH'));assert.ok(visemes.includes('U'));
  const see=await speechPhones('see');assert.equal(see[0].viseme,'SS');assert.ok(see.some(phone=>phone.viseme==='I'));
  assert.equal(await speechPhones('see'),see);
});
test('audio-guided cues exclude leading/trailing silence and a silent clip stays still',async()=>{
  const rate=16000,samples=new Float32Array(rate*2);
  for(let i=rate*.25;i<rate*1.7;i++)samples[i]=.16*Math.sin(2*Math.PI*220*i/rate)*(1+.4*Math.sin(i/rate*23));
  const track=compileArticulation(samples,rate,await speechPhones('Blue balloons feel beautiful.'));
  assert.equal(track.version,2);assert.ok(track.cues.length>10);assert.ok(track.cues[0].start>=240);assert.ok(track.cues.at(-1).end<=1720);
  assert.deepEqual(sampleArticulation(track,80).mouth,{});assert.deepEqual(sampleArticulation(track,1950).mouth,{});
  for(let time=0;time<2100;time+=10){const sample=sampleArticulation(track,time);for(const value of Object.values(sample.mouth))assert.ok(Number.isFinite(value)&&value>=0&&value<=1);}
  const silent=compileArticulation(new Float32Array(rate),rate,await speechPhones('Hello'));assert.deepEqual(silent.cues,[]);assert.deepEqual(sampleArticulation(silent,500).mouth,{});
});
test('coarticulation blends vowel boundaries while preserving bilabial closure',()=>{
  const frames=Array.from({length:50},()=>({open:.8,bright:.2}));
  const track={durationMs:1000,frameMs:20,frames,cues:[{start:0,end:300,viseme:'aa'},{start:300,end:600,viseme:'U'},{start:600,end:800,viseme:'PP'}]};
  const before=sampleArticulation(track,295),after=sampleArticulation(track,305);
  assert.ok(before.mouth.viseme_aa>0&&before.mouth.viseme_U>0);assert.ok(Math.abs(before.mouth.viseme_U-after.mouth.viseme_U)<.2);
  const closed=sampleArticulation(track,700);assert.equal(closed.mouth.jawOpen,0);assert.ok(closed.mouth.viseme_PP>.8);assert.equal(closed.closure,1);
});
test('speech springs behave consistently at different render frame rates',()=>{
  const run=rate=>{let value=0,velocity=0;for(let i=0;i<rate/4;i++)[value,velocity]=smoothSpeech(value,.8,velocity,1/rate);return value;};
  assert.ok(Math.abs(run(60)-run(120))<.001);assert.ok(run(60)>.79);
});
test('smile poses yield at speech closures, while explicit mouth commands still win',()=>{
  const state={gain:1,face:{name:'smile',shapes:{mouthSmileLeft:1,cheekSquintLeft:.5},at:0,duration:5,strength:1}};
  const weights=new Map();applyFacePerformance(weights,state,1000,{active:true,closure:1});assert.ok(weights.get('mouthSmileLeft')<.4);assert.equal(weights.get('cheekSquintLeft'),.5);
  applyFacePerformance(weights,{...state,face:{...state.face,name:'mouth_closed',shapes:{jawOpen:0,mouthClose:1}}},1000,{active:true,closure:0});assert.equal(weights.get('jawOpen'),0);assert.equal(weights.get('mouthClose'),1);
});

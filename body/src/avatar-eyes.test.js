import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {eyeRegionMask} from './dashboard/public/avatar-eye-mask.js';
import {createAvatarState} from './avatar-state.js';

test('iris recoloring excludes pupil and outer eye, including shaded eye whites',()=>{
  const width=100,height=100,pixels=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const distance=Math.hypot(x-50,y-50),i=(y*width+x)*4;
    const color=distance<7?[4,4,4]:distance<20?[60,95,70]:[190,155,150];
    pixels.set([...color,255],i);
  }
  const mask=eyeRegionMask(pixels,width,height);
  assert.ok(mask);
  const at=(x,y)=>[...mask.slice((y*width+x)*4,(y*width+x)*4+2)];
  assert.deepEqual(at(50,50),[0,0]); // pupil is affected by neither color
  assert.deepEqual(at(62,50),[255,0]); // iris belongs only to the inner control
  assert.deepEqual(at(80,50),[0,255]); // shaded whites belong only to the outer control
  assert.deepEqual(at(2,2),[0,255]);
  const unknown=new Uint8Array(width*height*4).fill(255);
  assert.equal(eyeRegionMask(unknown,width,height),null);
});
test('inner and outer colors persist and reset independently, including legacy eye settings',()=>{
  const file=path.join(mkdtempSync(path.join(os.tmpdir(),'champ-eyes-')),'appearance.json');
  const state=createAvatarState(file,()=>{});
  state.set('main',{eyes:'blue'});
  assert.equal(state.get().outerEye,null);
  state.set('main',{outerEye:'white'});
  const resumed=createAvatarState(file,()=>{});
  assert.equal(resumed.get().eyes,'#3278cc');assert.equal(resumed.get().outerEye,'#eeeeee');
  resumed.set('main',{outerEye:'none'});
  assert.equal(resumed.get().eyes,'#3278cc');assert.equal(resumed.get().outerEye,null);
  resumed.set('main',{outerEye:'pink'});resumed.set('main',{eyes:null});
  assert.equal(resumed.get().eyes,null);assert.equal(resumed.get().outerEye,'#dc709d');
  assert.match(resumed.prompt(),/outerEye means the surrounding sclera/);
  resumed.set('main',{},true);assert.equal(resumed.get().outerEye,null);
});

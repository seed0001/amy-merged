import test from 'node:test';
import assert from 'node:assert/strict';
import {avatarState} from './avatar-state.js';
import {enabledTools,runTool} from './tools.js';
import {eyeRegionMask} from './dashboard/public/avatar-eye-mask.js';
test('five iris palette colors persist independently and can reset one layer',async()=>{
  const ctx={perms:{owner:true},speaker:{id:'dashboard'},userText:'Customize the five iris layers',character:{id:'main',main:true}};
  const schema=enabledTools(ctx).find(tool=>tool.function.name==='avatar_appearance').function.parameters.properties;
  for(const key of ['inner_eye','iris_inner_ring','iris_outer_ring','iris_starburst','iris_flecks'])assert.ok(schema[key]);
  const result=await runTool('avatar_appearance',{action:'set',inner_eye:'blue',iris_inner_ring:'gold',iris_outer_ring:'black',iris_starburst:'silver',iris_flecks:'green',outer_eye:'white'},ctx);
  assert.doesNotMatch(result,/\[avatar_appearance: error/);
  let state=avatarState.get();assert.equal(state.eyes,'#3278cc');assert.equal(state.irisInner,'#cda54e');assert.equal(state.irisOuter,'#111111');assert.equal(state.irisStarburst,'#bfc4ce');assert.equal(state.irisFlecks,'#408b57');assert.equal(state.outerEye,'#eeeeee');
  await runTool('avatar_appearance',{action:'set',iris_starburst:'none'},ctx);state=avatarState.get();
  assert.equal(state.irisStarburst,null);assert.equal(state.irisInner,'#cda54e');assert.equal(state.eyes,'#3278cc');assert.equal(state.outerEye,'#eeeeee');
  const before=avatarState.get();await runTool('avatar_appearance',{action:'set',iris_inner_ring:'invalid color'},ctx);assert.deepEqual(avatarState.get(),before);
  await runTool('avatar_appearance',{action:'reset'},ctx);for(const field of ['irisInner','irisOuter','irisStarburst','irisFlecks'])assert.equal(avatarState.get()[field],null);
});
test('iris masks retain radial position and original fine highlights without including the pupil or sclera',()=>{
  const width=100,pixels=new Uint8Array(width*width*4);
  for(let y=0;y<width;y++)for(let x=0;x<width;x++){
    const distance=Math.hypot(x-50,y-50),color=distance<7?[3,3,3]:distance<20?[50,85,60]:[200,180,170];pixels.set([...color,255],(y*width+x)*4);
  }
  pixels.set([140,160,140,255],(50*width+65)*4);
  const mask=eyeRegionMask(pixels,width,width),sample=(x,y)=>[...mask.slice((y*width+x)*4,(y*width+x)*4+4)];
  assert.equal(sample(50,50)[0],0);assert.equal(sample(80,50)[0],0);assert.equal(sample(80,50)[1],255);
  assert.ok(sample(65,50)[0]>200);assert.ok(sample(65,50)[3]>200);assert.ok(sample(64,50)[3]<128);
  assert.ok(sample(58,50)[2]<sample(65,50)[2]);assert.ok(sample(65,50)[2]<sample(69,50)[2]);
});

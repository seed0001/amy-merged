import test from 'node:test';
import assert from 'node:assert/strict';
import {changeBackground,backgroundState,backgroundImage,checkScene,backgroundScene} from './avatar-background.js';
import {bus} from './events.js';
import {once} from 'node:events';
import {config} from './config.js';
import {startDashboard} from './dashboard/server.js';
test('background image is downloaded, saved and emitted; presets restore it',async()=>{
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO6sAAAAASUVORK5CYII=','base64');
  const events=[];const listener=e=>events.push(e);bus.on('avatar-background',listener);
  try{
    const state=await changeBackground({action:'image',url:'https://example.com/background.png'},async()=>new Response(bytes));
    assert.equal(state.type,'image');assert.deepEqual(backgroundImage(state.value).bytes,bytes);assert.equal(backgroundState().value,state.value);
    await changeBackground({action:'color',value:'#102030'});assert.equal(backgroundState().value,'#102030');
    await changeBackground({action:'preset',value:'dusk'});assert.equal(backgroundState().type,'preset');assert.equal(events.length,3);
    await assert.rejects(changeBackground({action:'image',url:'https://example.com/page'},async()=>new Response('<html>web page</html>')),/image file/);
    assert.equal(backgroundState().value,'dusk');
    await assert.rejects(changeBackground({action:'color',value:'invalid'}),/#RRGGBB/);
    assert.throws(()=>backgroundImage('../secret'),/Invalid/);
  }finally{bus.off('avatar-background',listener);}
});
const SURFACE='void surface(out vec4 color, vec3 world, vec3 normal, vec2 uv) { color = vec4(uv, uWeather.x, 1.0); }';
const SKY='void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(fragCoord.xy / iResolution.xy, uMood.x, 1.0); }';
test('a scene is checked piece by piece, saved, read back and recalled',async()=>{
  const spec={name:'Tidepools',sky:SKY,fog:{color:'#223344',near:5,far:120},lights:[{type:'sun',position:[1,2,1],color:'#ffeedd',intensity:2}],
    layers:[{name:'sea',geometry:'plane',size:[400,400],segments:[128,128],rotation:[-1.5708,0,0],position:[0,0,-50],shader:{fragment:`vec3 displace(vec3 p, vec3 n, vec2 uv) { return p + n * sin(p.x + iTime) * 0.3; }\n${SURFACE}`},uniforms:{uDepth:[0.1,0.3,0.6]},transparent:true,blending:'additive'}],
    particles:[{count:800,color:'#ffffff',follow:'rain',drift:[0,-9,0]}],camera:{height:2,sway:0.2},post:SKY};
  const checked=checkScene(JSON.stringify(spec));
  assert.equal(checked.layers[0].segments[0],128);assert.equal(checked.layers[0].blending,'additive');assert.equal(checked.particles[0].count,800);assert.equal(checked.camera.height,2);assert.ok(checked.post[0].shader);
  assert.equal(checkScene({post:[SKY,{name:'grade',shader:SKY}]}).post.length,2,'post passes chain');
  const events=[];const listener=e=>events.push(e);bus.on('avatar-background',listener);
  try{
    const state=await changeBackground({action:'scene',spec:JSON.stringify(spec)});
    assert.equal(state.type,'scene');assert.equal(state.name,'Tidepools');assert.equal(backgroundState().value,state.value);
    assert.equal(JSON.parse(backgroundScene(state.value)).layers[0].name,'sea');
    const read=await changeBackground({action:'read',value:state.value});assert.equal(read.spec.name,'Tidepools');
    await changeBackground({action:'color',value:'#000000'});
    const back=await changeBackground({action:'recall',value:state.value});assert.equal(back.type,'scene');assert.equal(back.name,'Tidepools');
    assert.equal(events.length,3);
  }finally{bus.off('avatar-background',listener);}
  assert.throws(()=>checkScene('{not json'),/valid JSON/);
  assert.throws(()=>checkScene({layers:[{geometry:'teapot',shader:SURFACE}]}),/geometry must be one of/);
  assert.throws(()=>checkScene({layers:[{geometry:'plane',shader:'void main(){}'}]}),/define void surface/);
  assert.throws(()=>checkScene({layers:[{name:'sea',geometry:'plane',shader:`uniform sampler2D t;\n${SURFACE}`}]}),/sea.*may not use/);
  assert.throws(()=>checkScene({layers:[{geometry:'plane',shader:SURFACE,uniforms:{color:1}}]}),/start with "u"/);
  assert.throws(()=>checkScene({lights:Array(7).fill({type:'point'})}),/At most 6 lights/);
  assert.throws(()=>checkScene({particles:[{count:'lots'}]}),/count must be a number/);
  assert.throws(()=>checkScene({sky:{nope:1}}),/sky must be/);
  assert.equal(checkScene({particles:[{count:999999}]}).particles[0].count,20000,'counts are capped, not refused');
  const made=checkScene({layers:[{name:'pot',geometry:'lathe',profile:[[0,0],[1,0.1],[0.8,1.2]],material:{color:'#aa5533',clearcoat:0.5}},{name:'handle',geometry:'tube',path:[[1,0.8,0],[1.5,0.9,0],[1.5,0.4,0]],size:[0.07],material:{}},{name:'shard',geometry:'mesh',positions:[0,0,0,1,0,0,0,1,0],material:{flatShading:true}}]});
  assert.equal(made.layers[0].profile.length,3);assert.ok(made.layers[0].lit);assert.equal(made.layers[1].path.length,3);assert.equal(made.layers[2].mesh.positions.length,9);
  assert.throws(()=>checkScene({layers:[{geometry:'tube',path:[[0,0]],material:{}}]}),/path must be 2 to 400/);
  assert.throws(()=>checkScene({layers:[{geometry:'box'}]}),/needs a shader .* or a material/);
  // What she actually reaches for: colour names, and "type" for the geometry.
  const named=checkScene({sky:{gradient:['charcoal','midnight blue']},fog:{color:'slate gray',near:1,far:9},layers:[{name:'pot',type:'lathe',profile:[[0,0],[1,1]],material:{color:'terracotta'}}]});
  assert.match(named.sky.gradient[0],/^#[0-9a-f]{6}$/);assert.equal(named.layers[0].geometry,'lathe');assert.match(named.layers[0].lit.color,/^#[0-9a-f]{6}$/);
  assert.throws(()=>checkScene({sky:{gradient:['not a colour at all']}}),/color like #RRGGBB or a known color name/);
  assert.throws(()=>backgroundScene('../x'),/Invalid/);
});
test('dashboard serves saved backgrounds and lets viewers restore a preset',async()=>{
  config.dashboard.host='127.0.0.1';config.dashboard.port=0;config.dashboard.password='';
  const server=startDashboard({});await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const response=await fetch(base+'/api/avatar/background',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'color',value:'#112244'})});
    assert.equal(response.status,200);
    const current=await fetch(base+'/api/avatar/background').then(r=>r.json());assert.equal(current.value,'#112244');
    const view=await fetch(base+'/api/avatar/view',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({scale:1.5,frame:'face'})}).then(r=>r.json());
    assert.equal(view.scale,1.5);assert.equal(view.frame,'face');
    assert.equal((await fetch(base+'/api/avatar/view').then(r=>r.json())).zoom,1/1.5);
    const preset=await fetch(base+'/api/avatar/background',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'preset',value:'studio'})}).then(r=>r.json());
    assert.equal(preset.type,'preset');assert.equal(preset.value,'studio');
  }finally{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    // The fetches' sockets close a moment after the server does; force-exiting the test run before they have makes
    // Node abort on Windows (UV_HANDLE_CLOSING in async.c), failing this file though every test passed.
    for(let i=0;i<40&&process.getActiveResourcesInfo().some(r=>r.startsWith('TCP'));i++)await new Promise(r=>setTimeout(r,25));
  }
});

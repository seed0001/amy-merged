import { applyAvatarAppearance } from './avatar-appearance.js';
const WATCH=window.WATCH_ONLY===true;
// ?pip: just her, for the little box her browser keeps in a corner of every page (browser.js).
if(new URLSearchParams(location.search).has('pip'))document.body.classList.add('pip');
import {SPEECH_SHAPES,compileArticulation,sampleArticulation,smoothSpeech} from './speech-articulation.js';
import { applyFacePerformance,activeAnimation,FACE_HEAD,FACE_PRESETS,PULSED } from './avatar-performance.js';
import { smoothBones, smoothShapes } from './avatar-smoothing.js';
import { setupHands, updateHands } from './avatar-hands.js';
import { startTears, updateTears, resetTears, canCry } from './avatar-tears.js';
import { STYLES, ALIASES as STYLE_ALIASES, perform as performStyle } from './avatar-moments.js';
import { addPupils, pupilTarget, easePupil } from './avatar-pupils.js';
import { createDance } from './avatar-dance.js';
// Avatar studio: a cast of 3D companions that talk through the bot's brain (Ollama) and voices
// (Fish Audio). They share one scene and one conversation; whoever you name answers.
//
// The animation drivers are ports of GlbPlayer's C# ones (BlinkDriver, GazeDriver, HeadMotionDriver,
// the arm rest pose from GlbViewControl). The big difference is lip sync: SAPI reported visemes, but
// Fish Audio only gives us audio, so the mouth is driven by analysing the clip as it plays.
import * as THREE from 'three';
import { watchGeneration } from './generation-delivery-ui.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = (s) => document.querySelector(s);
// Her small motions (blinks, glances) happen here in the page and nowhere else. The Studio page reports
// them to her server in little batches so her mind page (mind.html) can fire the body cluster with them.
// The watch-only stream page stays quiet so each motion is reported once.
const beatQueue = new Map();
let beatTimer = null;
function beat(kind, character = 'main') {
  if (WATCH) return;
  const k = `${kind}|${character}`;
  beatQueue.set(k, (beatQueue.get(k) || 0) + 1);
  if (beatTimer) return;
  beatTimer = setTimeout(() => {
    const beats = [...beatQueue.entries()].map(([key, n]) => { const [kind, character] = key.split('|'); return { kind, character, n }; });
    beatQueue.clear(); beatTimer = null;
    fetch('/api/avatar/beat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beats }) }).catch(() => {});
  }, 300);
}

// ---- Music: the library songs she plays from the music tool ({ type: 'music' } stream messages).
// A plain <audio> element, kept out of the lip-sync analyser so songs don't move her mouth, and
// turned down while she's talking.
const jukebox = { el: new Audio(), queue: [], index: -1 };
// Her dancing to music: songs played here (the studio) and in her voice calls (told by her server).
const dance = createDance({ fetchJson: (url) => fetch(url).then((r) => (r.ok ? r.json() : null)) });
// Her fidgets for the next stretch, planned by her server each pressure tick (body.js), played here on
// the frame clock. Anything due while she's talking, dancing or asleep is skipped, unless she asked for it.
const fidgetPlan = [];
function playDueFidgets(c) {
  const now = Date.now();
  while (fidgetPlan.length && fidgetPlan[0].due <= now) {
    const f = fidgetPlan.shift();
    if (now - f.due > 4000) continue; // stale (the page was asleep or hidden): don't play it late
    if (!f.force && (c.lips?.speechActive || dance.active() || sleepNow?.asleep)) continue;
    if (GESTURE_DEFS[f.name]) playGesture(c, f.name, 0, f.ms);
    else performanceState = { ...performanceState, motion: { name: f.name, strength: 0.6, duration: (f.ms || 4000) / 1000, at: now, source: 'background' } };
  }
}
// Checking a plan by eye: amyPlan([{ name: 'settle', ms: 3000, at: 0 }, { name: 'yawn', ms: 4000, at: 3500 }]).
window.amyPlan = (items) => { const base = Date.now(); for (const f of items) fidgetPlan.push({ ...f, due: base + (f.at || 0) }); fidgetPlan.sort((a, b) => a.due - b.due); return `${items.length} planned`; };
const IDLE_FIDGETS = new Set(['neck_stretch', 'neck_roll', 'shoulder_roll', 'settle', 'deep_breath', 'look_away', 'head_tilt', 'lip_press', 'chin_up']);
window.amyDancing = () => ({ ...dance.debug(), spine: (() => { const c = cast.find((x) => x.main); return c?.fx ? { roll: +c.fx.spineRoll.toFixed(1), yaw: +c.fx.spineYaw.toFixed(1), headRoll: +c.fx.roll.toFixed(1) } : null; })() });
// Checking her dance by eye without any sound: amyDanceTo('backbone-bitch.mp3'), amyDanceTo(null) to stop.
window.amyDanceTo = (track, analysis) => { if (track && analysis) dance.seed(track, analysis); dance.set(track ? { state: 'play', track, position: 0, at: Date.now() } : { state: 'stop', track: null, position: 0, at: Date.now() }); return track ? `dancing to ${track}` : 'stopped'; };
jukebox.el.volume = 0.6;
jukebox.el.addEventListener('ended', () => playSong(jukebox.index + 1));
function playSong(index) {
  const track = jukebox.queue[index];
  if (!track) return musicCommand({ action: 'stop' });
  jukebox.index = index;
  jukebox.el.src = track.url;
  jukebox.el.play().catch(() => toast('Click anywhere on the page to let the music play.'));
  dance.studio(jukebox.el, track.url);
  toast(`🎵 ${track.title}`);
}
function musicCommand({ action, tracks = [] }) {
  if (action === 'play') { jukebox.queue = tracks; playSong(0); }
  else if (action === 'queue') { jukebox.queue.push(...tracks); if (jukebox.index < 0 || jukebox.el.ended) playSong(jukebox.queue.length - tracks.length); }
  else if (action === 'pause') jukebox.el.pause();
  else if (action === 'resume') jukebox.el.play().catch(() => {});
  else if (action === 'skip') playSong(jukebox.index + 1);
  else if (action === 'stop') { jukebox.el.pause(); jukebox.el.removeAttribute('src'); jukebox.queue = []; jukebox.index = -1; dance.studio(null, null); }
}
function duckMusic(talking) {
  jukebox.el.volume = talking ? 0.15 : 0.6;
}
const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
// Frame-rate independent easing: k is the fraction covered per 1/60 s.
const ease = (k, dt) => 1 - Math.pow(1 - k, dt * 60);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  name: '', voice: true, volume: 0.9, handsFree: false, subs: true,
  blink: true, gaze: true, head: true, intensity: 1, lips: 1, expr: 1, restSmile: 0.6,
  backdrop: 'studio', frame: 'bust', collapsed: false, quality: 'high', talkingTo: 'main',
};
let opts = { ...DEFAULTS };
let viewSettings={scale:1,zoom:1,frame:'body'};
let outfitPalettes={},activeOutfitId='suit';
let performanceState={gain:1,autonomous:true,gaze:'ambient',face:null,motion:null};
try { opts = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('avatarOpts') || '{}') }; } catch {}
// The office backdrop was removed; anyone who had it goes back to the studio.
if (opts.backdrop === 'office') opts.backdrop = 'studio';
delete opts.officeIntroduced;
if(opts.environmentGazeVersion!==1){opts.gaze=true;opts.environmentGazeVersion=1;}
if(WATCH){opts.collapsed=true;opts.handsFree=false;opts.voice=true;opts.subs=true;document.body.classList.add('watch-only');}
const save = () => { try { localStorage.setItem('avatarOpts', JSON.stringify(opts)); } catch {} };

// ---------------------------------------------------------------- scene

const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Khronos "Neutral" keeps skin and hair colours true to their textures; ACES washes skin out
// and AgX flattens everything toward grey.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap; // soft, blurred shadows (hair on the forehead, chin on the neck)

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.22; // low, so the key light's shading reads (too much ambient = flat)

// A portrait lighting rig: a soft warm key that casts shadows, a cool fill, and two rims that
// pick the hair and shoulders out from the background.
const key = new THREE.DirectionalLight(0xfff0e2, 3.2);
key.position.set(1.3, 2.4, 2.1);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.012;
key.shadow.radius = 5;
key.shadow.blurSamples = 16;
const fill = new THREE.DirectionalLight(0xdbe6ff, 0.4);
fill.position.set(-2.2, 1.3, 1.6);
const rimCool = new THREE.DirectionalLight(0xc4d4ff, 2.2);
rimCool.position.set(-1.6, 2.3, -2.2);
const rimWarm = new THREE.DirectionalLight(0xffd9b8, 1.2);
rimWarm.position.set(1.9, 1.7, -1.9);
const sky = new THREE.HemisphereLight(0xe4ebff, 0x3a2e34, 0.18);
scene.add(key, key.target, fill, rimCool, rimWarm, sky);

// A soft contact shadow under each character's feet in full-body view. A painted blob rather than
// a shadow-catching floor, which renders as a black slab with soft (VSM) shadows.
const shadowBlobTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.6)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
function makeShadowBlob() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.6),
    new THREE.MeshBasicMaterial({ map: shadowBlobTexture, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.userData.noAO = true;
  return mesh;
}

// The backdrop is drawn in the scene (not CSS) so post-processing treats it like the rest of the image.
const BACKDROPS = { studio: ['#2a2d40', '#0b0c12'], dusk: ['#45325c', '#110c1a'], day: ['#eef1f7', '#c3cbdb'] };
let backgroundToken=0,backgroundImageElement=null;
function drawBackgroundImage(){
  if(!backgroundImageElement)return;
  const canvas=document.createElement('canvas');canvas.width=innerWidth;canvas.height=innerHeight;
  const image=backgroundImageElement,scale=Math.max(canvas.width/image.width,canvas.height/image.height);
  canvas.getContext('2d').drawImage(image,(canvas.width-image.width*scale)/2,(canvas.height-image.height*scale)/2,image.width*scale,image.height*scale);
  scene.background?.dispose?.();scene.background=new THREE.CanvasTexture(canvas);scene.background.colorSpace=THREE.SRGBColorSpace;
}
// Her own shaders: GLSL she wrote, drawn every frame into a texture that serves as the backdrop.
let shaderRig=null;
const SHADER_HEAD='precision highp float;\nuniform vec3 iResolution;\nuniform float iTime;\nuniform vec4 iMouse;\n';
const SHADER_TAIL='\nvoid main() { mainImage(gl_FragColor, gl_FragCoord.xy); }\n';
function stopShaderBackground(){
  if(!shaderRig)return;
  shaderRig.target.dispose();shaderRig.material.dispose();shaderRig.quad.geometry.dispose();shaderRig=null;
}
async function startShaderBackground(id,token,revision){
  const response=await fetch(`/api/avatar/background/shader/${id}`);
  if(!response.ok)throw new Error(`shader download failed (HTTP ${response.status})`);
  const code=await response.text();
  if(token!==backgroundToken)return;
  const size=renderer.getDrawingBufferSize(new THREE.Vector2());
  const material=new THREE.ShaderMaterial({
    uniforms:{iTime:{value:0},iResolution:{value:new THREE.Vector3(size.x,size.y,1)},iMouse:{value:new THREE.Vector4()}},
    vertexShader:'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader:SHADER_HEAD+code+SHADER_TAIL,
    depthTest:false,depthWrite:false,
  });
  const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
  const quadScene=new THREE.Scene();quadScene.add(quad);
  const target=new THREE.WebGLRenderTarget(size.x,size.y);
  shaderRig={material,quad,quadScene,target,revision,camera:new THREE.Camera(),size:new THREE.Vector2(size.x,size.y),start:performance.now()};
  scene.background=target.texture;
}
function renderShaderBackground(){
  if(!shaderRig)return;
  const size=renderer.getDrawingBufferSize(shaderRig.size);
  if(size.x!==shaderRig.target.width||size.y!==shaderRig.target.height)shaderRig.target.setSize(size.x,size.y);
  const u=shaderRig.material.uniforms;
  u.iResolution.value.set(size.x,size.y,1);u.iTime.value=(performance.now()-shaderRig.start)/1000;
  const previous=renderer.getRenderTarget();
  try{renderer.setRenderTarget(shaderRig.target);renderer.render(shaderRig.quadScene,shaderRig.camera);}
  catch(error){const rig=shaderRig;stopShaderBackground();scene.background=null;reportBackground(false,`shader failed to draw: ${error.message}`,rig.revision);}
  finally{renderer.setRenderTarget(previous);}
}
// ---------------------------------------------------------------- her 3D scenes
// A world she built (avatar-background.js checkScene): a sky, layers of geometry each with her own GLSL
// material, particle fields, a swaying camera, an optional post shader. Drawn every frame with its own
// camera into a texture that serves as the backdrop, so it never touches her avatar's lighting. Every
// shader gets her mood as weather (mood-weather.js, streamed as 'mood'): uMood, uWeather, uLightning.
let sceneRig=null;
const weatherNow={mood:{joy:0.3,calm:0.6,anger:0,sadness:0,tension:0,energy:0.4},weather:{storm:0,rain:0,clouds:0.1,wind:0.1,sun:0.5,haze:0.1}};
const weatherShown={...weatherNow,mood:{...weatherNow.mood},weather:{...weatherNow.weather}}; // eased toward weatherNow, so weather rolls in
let lightning={flash:0,next:0};
const SCENE_UNIFORMS=`uniform float iTime; uniform vec3 iResolution; uniform float uDay; uniform vec3 uSun; uniform vec3 uSunColor; uniform vec3 uCamera;
uniform vec4 uMood; uniform vec4 uWeather; uniform vec2 uWeather2; uniform float uEnergy; uniform float uLightning;
uniform vec3 uFogColor; uniform vec3 uFog;
`;
const MAT_VARYINGS='varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv; varying vec3 vLocal;\n';
const userUniformDecls=(uniforms)=>Object.entries(uniforms).map(([k,v])=>`uniform ${typeof v==='number'?'float':`vec${v.length}`} ${k};`).join('\n')+'\n';
function sceneGeometry(l){
  const s=l.size,g=l.segments;
  switch(l.geometry){
    case 'plane':return new THREE.PlaneGeometry(s[0],s[1]??s[0],g[0],g[1]??g[0]);
    case 'terrain':{const geo=new THREE.PlaneGeometry(s[0],s[1]??s[0],g[0],g[1]??g[0]);geo.rotateX(-Math.PI/2);return geo;}
    case 'sphere':return new THREE.SphereGeometry(s[0],g[0]>1?g[0]:48,g[1]>1?g[1]:32);
    case 'dome':return new THREE.SphereGeometry(s[0],g[0]>1?g[0]:48,g[1]>1?g[1]:24,0,Math.PI*2,0,Math.PI/2);
    case 'box':return new THREE.BoxGeometry(s[0],s[1]??s[0],s[2]??s[0],g[0],g[1]??g[0],g[1]??g[0]);
    case 'torus':return new THREE.TorusGeometry(s[0],s[1]??s[0]*0.3,g[0]>1?g[0]:24,g[1]>1?g[1]:96);
    case 'cylinder':return new THREE.CylinderGeometry(s[0],s[1]??s[0],s[2]??1,g[0]>1?g[0]:32,g[1]);
    case 'cone':return new THREE.ConeGeometry(s[0],s[1]??1,g[0]>1?g[0]:32,g[1]);
    case 'ring':return new THREE.RingGeometry(s[0],s[1]??s[0]*1.5,g[0]>1?g[0]:64,g[1]);
    // The pottery wheel: her [radius, height] profile spun around the vertical axis.
    case 'lathe':return new THREE.LatheGeometry(l.profile.map(([r,y])=>new THREE.Vector2(r,y)),g[0]>1?g[0]:64);
    // A tube along her path of points: vines, handles, ribbons.
    case 'tube':return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(l.path.map((p)=>new THREE.Vector3(...p))),g[0]>1?g[0]:64,s[0]||0.2,g[1]>1?g[1]:12,false);
    // Raw triangles she wrote herself, with normals worked out from them.
    case 'mesh':{
      let geo=new THREE.BufferGeometry();
      geo.setAttribute('position',new THREE.Float32BufferAttribute(l.mesh.positions,3));
      if(l.mesh.indices)geo.setIndex(l.mesh.indices);
      if(l.mesh.uvs)geo.setAttribute('uv',new THREE.Float32BufferAttribute(l.mesh.uvs,2));
      else geo.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(l.mesh.positions.length/3*2),2));
      if(!l.mesh.smooth&&geo.index)geo=geo.toNonIndexed();
      geo.computeVertexNormals();
      return geo;
    }
    default:return new THREE.PlaneGeometry(1,1);
  }
}
// A lit material (no shader of hers): a real surface under the scene's lights, for sculpted pieces.
function litMaterial(l){
  const m=l.lit;
  const mat=new THREE.MeshPhysicalMaterial({color:new THREE.Color(m.color),roughness:m.roughness,metalness:m.metalness,emissive:new THREE.Color(m.emissive),emissiveIntensity:m.emissiveIntensity,
    opacity:m.opacity,transparent:l.transparent,clearcoat:m.clearcoat,sheen:m.sheen,transmission:m.transmission,ior:m.ior,flatShading:m.flatShading,wireframe:m.wireframe,side:SIDE[l.side]??THREE.FrontSide,depthWrite:l.depthWrite});
  mat.name=l.name;return mat;
}
function sceneLight(l){
  const c=new THREE.Color(l.color);
  if(l.type==='ambient')return new THREE.AmbientLight(c,l.intensity);
  if(l.type==='hemisphere')return new THREE.HemisphereLight(c,new THREE.Color(l.ground),l.intensity);
  if(l.type==='point'){const p=new THREE.PointLight(c,l.intensity,0,1.5);p.position.set(...l.position);return p;}
  const d=new THREE.DirectionalLight(c,l.intensity);d.position.set(...l.position);d.target.position.set(0,0,-20);return d;
}
const BLEND={normal:THREE.NormalBlending,additive:THREE.AdditiveBlending,multiply:THREE.MultiplyBlending};
const SIDE={front:THREE.FrontSide,back:THREE.BackSide,double:THREE.DoubleSide};
function sharedUniforms(rig){
  return {iTime:rig.u.iTime,iResolution:rig.u.iResolution,uDay:rig.u.uDay,uSun:rig.u.uSun,uSunColor:rig.u.uSunColor,uCamera:rig.u.uCamera,uMood:rig.u.uMood,uWeather:rig.u.uWeather,uWeather2:rig.u.uWeather2,uEnergy:rig.u.uEnergy,uLightning:rig.u.uLightning,uFogColor:rig.u.uFogColor,uFog:rig.u.uFog};
}
// A layer's material: her surface() (and displace(), if she wrote one) wrapped with the varyings, fog and mood.
function layerMaterial(rig,l){
  const user=l.material.fragment;
  const hasDisplace=/vec3\s+displace\s*\(/.test(user);
  const head=`precision highp float;\n${SCENE_UNIFORMS}${userUniformDecls(l.uniforms)}${MAT_VARYINGS}`;
  const vertex=l.material.vertex?`${head}${user}\n${l.material.vertex}`:`${head}${user}
void main(){
  vec3 p=position; vUv=uv; vLocal=position;
  ${hasDisplace?'p=displace(p, normal, uv);':''}
  vec4 w=modelMatrix*vec4(p,1.0); vWorld=w.xyz; vNormal=normalize(mat3(modelMatrix)*normal);
  gl_Position=projectionMatrix*viewMatrix*w;
}`;
  const fragment=`${head}${user}
void main(){
  vec4 c=vec4(0.0); surface(c, vWorld, normalize(vNormal), vUv);
  float d=length(vWorld-uCamera);
  float f=uFog.z>0.5?(1.0-exp(-uFog.x*uFog.x*d*d)):clamp((d-uFog.x)/max(0.001,uFog.y-uFog.x),0.0,1.0);
  c.rgb=mix(c.rgb,uFogColor,f*uFog.y>0.0?f:0.0);
  gl_FragColor=c;
}`;
  const uniforms=sharedUniforms(rig);
  for(const [k,v] of Object.entries(l.uniforms))uniforms[k]={value:typeof v==='number'?v:v.length===2?new THREE.Vector2(...v):v.length===3?new THREE.Vector3(...v):new THREE.Vector4(...v)};
  const m=new THREE.ShaderMaterial({uniforms,vertexShader:vertex,fragmentShader:fragment,transparent:l.transparent,blending:BLEND[l.blending]??THREE.NormalBlending,side:SIDE[l.side]??THREE.FrontSide,depthWrite:l.depthWrite});
  m.name=l.name;return m;
}
// A particle field: points drifting through a box, wrapping around, soft discs that can twinkle.
// Opacity follows the weather channel it's tied to, so her rain is heavier when she's sadder.
function particleField(rig,p){
  const geo=new THREE.BufferGeometry();
  const pos=new Float32Array(p.count*3),seed=new Float32Array(p.count);
  for(let i=0;i<p.count;i++){pos[i*3]=(Math.random()-0.5)*p.area[0];pos[i*3+1]=(Math.random()-0.5)*p.area[1];pos[i*3+2]=(Math.random()-0.5)*p.area[2];seed[i]=Math.random();}
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));geo.setAttribute('aSeed',new THREE.BufferAttribute(seed,1));
  const uniforms={...sharedUniforms(rig),uColor:{value:new THREE.Color(p.color)},uOpacity:{value:p.opacity},uSize:{value:p.size},uDrift:{value:new THREE.Vector3(...p.drift)},uArea:{value:new THREE.Vector3(...p.area)},uCenter:{value:new THREE.Vector3(...p.center)},uWobble:{value:p.wobble},uTwinkle:{value:p.twinkle},uFollow:{value:p.follow}};
  const m=new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,blending:p.additive?THREE.AdditiveBlending:THREE.NormalBlending,
    vertexShader:`precision highp float;\n${SCENE_UNIFORMS}uniform vec3 uDrift; uniform vec3 uArea; uniform vec3 uCenter; uniform float uWobble; uniform float uSize; attribute float aSeed; varying float vSeed;
void main(){
  vSeed=aSeed;
  vec3 p=position+uDrift*iTime*(0.6+0.8*aSeed);
  p.x+=sin(iTime*(0.7+aSeed)+aSeed*20.0)*uWobble; p.z+=cos(iTime*(0.5+aSeed)+aSeed*13.0)*uWobble;
  p=mod(p+uArea*0.5,uArea)-uArea*0.5+uCenter;
  vec4 mv=viewMatrix*vec4(p,1.0);
  gl_PointSize=uSize*(iResolution.y/max(1.0,-mv.z))*(0.6+0.8*aSeed);
  gl_Position=projectionMatrix*mv;
}`,
    fragmentShader:`precision highp float;\n${SCENE_UNIFORMS}uniform vec3 uColor; uniform float uOpacity; uniform float uTwinkle; uniform float uFollow; varying float vSeed;
void main(){
  vec2 q=gl_PointCoord-0.5; float d=length(q); if(d>0.5)discard;
  float a=smoothstep(0.5,0.1,d)*uOpacity;
  if(uTwinkle>0.0)a*=0.5+0.5*sin(iTime*uTwinkle*(0.5+vSeed)+vSeed*40.0);
  float w=uFollow<0.5?1.0:uFollow<1.5?uWeather.y:uFollow<2.5?uWeather.x:uFollow<3.5?uWeather.w:uFollow<4.5?uWeather2.y:uWeather.z; // none, rain, storm, wind, snow(haze), clouds
  gl_FragColor=vec4(uColor,a*w);
}`});
  m.name=`particles (${p.follow?['','rain','storm','wind','snow','clouds'][p.follow]:'always'})`;
  return new THREE.Points(geo,m);
}
function stopSceneBackground(){
  if(!sceneRig)return;
  const rig=sceneRig;sceneRig=null;
  rig.scene.traverse((o)=>{o.geometry?.dispose?.();o.material?.dispose?.();});
  rig.sky?.material.dispose();rig.sky?.geometry.dispose();rig.post?.material.dispose();rig.post?.geometry.dispose();
  rig.target.dispose();rig.inner?.dispose();rig.pong?.dispose();
  for(const p of rig.posts??[]){p.material.dispose();p.scene.traverse((o)=>o.geometry?.dispose?.());}
}
async function startSceneBackground(id,token,revision){
  const response=await fetch(`/api/avatar/background/scene/${id}`);
  if(!response.ok)throw new Error(`scene download failed (HTTP ${response.status})`);
  const spec=await response.json();
  if(token!==backgroundToken)return;
  const size=renderer.getDrawingBufferSize(new THREE.Vector2());size.x=Math.max(2,size.x);size.y=Math.max(2,size.y);
  const u={iTime:{value:0},iResolution:{value:new THREE.Vector3(size.x,size.y,1)},uDay:{value:0.5},uSun:{value:new THREE.Vector3(0.3,0.8,0.5)},uSunColor:{value:new THREE.Color('#ffffff')},uCamera:{value:new THREE.Vector3()},
    uMood:{value:new THREE.Vector4()},uWeather:{value:new THREE.Vector4()},uWeather2:{value:new THREE.Vector2()},uEnergy:{value:0},uLightning:{value:0},
    uFogColor:{value:new THREE.Color(spec.fog?.color??'#000000')},uFog:{value:new THREE.Vector3(spec.fog?.density??spec.fog?.near??0,spec.fog?.density!==undefined?1:spec.fog?.far??0,spec.fog?.density!==undefined?1:0)}};
  const rig={spec,u,revision,start:performance.now(),size:new THREE.Vector2(size.x,size.y),scene:new THREE.Scene(),materials:[],checked:false,
    camera:new THREE.PerspectiveCamera(spec.camera.fov,size.x/Math.max(1,size.y),0.1,5000),target:new THREE.WebGLRenderTarget(size.x,size.y,{depthBuffer:true}),quadCam:new THREE.Camera()};
  const sun=spec.lights.find((l)=>l.type==='sun');
  if(sun){u.uSun.value.set(...sun.position).normalize();u.uSunColor.value.set(sun.color).multiplyScalar(sun.intensity);}
  // The sky: her shader, a gradient, or a colour, on a full-screen quad drawn first.
  if(spec.sky){
    const skyFrag=spec.sky.shader?`precision highp float;\n${SCENE_UNIFORMS}uniform vec4 iMouse;\n${spec.sky.shader}\nvoid main(){ mainImage(gl_FragColor, gl_FragCoord.xy); }`
      :spec.sky.gradient?`precision highp float;\n${SCENE_UNIFORMS}uniform vec3 uG[4]; uniform float uGn;
void main(){ float t=gl_FragCoord.y/iResolution.y; float s=t*(uGn-1.0); int i=int(floor(s)); vec3 c=mix(uG[i],uG[min(i+1,int(uGn)-1)],fract(s)); gl_FragColor=vec4(c,1.0); }`
      :`precision highp float;\nuniform vec3 uColor;\nvoid main(){ gl_FragColor=vec4(uColor,1.0); }`;
    const skyU={...sharedUniforms(rig),iMouse:{value:new THREE.Vector4()}};
    if(spec.sky.gradient){const g=spec.sky.gradient.map((c)=>new THREE.Color(c));while(g.length<4)g.push(g.at(-1));skyU.uG={value:g};skyU.uGn={value:spec.sky.gradient.length};}
    if(spec.sky.color)skyU.uColor={value:new THREE.Color(spec.sky.color)};
    const m=new THREE.ShaderMaterial({uniforms:skyU,vertexShader:'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',fragmentShader:skyFrag,depthTest:false,depthWrite:false});
    m.name='sky';rig.materials.push(m);
    rig.sky=new THREE.Mesh(new THREE.PlaneGeometry(2,2),m);rig.skyScene=new THREE.Scene();rig.skyScene.add(rig.sky);
  }
  // Real lights for her lit materials (shader layers read uSun instead). With none given, a soft default pair.
  const lit=spec.layers.some((l)=>l.lit);
  if(lit){
    for(const l of spec.lights){const light=sceneLight(l);rig.scene.add(light);if(light.target)rig.scene.add(light.target);}
    if(!spec.lights.length){rig.scene.add(new THREE.HemisphereLight(0xffffff,0x334455,1.2));const key=new THREE.DirectionalLight(0xffffff,2.2);key.position.set(3,5,-2);rig.scene.add(key);}
  }
  for(const l of spec.layers){
    const m=l.lit?litMaterial(l):layerMaterial(rig,l);rig.materials.push(m);
    const mesh=new THREE.Mesh(sceneGeometry(l),m);
    mesh.position.set(...l.position);mesh.rotation.set(...l.rotation);mesh.scale.set(...l.scale);mesh.userData.spin=l.spin;
    rig.scene.add(mesh);
  }
  for(const p of spec.particles){const pts=particleField(rig,{...p,follow:['none','rain','storm','wind','snow','clouds'].indexOf(p.follow??'none')});rig.materials.push(pts.material);rig.scene.add(pts);}
  if(spec.post?.length){
    // A chain of full-screen passes, ping-ponging between two targets; the last one lands in the backdrop.
    rig.inner=new THREE.WebGLRenderTarget(size.x,size.y,{depthBuffer:true});
    rig.pong=new THREE.WebGLRenderTarget(size.x,size.y);
    rig.posts=spec.post.map((p)=>{
      const m=new THREE.ShaderMaterial({uniforms:{...sharedUniforms(rig),iChannel0:{value:null},iMouse:{value:new THREE.Vector4()}},vertexShader:'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader:`precision highp float;\n${SCENE_UNIFORMS}uniform sampler2D iChannel0; uniform vec4 iMouse;\n${p.shader}\nvoid main(){ mainImage(gl_FragColor, gl_FragCoord.xy); }`,depthTest:false,depthWrite:false});
      m.name=p.name;rig.materials.push(m);
      const s=new THREE.Scene();s.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),m));return {material:m,scene:s};
    });
  }
  rig.camera.position.set(0,spec.camera.height,0);
  sceneRig=rig;
  scene.background=rig.target.texture;
}
// After the first frame, the compiled programs say which of her shaders failed, by name, so the report
// tells her exactly what to fix instead of a blank backdrop.
function checkSceneCompile(rig){
  rig.checked=true;
  const bad=[];
  for(const m of rig.materials){
    const program=renderer.properties.get(m)?.currentProgram;
    const d=program?.diagnostics;
    if(d&&d.runnable===false)bad.push(`${m.name}: ${String(d.fragmentShader?.log||d.vertexShader?.log||d.programLog||'failed to compile').replace(/\s+/g,' ').slice(0,220)}`);
  }
  if(bad.length){reportBackground(false,`scene shaders failed to compile. ${bad.join(' | ')}`,rig.revision);toast(`Scene shader problem: ${bad[0]}`);}
  else reportBackground(true,`scene "${rig.spec.name}" is up with ${rig.spec.layers.length} layers`,rig.revision);
}
const glide=(a,b,k)=>a+(b-a)*k;
function renderSceneBackground(dt){
  if(!sceneRig)return;
  const rig=sceneRig;
  const size=renderer.getDrawingBufferSize(rig.size);
  if(size.x<2||size.y<2)return; // the canvas hasn't been laid out yet: a zero-size target can't be drawn into
  if(size.x!==rig.target.width||size.y!==rig.target.height){rig.target.setSize(size.x,size.y);rig.inner?.setSize(size.x,size.y);rig.pong?.setSize(size.x,size.y);rig.camera.aspect=size.x/Math.max(1,size.y);rig.camera.updateProjectionMatrix();}
  const t=(performance.now()-rig.start)/1000,u=rig.u;
  u.iTime.value=t;u.iResolution.value.set(size.x,size.y,1);
  const d=new Date();u.uDay.value=(d.getHours()+d.getMinutes()/60)/24;
  // The weather eases toward where her mood is, over a few seconds, so a storm rolls in rather than snaps.
  const k=Math.min(1,(dt||0.016)*weatherRate()); // faster while she's playing
  for(const key of Object.keys(weatherShown.mood))weatherShown.mood[key]=glide(weatherShown.mood[key],weatherNow.mood[key]??0,k);
  for(const key of Object.keys(weatherShown.weather))weatherShown.weather[key]=glide(weatherShown.weather[key],weatherNow.weather[key]??0,k);
  const {m,w}=burstWeather(weatherShown.mood,weatherShown.weather,dt);
  u.uMood.value.set(m.joy,m.calm,m.anger,m.sadness);u.uWeather.value.set(w.storm,w.rain,w.clouds,w.wind);u.uWeather2.value.set(w.sun,w.haze);u.uEnergy.value=m.energy;
  // Lightning: strikes come more often the stormier she is; each is a flash that fades fast.
  if(w.storm>0.25&&t>lightning.next){lightning.flash=0.6+Math.random()*0.4;lightning.next=t+(1.5+Math.random()*10)*(1.2-w.storm);}
  lightning.flash*=Math.pow(0.02,dt||0.016);if(lightning.flash<0.005)lightning.flash=0;
  u.uLightning.value=lightning.flash;
  // The camera: a slow sway, plus a touch of the orbit the viewer has put the main camera at, for parallax.
  const sway=rig.spec.camera.sway,yaw=Math.atan2(camera.position.x,camera.position.z)*rig.spec.camera.parallax;
  rig.camera.position.set(Math.sin(t*0.11)*sway*0.4,rig.spec.camera.height+Math.sin(t*0.17)*sway*0.15,Math.cos(t*0.13)*sway*0.2);
  const look=new THREE.Vector3(...rig.spec.camera.look);
  look.applyAxisAngle(new THREE.Vector3(0,1,0),yaw);look.x+=Math.sin(t*0.07)*sway;look.y+=Math.sin(t*0.09)*sway*0.4;
  rig.camera.lookAt(look);u.uCamera.value.copy(rig.camera.position);
  for(const o of rig.scene.children)if(o.userData.spin){o.rotation.x+=o.userData.spin[0]*(dt||0.016);o.rotation.y+=o.userData.spin[1]*(dt||0.016);o.rotation.z+=o.userData.spin[2]*(dt||0.016);}
  const previous=renderer.getRenderTarget(),autoClear=renderer.autoClear;
  try{
    renderer.setRenderTarget(rig.posts?rig.inner:rig.target);
    renderer.setClearColor(0x000000,1);renderer.clear(true,true,true);
    renderer.autoClear=false;
    if(rig.skyScene){renderer.render(rig.skyScene,rig.quadCam);renderer.clearDepth();}
    renderer.render(rig.scene,rig.camera);
    if(rig.posts){
      let from=rig.inner;
      rig.posts.forEach((p,i)=>{const last=i===rig.posts.length-1;const to=last?rig.target:(from===rig.inner?rig.pong:rig.inner);p.material.uniforms.iChannel0.value=from.texture;renderer.setRenderTarget(to);renderer.render(p.scene,rig.quadCam);from=to;});
    }
    if(!rig.checked)checkSceneCompile(rig);
  }catch(error){stopSceneBackground();scene.background=null;reportBackground(false,`scene failed to draw: ${error.message}`,rig.revision);}
  finally{renderer.autoClear=autoClear;renderer.setRenderTarget(previous);}
}
// Her mood as weather, from the server (mood-weather.js), whenever her feelings or pressure change.
function applyMoodWeather(msg){
  if(msg?.mood)Object.assign(weatherNow.mood,msg.mood);
  if(msg?.weather)Object.assign(weatherNow.weather,msg.weather);
}
// While she plays her instrument (instrument.js), each phrase as it lands: the sky follows her mood fast instead of
// rolling in over seconds, a phrase that hits her well floods it with sun, one that lands sour darkens it with a
// flash. The bursts fade in a second or two; what's left is the weather her feelings and pressure make.
const musicBurst={sun:0,dark:0,until:0};
function applyPhrase(msg){
  applyMoodWeather(msg);
  const jolt=Number(msg?.jolt)||0,now=performance.now()/1000;
  if(jolt>0)musicBurst.sun=Math.max(musicBurst.sun,Math.min(1,jolt*1.3));
  if(jolt<0){musicBurst.dark=Math.max(musicBurst.dark,Math.min(1,-jolt*1.3));if(jolt<-0.35)lightning.flash=Math.max(lightning.flash,0.5);}
  musicBurst.until=now+Math.max(3,Number(msg?.remaining)||0);
}
const weatherRate=()=>performance.now()/1000<musicBurst.until?1.6:0.35; // how fast the shown weather catches up, per second
// The weather to draw this frame: her weather with the music's bursts on top, the bursts fading.
function burstWeather(m,w,dt){
  const fade=Math.pow(0.2,dt||0.016);musicBurst.sun*=fade;musicBurst.dark*=fade;
  const s=musicBurst.sun,d=musicBurst.dark;
  return {m:{...m,joy:m.joy+(1-m.joy)*s,calm:m.calm*(1-d*0.5),anger:m.anger+(1-m.anger)*d*0.4},
    w:{...w,sun:w.sun+(1-w.sun)*s,clouds:Math.max(0,w.clouds*(1-s))+(1-w.clouds)*d*0.7,storm:w.storm*(1-s)+(1-w.storm)*d*0.5,rain:w.rain*(1-s),haze:w.haze*(1-s*0.5)}};
}

// The weather over whatever backdrop is up: her mood changes the room on its own, with no tool call
// and nothing she has to do. A full scene of hers handles weather itself; everything else (a preset,
// a colour, an image, one of her flat shaders) gets this pass each frame: cloud cover rolling in and
// darkening as she tenses, rain when she's sad, lightning when she's angry, warm sun when she's happy,
// a soft haze when she's calm. Calm and content, it is almost invisible.
let moodOverlay=null;
const OVERLAY_FRAG=`precision highp float;
uniform sampler2D tBack; uniform vec3 uColor; uniform float uHasTex; uniform float iTime; uniform vec3 iResolution;
uniform vec4 uMood; uniform vec4 uWeather; uniform vec2 uWeather2; uniform float uLightning;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*noise(p);p*=2.03;a*=0.5;}return v;}
void main(){
  vec2 uv=gl_FragCoord.xy/iResolution.xy;
  vec3 c=uHasTex>0.5?texture2D(tBack,uv).rgb:uColor;
  float storm=uWeather.x,rain=uWeather.y,clouds=uWeather.z,wind=uWeather.w,sun=uWeather2.x,haze=uWeather2.y;
  // Sun: a warm glow from the upper right that lifts the whole picture a touch.
  float g=exp(-length(uv-vec2(0.78,0.82))*2.2);
  c+=vec3(1.0,0.85,0.6)*g*sun*0.35; c*=1.0+sun*0.08;
  // Haze: a pale, soft wash.
  c=mix(c,c*0.6+vec3(0.33,0.35,0.38),haze*0.35);
  // Clouds: drifting cover, denser and darker the more there are; a storm turns them slate.
  float cover=fbm(uv*vec2(3.0,1.6)+vec2(iTime*0.015*(1.0+wind*4.0),iTime*0.003));
  float cl=smoothstep(0.62-0.45*clouds,0.95-0.25*clouds,cover)*clouds*(0.55+0.45*(1.0-uv.y));
  vec3 cloudCol=mix(vec3(0.72,0.74,0.78),vec3(0.16,0.17,0.21),storm);
  c=mix(c,cloudCol,cl*0.8); c*=1.0-clouds*0.35-storm*0.25;
  // Rain: thin streaks falling fast, leaning with the wind, heavier with the rain.
  float drops=0.0;
  for(int l=0;l<2;l++){
    float s=l==0?1.0:1.7;
    vec2 rp=vec2(uv.x*150.0*s+uv.y*wind*7.0+float(l)*13.0,uv.y*3.5*s+iTime*(2.2+wind*2.0)*s);
    vec2 cell=floor(rp); float h=hash(cell+float(l)*31.0);
    float on=step(1.0-rain*0.45,h);
    float line=smoothstep(0.07,0.0,abs(fract(rp.x)-0.5));
    float seg=smoothstep(0.0,0.25,fract(rp.y+h))*smoothstep(1.0,0.55,fract(rp.y+h));
    drops+=on*line*seg*(l==0?0.4:0.25);
  }
  c+=vec3(0.75,0.8,0.9)*drops*rain;
  c=mix(c,c*vec3(0.85,0.9,1.0),rain*0.3);
  // Lightning: the whole picture flares.
  c+=vec3(0.85,0.9,1.0)*uLightning*(0.5+0.5*cover);
  gl_FragColor=vec4(c,1.0);
}`;
function renderMoodOverlay(dt){
  if(sceneRig)return; // her own scene already carries the weather
  const size=renderer.getDrawingBufferSize(new THREE.Vector2());
  if(size.x<2||size.y<2)return;
  const k=Math.min(1,(dt||0.016)*weatherRate()); // faster while she's playing
  for(const key of Object.keys(weatherShown.mood))weatherShown.mood[key]=glide(weatherShown.mood[key],weatherNow.mood[key]??0,k);
  for(const key of Object.keys(weatherShown.weather))weatherShown.weather[key]=glide(weatherShown.weather[key],weatherNow.weather[key]??0,k);
  const burst=burstWeather(weatherShown.mood,weatherShown.weather,dt);
  const w=burst.w,t=performance.now()/1000;
  if(w.storm>0.25&&t>lightning.next){lightning.flash=0.6+Math.random()*0.4;lightning.next=t+(1.5+Math.random()*10)*(1.2-w.storm);}
  lightning.flash*=Math.pow(0.02,dt||0.016);if(lightning.flash<0.005)lightning.flash=0;
  if(!moodOverlay){
    const material=new THREE.ShaderMaterial({uniforms:{tBack:{value:null},uColor:{value:new THREE.Color(0)},uHasTex:{value:0},iTime:{value:0},iResolution:{value:new THREE.Vector3(size.x,size.y,1)},uMood:{value:new THREE.Vector4()},uWeather:{value:new THREE.Vector4()},uWeather2:{value:new THREE.Vector2()},uLightning:{value:0}},
      vertexShader:'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',fragmentShader:OVERLAY_FRAG,depthTest:false,depthWrite:false});
    const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);const quadScene=new THREE.Scene();quadScene.add(quad);
    moodOverlay={material,quadScene,camera:new THREE.Camera(),target:new THREE.WebGLRenderTarget(size.x,size.y),base:null};
    moodOverlay.target.texture.dispose=()=>{}; // a new backdrop disposes scene.background; that must not take our output with it
  }
  const o=moodOverlay;
  // Whatever is behind her right now, unless it is already our own output: that stays the base.
  if(scene.background!==o.target.texture){
    if(o.base?.isTexture&&o.base!==scene.background&&o.base!==shaderRig?.target.texture)o.base.dispose?.(); // the old base is ours to let go of now
    o.base=scene.background;
  }
  if(!o.base)return; // nothing set yet
  if(size.x!==o.target.width||size.y!==o.target.height)o.target.setSize(size.x,size.y);
  const u=o.material.uniforms;
  if(o.base.isTexture){u.tBack.value=o.base;u.uHasTex.value=1;}else if(o.base.isColor){u.uColor.value.copy(o.base);u.uHasTex.value=0;}else return;
  u.iTime.value=t;u.iResolution.value.set(size.x,size.y,1);
  const m=burst.m;u.uMood.value.set(m.joy,m.calm,m.anger,m.sadness);u.uWeather.value.set(w.storm,w.rain,w.clouds,w.wind);u.uWeather2.value.set(w.sun,w.haze);u.uLightning.value=lightning.flash;
  const previous=renderer.getRenderTarget();
  try{renderer.setRenderTarget(o.target);renderer.render(o.quadScene,o.camera);scene.background=o.target.texture;}
  catch(error){scene.background=o.base;console.warn('mood overlay failed',error);}
  finally{renderer.setRenderTarget(previous);}
}

// Tells the server whether the background actually showed, so the tool can say so and failures reach the log.
function reportBackground(ok,message,revision){
  fetch('/api/avatar/background/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ok,message,revision})}).catch(()=>{});
}
async function applyBackground(background){
  const token=++backgroundToken;backgroundImageElement=null;
  stopShaderBackground();stopSceneBackground();
  if(background.type==='scene'){
    $('#optBackdrop').value='custom';
    try{await startSceneBackground(background.value,token,background.revision);} // the report comes after the first frame compiles (checkSceneCompile)
    catch(error){reportBackground(false,`scene: ${error.message}`,background.revision);toast(`Couldn't load the scene: ${error.message}`);}
    return;
  }
  if(background.type==='shader'){
    $('#optBackdrop').value='custom';
    try{await startShaderBackground(background.value,token,background.revision);if(token===backgroundToken)reportBackground(true,'',background.revision);}
    catch(error){reportBackground(false,`shader: ${error.message}`,background.revision);toast(`Couldn't load background shader: ${error.message}`);}
    return;
  }
  if(background.type==='preset'){
    opts.backdrop=background.value;document.body.dataset.backdrop=background.value;
    $('#optBackdrop').value=background.value;setBackdrop(background.value);save();reportBackground(true,'',background.revision);return;
  }
  $('#optBackdrop').value='custom';
  if(background.type==='color'){scene.background?.dispose?.();scene.background=new THREE.Color(background.value);reportBackground(true,'',background.revision);return;}
  try{
    const image=new Image();image.src=`/api/avatar/background/image/${background.value}`;
    await image.decode();if(token!==backgroundToken)return;
    backgroundImageElement=image;drawBackgroundImage();reportBackground(true,'',background.revision);
  }catch(error){reportBackground(false,`image: ${error.message}`,background.revision);toast(`Couldn't load background: ${error.message}`);}
}
function setBackdrop(name) {
  const [inner, outer] = BACKDROPS[name] ?? BACKDROPS.studio;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(220, 190, 20, 256, 256, 420);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  scene.background?.dispose?.();
  scene.background = new THREE.CanvasTexture(c);
  scene.background.colorSpace = THREE.SRGBColorSpace;
}

// ---------------------------------------------------------------- post-processing

// Film grain and a soft vignette, applied last, in display space. A perfectly clean image is a
// big part of what reads as "CG"; a touch of grain makes skin look photographed.
const GrainShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, grain: { value: 0.035 }, vignette: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, grain, vignette; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + time) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb += (hash(vUv * 1000.0) - 0.5) * grain * (1.0 - lum * 0.6);
      gl_FragColor = c;
    }`,
};

let composer = null, gtao = null, bloom = null, grain = null;
function buildComposer() {
  composer?.dispose();
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  // Ambient occlusion: the soft contact shading under the chin and nose, in the eye sockets and
  // where the collar meets the neck. The rigs ship no AO maps for the head or body, so this adds a lot.
  gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.updateGtaoMaterial({ radius: 0.09, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 16 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.9;
  // Hair cards and lashes are flat quads with see-through textures; in the AO pass they'd be solid
  // and cast dark rectangles, so they're left out (the shadow map handles hair shading).
  // The backdrop texture is dropped for the AO pass too: drawn there, it corrupts the AO depth
  // buffer and shows up as a black slab behind their legs.
  const hide = gtao.overrideVisibility.bind(gtao);
  const restore = gtao.restoreVisibility.bind(gtao);
  let backdrop = null;
  gtao.overrideVisibility = () => {
    hide();
    scene.traverse((o) => { if (o.userData.noAO) o.visible = false; });
    backdrop = scene.background;
    scene.background = null;
  };
  gtao.restoreVisibility = () => {
    restore();
    scene.background = backdrop;
  };
  composer.addPass(gtao);

  bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.14, 0.45, 0.9); // only bright glints
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  grain = new ShaderPass(GrainShader);
  composer.addPass(grain);
  applyQuality();
}

// low: no shadows or post-processing. medium: shadows + AO. high: everything, at full resolution.
function applyQuality() {
  const q = opts.quality;
  renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? 2 : q === 'medium' ? 1.5 : 1));
  renderer.shadowMap.enabled = q !== 'low';
  key.castShadow = q !== 'low';
  if (gtao) gtao.enabled = q !== 'low';
  if (bloom) bloom.enabled = q === 'high';
  if (grain) grain.uniforms.grain.value = q === 'high' ? 0.035 : 0;
  scene.traverse((o) => o.material && (o.material.needsUpdate = true)); // shadow on/off changes shaders
  resize();
}

const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
camera.position.set(0, 1.5, 2);
const controls = new OrbitControls(camera, canvas);
controls.enabled=!WATCH;
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 0.15;
controls.maxDistance = 40;

function resize() {
  // The panel covers the right of the screen, so the cast is framed in the space left of it.
  // Rendering a window of a larger virtual view shifts the centre without distorting anything.
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  if(backgroundImageElement)drawBackgroundImage();
  const collapsed = document.body.classList.contains('collapsed');
  const phone = innerWidth <= 760;
  const panel = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-w')) || 0;
  // The recorder has no panel: her face is centred, since clips are cut from the middle.
  const side = collapsed || phone || RECORDER ? 0 : panel + 16;
  // Phone: the chat is a bottom sheet covering ~46% of the height, so centre higher up.
  const below = phone && !collapsed && !RECORDER ? h * 0.32 : 0;
  camera.aspect = (w + side) / (h + below);
  camera.setViewOffset(w + side, h + below, side, below, w, h);
  camera.updateProjectionMatrix();
  if (composer) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
  }
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- the cast

const cast = []; // in screen order, left to right
const byId = new Map();
let current = null; // who you're talking to: gets the Expressions menu, the readout and the Face framing
let speaker = null; // who is talking right now: lip sync follows them and the others look at them
let thinker = null; // who is working out a reply

// Each character carries its own copy of every animation state, so they blink, glance, breathe
// and feel independently.
function createCharacter(info) {
  return {
    ...info, // id, name, persona, voiceId, main
    root: new THREE.Group(),
    model: null,
    morphs: new Map(), // morph target name -> [{ mesh, index }]
    bones: {},
    rest: new Map(), // bone -> rest quaternion (after the arm pose)
    height: 1.7,
    hasVisemes: false,
    weights: new Map(),
    managed: new Set(),
    blink: { until: 1500 + Math.random() * 3000, elapsed: -1, double: false },
    gaze: { tx: 0, ty: 0, x: 0, y: 0, hx: 0, hy: 0, idleAt: 0 },
    head: { t: Math.random() * 100, gYaw: 0, gPitch: 0, env: 0, envT: 0, life: 0, turn: THREE.MathUtils.degToRad(12), next: 5 + Math.random() * 8 },
    feel: { target: {}, now: {}, side: {}, pulse: null },
    fx: null,
    gestures: [],
    lips: { level: 0, cur: {}, fake: null, flashAt: 0 },
  };
}

// Compressed models (like three.js's facecap head) need the KTX2 texture and meshopt decoders.
const loader = new GLTFLoader()
  .setKTX2Loader(new KTX2Loader().setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/').detectSupport(renderer))
  .setMeshoptDecoder(MeshoptDecoder);
const loading = new Map(); // character -> fraction loaded
function showLoading() {
  const parts = [...loading.values()];
  $('#loading').hidden = !parts.length;
  if (parts.length) $('#loadingBar').style.width = `${(100 * parts.reduce((a, b) => a + b, 0)) / parts.length}%`;
}

async function loadModel(c, url) {
  loading.set(c, 0);
  $('#loadingText').textContent = 'Loading the cast…';
  showLoading();
  let gltf;
  try {
    gltf = await loader.loadAsync(url, (e) => {
      if (e.total) loading.set(c, e.loaded / e.total);
      showLoading();
    });
  } catch (err) {
    loading.delete(c);
    showLoading();
    toast(`Couldn't load ${c.name}: ${err.message || err}`);
    return { error: err.message || String(err) };
  }
  loading.delete(c);
  showLoading();

  c.root.scale.setScalar(1);
  if (c.model) c.root.remove(c.bones.Head?.isGroup ? c.bones.Head : c.model);
  if (c.model?.userData.hair) scene.remove(c.model.userData.hair.mesh);
  const model = (c.model = gltf.scene);
  c.morphs.clear();
  c.rest.clear();
  c.managed.clear();
  c.bones = {};
  model.traverse((o) => {
    if (o.isBone) c.bones[o.name.replace(/^.*[:|]/, '')] ??= o;
    if (o.isMesh) o.frustumCulled = false; // skinned meshes are often culled by their bind-pose bounds
    if (o.isMesh && o.morphTargetDictionary) {
      for (const [raw, index] of Object.entries(o.morphTargetDictionary)) {
        const name = raw.replace(/_L$/, 'Left').replace(/_R$/, 'Right'); // facecap-style eyeBlink_L
        if (!c.morphs.has(name)) c.morphs.set(name, []);
        c.morphs.get(name).push({ mesh: o, index });
      }
    }
  });
  c.hasVisemes = c.morphs.has('viseme_aa');
  upgradeMaterials(model);
  if (c.look) applyLook(model, c.look);
  if (c.appearance) applyCharacterAppearance(c);

  // Normalise each model to stand on the floor, face the camera and be a believable size, so
  // characters from different tools line up next to each other.
  c.root.position.set(0, 0, 0);
  c.root.rotation.set(0, 0, 0);
  c.root.add(model);
  c.root.updateMatrixWorld(true);
  const la = new THREE.Vector3(), ra = new THREE.Vector3();
  if (c.bones.LeftArm && c.bones.RightArm) {
    c.bones.LeftArm.getWorldPosition(la);
    c.bones.RightArm.getWorldPosition(ra);
    if (la.x < ra.x) model.rotation.y += Math.PI; // its left arm should be on screen right
  }
  model.updateMatrixWorld(true);
  // Measured over the posed skin (precise), not the stored geometry: some exports (Avaturn straight from the
  // web, e.g. "Tron Dragons", 2026-11-09) store the mesh far from where the skeleton puts it, and the rough box
  // read 2.76 m tall, so she was shrunk and floated a metre up. For a well-formed model the two agree.
  const rigged = Object.keys(c.bones).length > 0;
  let box = new THREE.Box3().setFromObject(model, rigged);
  const h = box.max.y - box.min.y;
  if (!Object.keys(c.bones).length) {
    // A floating head with no skeleton: size it like a real head at standing height, and give it
    // a neck pivot so head motion and feeling poses turn it like they would a Head bone.
    model.scale.multiplyScalar(0.24 / (h || 1));
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const neck = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    const pivot = new THREE.Group();
    pivot.name = 'Head';
    pivot.position.set(neck.x, 1.48, neck.z);
    model.position.sub(neck);
    c.root.remove(model);
    pivot.add(model);
    c.root.add(pivot);
    c.bones.Head = pivot;
    c.root.updateMatrixWorld(true);
    c.height = 1.72;
  } else if (h < 1.2 || h > 2.3) model.scale.multiplyScalar(1.75 / (h || 1.75));
  if (c.bones.Head?.isGroup) {
    c.rest.set(c.bones.Head, c.bones.Head.quaternion.clone());
  } else {
  model.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(model, rigged);
  model.position.y -= box.min.y;
  c.height = box.max.y - box.min.y;

  poseArms(c);
  for (const name of ['Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder','LeftArm','RightArm','LeftForeArm','RightForeArm','LeftHand','RightHand']) {
    if (c.bones[name]) c.rest.set(c.bones[name], c.bones[name].quaternion.clone());
  }
  setupHands(c, THREE); // her fingers: rest pose and curl axes (avatar-hands.js)
  setupDanceClips(c, gltf.animations); // real dances baked into her model, if it has any
  }
  // Where tears will run, worked out now while she's in her rest pose.
  resetTears(c);
  canCry(c);
  if (c.main && sleepNow) setSleep(c, sleepNow); // asleep or awake from the moment she loads
  if (c.main && botOffline) c.offline = true;
  if (!c.root.userData.blob) c.root.add((c.root.userData.blob = makeShadowBlob()));
  if (!c.root.parent) scene.add(c.root);

  c.root.scale.setScalar(viewSettings.scale);
  layout();
  if (!c.morphs.has('eyeBlinkLeft') && !c.hasVisemes) toast(`${c.name}'s model has no ARKit or viseme face shapes, so they can't blink or lip sync.`);
  if (state === 'loading' && !loading.size) setState('idle');
}

// Side by side, each turned a little toward the other, like two people talking with you.
function layout() {
  const ready = cast.filter((c) => c.model);
  const gap = 0.36;
  ready.forEach((c, i) => {
    const x = (i - (ready.length - 1) / 2) * gap * 2;
    c.root.position.set(x, 0, 0);
    c.root.rotation.y = ready.length > 1 ? -Math.sign(x) * 0.2 : 0;
    c.root.updateMatrixWorld(true);
  });
  // Fit the shadow camera tightly around everyone: the tighter it is, the sharper the shadow detail.
  const box = new THREE.Box3();
  for (const c of ready) box.expandByObject(c.model);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  key.target.position.copy(center);
  key.position.copy(center).add(new THREE.Vector3(1.3, 2.4, 2.1));
  const half = Math.max(box.max.y - box.min.y, box.max.x - box.min.x) * 0.6;
  Object.assign(key.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 8 });
  key.shadow.camera.updateProjectionMatrix();
  frame(opts.frame, !layout.done);
  layout.done = true;
}

// ---------------------------------------------------------------- materials

// glTF gives every surface the same basic material. Real skin, eyes, hair and cloth each reflect
// light differently, so each gets a physically-based upgrade, matched by material name with
// fallbacks so Avaturn, Ready Player Me and Avatar SDK models all get the same treatment.
function toPhysical(m, extra = {}) {
  const p = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(p, m);
  p.defines = { STANDARD: '', PHYSICAL: '' }; // Standard's copy() drops the PHYSICAL define
  return Object.assign(p, extra);
}

// Skin is translucent: light enters, scatters, and comes out redder, which softens the edge of
// shadows and stops skin looking like painted plastic. Approximated by letting diffuse light wrap
// past the shadow line with a red tint.
function addSkinScatter(mat) {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const line = 'vec3 irradiance = dotNL * directLight.color;';
  if (!chunk.includes(line)) return; // a three.js update changed the chunk; skip rather than break
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', chunk.replace(line, `${line}
      float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.5 ) / 1.5 );
      reflectedLight.directDiffuse += max( wrapNL - dotNL, 0.0 ) * directLight.color * vec3( 1.0, 0.35, 0.25 ) * 0.45 * BRDF_Lambert( material.diffuseColor );`));
  };
  mat.customProgramCacheKey = () => 'skin-scatter';
}

// Colors a plain grey scan like three.js's facecap head, from the character's "look" in
// characters.json: { skin, eyes, hair }. Its parts share one atlas material, so each gets
// its own copy, and the part is found from the names of the nodes above the mesh.
function applyLook(root, look) {
  const partOf = (o) => {
    for (let p = o; p; p = p.parent) {
      if (/eye/i.test(p.name)) return 'eye';
      if (/teeth/i.test(p.name)) return 'teeth';
      if (/head/i.test(p.name)) return 'head';
    }
    return 'head';
  };
  let head = null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const part = partOf(o);
    const m = (o.material = o.material.clone());
    if (part === 'head') {
      head = o;
      if (look.skin) m.color.set(look.skin).multiplyScalar(1.3); // the texture is a mid grey, so lift it back up
      m.roughness = 0.55;
    }
    if (part === 'eye' && look.eyes) {
      // Tint only the dark iris and pupil, so the whites stay white.
      const iris = { value: new THREE.Color(look.eyes) };
      m.onBeforeCompile = (sh) => {
        sh.uniforms.irisColor = iris;
        sh.fragmentShader = `uniform vec3 irisColor;
${sh.fragmentShader}`.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(irisColor * (0.35 + 1.4 * lum), diffuseColor.rgb, smoothstep(0.3, 0.55, lum));`,
        );
      };
      m.customProgramCacheKey = () => `iris${look.eyes}`;
    }
  });
  if (look.hair && head) {
    addHair(head, look.hair);
    root.userData.hair = addStrands(head, look.hair);
  }
}

// Where hair grows on a scan, as a 0..1 weight per vertex: 0 below the hairline, 1 well above it.
// The hairline sits high over the forehead, drops past the temples and runs low across the back.
// Everything is in world space at load time, while the model is still upright and facing +Z.
function scalpOf(head) {
  head.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(head), size = box.getSize(new THREE.Vector3());
  const src = head.geometry, pos = src.attributes.position, idx = src.index;
  if (!src.attributes.normal) src.computeVertexNormals();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(head.matrixWorld);
  const P = new Float32Array(pos.count * 3), N = new Float32Array(pos.count * 3), mask = new Float32Array(pos.count);
  const w = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    w.fromBufferAttribute(pos, i).applyMatrix4(head.matrixWorld);
    n.fromBufferAttribute(src.attributes.normal, i).applyMatrix3(normalMatrix).normalize();
    const y = (w.y - box.min.y) / size.y, back = THREE.MathUtils.clamp((box.max.z - w.z) / size.z, 0, 1);
    const side = Math.abs(w.x - (box.min.x + box.max.x) / 2) / (size.x / 2);
    const line = 0.8 - 0.42 * back ** 1.3 - 0.06 * side;
    mask[i] = THREE.MathUtils.smoothstep(y, line - 0.03, line + 0.06) * (n.y > -0.6 ? 1 : 0);
    w.toArray(P, i * 3);
    n.toArray(N, i * 3);
  }
  const tris = [], count = idx ? idx.count : pos.count;
  for (let t = 0; t < count; t += 3) {
    const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
    if (mask[a] + mask[b] + mask[c] > 0.05) tris.push(a, b, c);
  }
  return { box, size, P, N, mask, tris };
}

// The scalp's undercoat: stacked shells (copies of the scalp pushed out along its normals) showing
// a dense short fuzz, so skin doesn't show through between the simulated strands on top.
const HAIR_LAYERS = 40;
function addHair(head, color) {
  const { size, P, N, mask, tris } = scalpOf(head);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('hairMask', new THREE.Float32BufferAttribute(mask, 1));
  geo.setIndex(tris);

  const len = size.y * 0.03; // a few millimetres: just coverage
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.hairLen = { value: len };
    sh.uniforms.hairDensity = { value: 2600 / size.y }; // strand spacing, relative to head height
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float hairMask;
        uniform float hairLen;
        varying vec3 vRoot;
        varying float vLayer;
        varying float vMask;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLayer = float(gl_InstanceID) / ${HAIR_LAYERS - 1}.0;
        vRoot = position;
        vMask = hairMask;
        float h = vLayer * hairLen * hairMask;
        // Out along the scalp, then bending down and back under its own weight.
        transformed += objectNormal * h + vec3(0.0, -1.0, -0.4) * h * vLayer * 0.9;`)
;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float hairDensity;
        varying vec3 vRoot;
        varying float vLayer;
        varying float vMask;
        vec3 hash3(vec3 p) { p = fract(p * vec3(443.897, 441.423, 437.195)); p += dot(p, p.yzx + 19.19); return fract((p.xxy + p.yxx) * p.zyx); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // The nearest strand root in a jittered 3D grid over the scalp.
        vec3 cell = vRoot * hairDensity, id = floor(cell);
        float best = 9.0; vec3 rnd = vec3(0.0);
        for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
          vec3 o = id + vec3(x, y, z), r = hash3(o);
          float d = length(cell - o - r);
          if (d < best) { best = d; rnd = r; }
        }
        // Near the hairline strands get sparser and shorter, instead of stopping at an edge.
        if (rnd.z > vMask * 1.3 - 0.15) discard;
        float strandLen = mix(0.55, 1.0, rnd.x) * mix(0.4, 1.0, vMask);
        if (vLayer > 0.0 && (vLayer > strandLen || best > 0.75 * (1.0 - vLayer / max(strandLen, 0.001)))) discard;
        // Darker at the roots (self-shadowing), a little variation strand to strand.
        diffuseColor.rgb *= mix(0.35, 1.0, vLayer) * mix(0.8, 1.15, rnd.y);`);
  };
  mat.customProgramCacheKey = () => 'shellHair';
  const hair = new THREE.InstancedMesh(geo, mat, HAIR_LAYERS);
  for (let i = 0; i < HAIR_LAYERS; i++) hair.setMatrixAt(i, new THREE.Matrix4());
  hair.name = 'hair';
  hair.frustumCulled = false;
  hair.castShadow = true;
  hair.userData.noAO = true;
  head.attach(hair);
}

// Real strands: thousands of tapered ribbons rooted on the scalp, each a chain of points simulated
// with Verlet integration. Roots ride the head; the rest swings under gravity and inertia, keeps
// its combed shape with a stiffness that fades toward the tips, and is pushed out of the skull.
// The simulation runs in world space. "Rest" space is the head's world frame at load, where the
// strands were combed, and K maps rest space to wherever the head is now.
const STRANDS = 4000, SEGS = 14, CHILDREN = 7; // simulated guides, points per guide, drawn strands per guide
function addStrands(head, color) {
  const { box, size, P, N, mask, tris } = scalpOf(head);
  const restToHead = head.matrixWorld.clone().invert();
  const centre = box.getCenter(new THREE.Vector3()), radii = size.clone().multiplyScalar(0.5);
  const q = new THREE.Vector3();
  // Push a rest-space point out of the skull (an ellipsoid slightly larger than the head).
  const outside = (v, pad) => {
    q.subVectors(v, centre).divide(radii);
    const d = q.length();
    if (d < pad) v.copy(q.multiplyScalar(pad / d).multiply(radii).add(centre));
  };

  // Roots: area-weighted random points on the scalp, thinning out toward the hairline.
  const area = [], A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < tris.length; t += 3) {
    A.fromArray(P, tris[t] * 3); B.fromArray(P, tris[t + 1] * 3); C.fromArray(P, tris[t + 2] * 3);
    const m = Math.min(mask[tris[t]], mask[tris[t + 1]], mask[tris[t + 2]]);
    total += new THREE.Triangle(A, B, C).getArea() * m * m;
    area.push(total);
  }
  const pts = SEGS + 1;
  const rest = new Float32Array(STRANDS * pts * 3), rootN = new Float32Array(STRANDS * 3), seg = new Float32Array(STRANDS), shade = new Float32Array(STRANDS), pad = new Float32Array(STRANDS);
  const p = new THREE.Vector3(), n = new THREE.Vector3(), dir = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
  const crown = centre.clone().add(new THREE.Vector3(0, radii.y * 0.9, -radii.z * 0.35)); // the whorl hair grows out from
  for (let s = 0; s < STRANDS; s++) {
    const r = Math.random() * total;
    let lo = 0, hi = area.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (area[mid] < r) lo = mid + 1; else hi = mid; }
    const t = lo * 3;
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    p.set(0, 0, 0); n.set(0, 0, 0);
    for (const [k, wgt] of [[tris[t], 1 - u - v], [tris[t + 1], u], [tris[t + 2], v]]) {
      p.addScaledVector(A.fromArray(P, k * 3), wgt);
      n.addScaledVector(B.fromArray(N, k * 3), wgt);
    }
    n.normalize();
    n.toArray(rootN, s * 3);
    const edge = mask[tris[t]] * (1 - u - v) + mask[tris[t + 1]] * u + mask[tris[t + 2]] * v; // 1 well inside the hairline
    // Combed shape: lying along the scalp, flowing away from the crown, then falling under
    // gravity. Longer at the back.
    const len = size.y * (0.22 + 0.1 * Math.random()) * (1 + 0.4 * THREE.MathUtils.clamp((centre.z - p.z) / radii.z, 0, 1));
    seg[s] = (len * (0.25 + 0.75 * edge)) / SEGS; // short, fine hairs at the hairline
    // The ellipsoid bulges past the forehead, so a strand only collides from its root's depth out.
    pad[s] = Math.min(1.02, q.subVectors(p, centre).divide(radii).length() + 0.01);
    shade[s] = 0.75 + 0.5 * Math.random();
    dir.subVectors(p, crown);
    dir.addScaledVector(n, -dir.dot(n)).normalize().addScaledVector(n, 0.3 * edge).normalize();
    for (let i = 0; i < pts; i++) {
      if (i) {
        p.addScaledVector(dir, seg[s]);
        outside(p, pad[s]);
        dir.addScaledVector(down, 0.18).normalize();
      }
      p.toArray(rest, (s * pts + i) * 3);
    }
  }

  // Drawing happens on the GPU. Each frame the simulated guides go into a float texture (one row
  // per guide: its points, then its root normal), and the vertex shader builds CHILDREN tapered,
  // camera-facing ribbons around each guide. Children spread out at the root and gather toward
  // the tip, which is what makes hair clump into locks instead of reading as separate threads.
  const texW = pts + 1, guideData = new Float32Array(texW * STRANDS * 4);
  const guideTex = new THREE.DataTexture(guideData, texW, STRANDS, THREE.RGBAFormat, THREE.FloatType);
  guideTex.minFilter = guideTex.magFilter = THREE.NearestFilter;
  const strands = STRANDS * CHILDREN, verts = strands * pts * 2;
  const ref = new Float32Array(verts * 3), child = new Float32Array(verts * 4), index = new Uint32Array(strands * SEGS * 6);
  for (let s = 0, k = 0; s < strands; s++) {
    const g = Math.floor(s / CHILDREN), first = s % CHILDREN === 0;
    // Spot in the clump (in a disc; the first child is the guide itself), its own shade and length.
    const a = Math.random() * Math.PI * 2, r = first ? 0 : Math.sqrt(Math.random());
    const ox = Math.cos(a) * r, oy = Math.sin(a) * r, rnd = Math.random();
    const tone = shade[g] * (0.85 + 0.3 * Math.random());
    for (let i = 0; i < pts; i++) {
      for (let side = 0; side < 2; side++) {
        const v = (s * pts + i) * 2 + side;
        ref.set([g, i, side ? 1 : -1], v * 3);
        child.set([ox, oy, rnd, tone], v * 4);
      }
      if (i < SEGS) {
        const b = (s * pts + i) * 2;
        index.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], k);
        k += 6;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3)); // placed in the shader
  geo.setAttribute('hairRef', new THREE.BufferAttribute(ref, 3));
  geo.setAttribute('hairChild', new THREE.BufferAttribute(child, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  // Solid strands (no alpha-to-coverage): soft half-covered edges let whatever is behind her show
  // through her hair.
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide, alphaToCoverage: false });
  const clump = { value: 0 }; // how far children sit from their guide at the root (set per frame, in world units)
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.guides = { value: guideTex };
    sh.uniforms.clump = clump;
    sh.uniforms.hairWidth = { value: 0.00028 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 hairRef;
        attribute vec4 hairChild;
        uniform sampler2D guides;
        uniform float clump, hairWidth;
        varying vec3 vHairT;
        varying float vHairU, vHairSide, vHairShade, vHairRnd;
        vec3 guidePoint(float g, float i) { return texelFetch(guides, ivec2(int(i), int(g)), 0).xyz; }`)
      .replace('#include <beginnormal_vertex>', `
        float g = hairRef.x, i = hairRef.y, u = i / ${SEGS}.0;
        vec3 C = guidePoint(g, i);
        vec3 T = normalize(guidePoint(g, min(i + 1.0, ${SEGS}.0)) - guidePoint(g, max(i - 1.0, 0.0)));
        vec3 rootN = guidePoint(g, ${pts}.0);
        vec3 B = normalize(cross(T, rootN) + vec3(1e-5, 0.0, 0.0)), N2 = cross(B, T);
        // Clumping: wide at the root, gathered near the tip, with a little waviness of its own.
        float spread = clump * mix(1.0, 0.22, smoothstep(0.15, 0.95, u));
        float wave = clump * 0.18 * u * sin(u * 11.0 + hairChild.z * 40.0);
        C += B * (hairChild.x * spread + wave) + N2 * (hairChild.y * spread * 0.6);
        // Children trail off at different lengths, so the ends of a lock are thin and wispy.
        float keep = mix(0.7, 1.0, hairChild.z);
        float live = step(u, keep + 0.001);
        vec3 toCam = normalize(cameraPosition - C);
        vec3 S = normalize(cross(T, toCam));
        float w = hairWidth * (1.0 - 0.75 * u / keep) * live;
        vec3 hairPos = C + S * w * hairRef.z;
        // A thin cylinder's normal: toward the camera, rolling toward each edge.
        vec3 objectNormal = normalize(normalize(cross(S, T)) * sign(dot(cross(S, T), toCam)) + S * 0.55 * hairRef.z);
        vHairT = normalize((viewMatrix * vec4(T, 0.0)).xyz);
        vHairU = u / keep;
        vHairSide = hairRef.z;
        vHairShade = hairChild.w;
        vHairRnd = hairChild.z;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = hairPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vHairT;
        varying float vHairU, vHairSide, vHairShade, vHairRnd;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vHairU > 1.0) discard;
        diffuseColor.rgb *= vHairShade * mix(0.4, 1.0, smoothstep(0.0, 0.35, vHairU)); // darker at the roots
        // Soft, antialiased edges and wispy tips (via alpha to coverage).
        diffuseColor.a = (1.0 - smoothstep(0.55, 1.0, abs(vHairSide))) * (1.0 - smoothstep(0.75, 1.0, vHairU));`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // Hair sheen (Kajiya-Kay with Marschner's two lobes): light reflects off the cuticle as a
        // bright white band shifted toward the tips, plus a broader one tinted by the hair colour.
        #if NUM_DIR_LIGHTS > 0
        {
          vec3 Vd = normalize(vViewPosition);
          float jitter = (vHairRnd - 0.5) * 0.3;
          vec3 T1 = normalize(vHairT + normal * (0.12 + jitter));
          vec3 T2 = normalize(vHairT - normal * (0.1 - jitter));
          for (int l = 0; l < NUM_DIR_LIGHTS; l++) {
            vec3 L = directionalLights[l].direction, H = normalize(L + Vd);
            float t1 = dot(T1, H), t2 = dot(T2, H);
            float s1 = pow(sqrt(max(0.0, 1.0 - t1 * t1)), 180.0);
            float s2 = pow(sqrt(max(0.0, 1.0 - t2 * t2)), 40.0);
            float wrap = clamp(dot(normal, L) * 0.5 + 0.5, 0.0, 1.0);
            reflectedLight.directSpecular += directionalLights[l].color * wrap * (0.1 * s1 + 0.18 * s2 * diffuseColor.rgb);
          }
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => 'strandHair';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hairStrands';
  mesh.frustumCulled = false;
  mesh.userData.noAO = true;
  mesh.matrixWorldAutoUpdate = false; // the shader places everything in world space
  scene.add(mesh);

  const cur = new Float32Array(rest.length), prev = new Float32Array(rest.length);
  const K = new THREE.Matrix4(), Kinv = new THREE.Matrix4(), rot = new THREE.Matrix3();
  const x = new THREE.Vector3(), y = new THREE.Vector3(), comb = new THREE.Vector3();
  let started = false;

  return {
    mesh,
    update(dt) {
      head.updateWorldMatrix(true, false);
      K.multiplyMatrices(head.matrixWorld, restToHead);
      Kinv.copy(K).invert();
      const scale = Math.cbrt(Math.abs(K.determinant()));
      clump.value = size.y * scale * 0.035;
      if (!started) {
        // Start combed, wherever the head is.
        for (let j = 0; j < rest.length; j += 3) comb.fromArray(rest, j).applyMatrix4(K).toArray(cur, j);
        prev.set(cur);
        started = true;
      }
      const h = Math.min(dt, 1 / 30), g = -9.8 * h * h, damp = 0.94;
      for (let s = 0; s < STRANDS; s++) {
        const len = seg[s] * scale;
        for (let i = 0; i < pts; i++) {
          const j = (s * pts + i) * 3;
          comb.fromArray(rest, j).applyMatrix4(K); // where the comb puts this point now
          if (i === 0) {
            comb.toArray(cur, j);
            comb.toArray(prev, j);
            continue;
          }
          // Verlet: keep (damped) velocity and add gravity.
          for (let a = 0; a < 3; a++) {
            const now = cur[j + a];
            cur[j + a] = now + (now - prev[j + a]) * damp + (a === 1 ? g : 0);
            prev[j + a] = now;
          }
          // Hold the combed shape: firm at the root, loose at the tip.
          const f = 1 - i / pts;
          x.fromArray(cur, j).lerp(comb, 0.02 + 0.3 * f * f * f);
          // Keep the segment's length, following the point before it.
          y.fromArray(cur, j - 3);
          x.sub(y).setLength(len).add(y);
          // Stay out of the skull, tested in rest space where the ellipsoid is defined.
          x.applyMatrix4(Kinv);
          outside(x, pad[s]);
          x.applyMatrix4(K).toArray(cur, j);
        }
      }

      // Hand the guides to the shader: their points, then their root normal (turned with the head).
      rot.setFromMatrix4(K);
      for (let s = 0; s < STRANDS; s++) {
        const row = s * texW * 4;
        for (let i = 0; i < pts; i++) {
          const j = (s * pts + i) * 3;
          guideData[row + i * 4] = cur[j];
          guideData[row + i * 4 + 1] = cur[j + 1];
          guideData[row + i * 4 + 2] = cur[j + 2];
        }
        x.fromArray(rootN, s * 3).applyMatrix3(rot).normalize();
        guideData[row + pts * 4] = x.x;
        guideData[row + pts * 4 + 1] = x.y;
        guideData[row + pts * 4 + 2] = x.z;
      }
      guideTex.needsUpdate = true;
    },
  };
}

function upgradeMaterials(root) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    const name = `${m.name} ${o.name}`.toLowerCase();
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[key]) m[key].anisotropy = aniso;
    o.castShadow = true;
    o.receiveShadow = true;

    if (/eyeao|eyelash|lash|tearline/.test(name)) {
      if (m.transparent) m.depthWrite = false;
      o.castShadow = false;
      o.userData.noAO = true;
    } else if (/cornea/.test(name)) {
      // A separate clear shell over the eye: make it a wet, glassy coat that only shows highlights.
      o.material = toPhysical(m, { roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, depthWrite: false, envMapIntensity: 2 });
      o.castShadow = false;
      o.userData.noAO = true;
    } else if (/eye/.test(name)) {
      // A wet cornea: a sharp clear coat over the iris catches the lights as tiny highlights.
      o.material = toPhysical(m, { roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6 });
      addPupils(o.material, (root.userData.pupil ??= { value: 1 })); // living pupils (avatar-pupils.js)
      o.castShadow = false;
    } else if (/teeth|tongue/.test(name)) {
      o.material = toPhysical(m, { roughness: 0.45, clearcoat: name.includes('tongue') ? 0.6 : 0.3, clearcoatRoughness: 0.2 });
      o.material.color.multiplyScalar(0.88); // CG teeth are always too white
      o.castShadow = false;
    } else if (/hair|brow|beard/.test(name)) {
      // Hair isn't metal. Head hair is drawn solid down to its faint edges (a low alpha cut, no
      // alpha-to-coverage): with soft, half-covered edges the thin hair cards let whatever is behind
      // show through. Brows and beards keep the soft edges.
      const headHair = /hair/.test(name);
      o.material = toPhysical(m, {
        metalness: 0, roughness: 0.5, transparent: false, depthWrite: true, alphaToCoverage: !headHair,
        alphaTest: headHair ? 0.06 : m.transparent ? 0.12 : 0.3, sheen: 0.35, sheenRoughness: 0.3,
        sheenColor: new THREE.Color(0.7, 0.42, 0.3), specularIntensity: 0.5, envMapIntensity: 0.9,
      });
      o.userData.noAO = true;
    } else if (/wardrobe_fabric/.test(name)) {
      // Fitted outfits carry their own weave, roughness and sheen settings in the GLB.
      o.material=m.isMeshPhysicalMaterial?m.clone():toPhysical(m,{});
      o.material.envMapIntensity=.8;
    } else if (/head|body|skin/.test(name)) {
      // A light natural sheen: skin is slightly oily, so highlights catch the forehead, nose and
      // cheekbones. Roughness comes down from fully matte, and a faint, soft clearcoat adds that
      // second, glossier layer without turning her plastic.
      o.material = toPhysical(m, {
        roughness: 0.66, specularIntensity: 0.7, sheen: 0.35, sheenRoughness: 0.55,
        sheenColor: new THREE.Color(1, 0.62, 0.52), envMapIntensity: 0.85,
        clearcoat: 0.12, clearcoatRoughness: 0.38,
      });
      addSkinScatter(o.material);
    } else {
      // Clothes and shoes: a little fabric sheen at grazing angles.
      o.material = toPhysical(m, { sheen: 0.5, sheenRoughness: 0.8, sheenColor: new THREE.Color(0.3, 0.3, 0.32), envMapIntensity: 0.7 });
    }
    if (o.material !== m) m.dispose();
  });
}

// Rotates a bone by a world-space rotation, keeping the rest of its local transform.
const _p = new THREE.Quaternion();
const _m = new THREE.Quaternion();
// Asleep (only while the bot is offline here), nothing else moves her head: no sway, no following
// voices, no cues or beats. Her head sinks forward and tilts to one side and rises and falls a little
// with each slow breath. Blended in as she drops off and out as she wakes, so it never snaps.
const _sq = new THREE.Quaternion(), _sq2 = new THREE.Quaternion();
function sleepHead(c) {
  const k = c.sleepK > 0 ? smoothstep(c.sleepK) : 0;
  if (k <= 0) return;
  const deg = THREE.MathUtils.degToRad;
  const side = (c.sleepSide ??= Math.random() < 0.5 ? -1 : 1);
  const breath = Math.sin(performance.now() / 1000 * 1.25); // ~12 breaths a minute
  const pitch = deg(22 + 1.6 * breath), roll = deg(12 * side), yaw = deg(5 * side);
  for (const [bone, share] of [[c.bones.Neck, 0.4], [c.bones.Head, 0.6]]) {
    if (!bone || !c.rest.has(bone)) continue;
    _sq.copy(bone.quaternion);
    bone.quaternion.copy(c.rest.get(bone));
    rotateWorld(bone, _sq2.setFromEuler(_e.set(pitch * share, yaw * share, roll * share, 'YXZ')));
    bone.quaternion.copy(_sq.slerp(bone.quaternion, k));
  }
}
function rotateWorld(bone, worldRot) {
  bone.parent.getWorldQuaternion(_p);
  _m.copy(_p).invert().multiply(worldRot).multiply(_p);
  bone.quaternion.premultiply(_m);
}

// Ported from GlbViewControl.BuildArmPose: measure where each arm points and rotate it to hang
// down, rather than trusting per-rig Euler angles. Then a slight elbow bend so it looks relaxed.
function poseArms(c) {
  const chains = [
    ['LeftArm', 'LeftForeArm', 'LeftHand'],
    ['RightArm', 'RightForeArm', 'RightHand'],
  ];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const aim = (bone, child, wanted) => {
    c.root.updateMatrixWorld(true);
    bone.getWorldPosition(a);
    child.getWorldPosition(b);
    const dir = b.sub(a).normalize();
    if (dir.dot(wanted) > 0.9999) return;
    rotateWorld(bone, new THREE.Quaternion().setFromUnitVectors(dir, wanted));
  };
  for (const [arm, fore, hand] of chains) {
    const B = c.bones;
    if (!B[arm] || !B[fore]) continue;
    c.root.updateMatrixWorld(true);
    B[arm].getWorldPosition(a);
    B[fore].getWorldPosition(b);
    const out = Math.sign(b.x - a.x) || 1; // which side this arm is on
    aim(B[arm], B[fore], new THREE.Vector3(0.16 * out, -1, 0.05).normalize());
    if (B[hand]) aim(B[fore], B[hand], new THREE.Vector3(0.1 * out, -1, 0.22).normalize());
  }
  c.root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------- camera framing

// Face: a close-up of whoever you're talking to. Upper and full body: everyone, as a group shot.
let camTween = null;
function frame(kind, instant = false) {
  opts.frame = kind;
  save();
  document.querySelectorAll('#framing button').forEach((b) => b.classList.toggle('on', b.dataset.frame === kind));
  const ready = cast.filter((c) => c.model);
  if (!ready.length) return;
  const heads = ready.map((c) => (c.bones.Head ?? c.model).getWorldPosition(new THREE.Vector3()));
  // Distance that fits a span of `tall` x `wide` metres in the visible area (left of the panel).
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const visibleAspect = camera.view ? camera.view.width / camera.view.height : camera.aspect;
  const fit = (tall, wide) => Math.max(tall / 2 / tan, wide / 2 / (tan * visibleAspect));
  const xs = heads.map((p) => p.x);
  const spread = (Math.max(...xs) - Math.min(...xs))/viewSettings.scale;
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const topY = Math.max(...heads.map((p) => p.y));
  const tallest = Math.max(...ready.map((c) => c.height));
  let target, dist;
  if (kind === 'eyes') {
    // Eyes only: the eye line sits a little above the head bone; a band just tall enough for both eyes.
    const head = (current?.model ? current.bones.Head ?? current.model : ready[0].bones.Head ?? ready[0].model).getWorldPosition(new THREE.Vector3());
    target = head.add(new THREE.Vector3(0, 0.085*viewSettings.scale, 0));
    dist = fit(0.12, 0.2);
  } else if (kind === 'face') {
    const head = (current?.model ? current.bones.Head ?? current.model : ready[0].bones.Head ?? ready[0].model).getWorldPosition(new THREE.Vector3());
    target = head.add(new THREE.Vector3(0, 0.06*viewSettings.scale, 0));
    dist = fit(0.36, 0.3);
  } else if (kind === 'bust') {
    target = new THREE.Vector3(midX, topY - 0.16*viewSettings.scale, 0);
    dist = fit(0.85, (ready.length > 1 ? 1.05 : 0.65) + spread); // a group needs room for shoulders and hair
  } else {
    target = new THREE.Vector3(midX, tallest*viewSettings.scale / 2, 0);
    dist = fit(tallest * 1.12, 0.8 + spread);
  }
  dist/=viewSettings.zoom;
  const pos = target.clone().add(new THREE.Vector3(0, 0.03, dist));
  if (instant) {
    controls.target.copy(target);
    camera.position.copy(pos);
    controls.update();
    return;
  }
  camTween = { t: 0, fromT: controls.target.clone(), fromP: camera.position.clone(), toT: target, toP: pos };
}

// ---------------------------------------------------------------- face: one weight per target per frame

const add = (c, name, w) => { if (w > 0.0005) c.weights.set(name, (c.weights.get(name) || 0) + w); };
function applyWeights(c) {
  // Every expression shape glides to its target (speech and blinks keep their own timing).
  smoothShapes(c, c.weights, c.dt ?? 1 / 60);
  for (const name of c.weights.keys()) c.managed.add(name);
  for (const name of c.managed) {
    const w = clamp(c.weights.get(name) || 0);
    for (const { mesh, index } of c.morphs.get(name) ?? []) mesh.morphTargetInfluences[index] = w;
  }
  c.weights.clear();
}

// Her pupils, every frame: how near what she's looking at is, how hard she's thinking, and what she
// feels (avatar-pupils.js has the why).
function updatePupils(c, dt, now) {
  const u = c.model?.userData.pupil;
  if (!u) return;
  const light = 0.55; // the studio: soft, even light
  const near = c.eyes && now < c.eyes.awayUntil ? 0.15 : 0.85; // off into the distance, or at you
  const effort = (thinker === c ? 0.7 : 0) + (c.cue && ['thinking', 'recalling', 'searching'].includes(c.cue.kind) ? 0.6 : 0);
  c.pupilNow = easePupil(c.pupilNow ?? 1, pupilTarget({ light, near, effort: Math.min(1, effort), feel: c.feel?.now ?? {}, t: now / 1000 }), dt);
  u.value = window.amyPupilOverride ?? c.pupilNow;
}
// For checking from the browser console: amyPupils() reads them; amyPupilOverride = 1.6 forces a size.
window.amyPupils = () => cast.map((c) => ({ name: c.name, eyesFound: Boolean(c.model?.userData.pupil), size: c.pupilNow }));
// amyEyes(): where she's looking right now and whether her model has eye bones to turn.
window.amyEyes = () => cast.filter((c) => c.main).map((c) => ({ x: +(c.eyeTurn?.x ?? 0).toFixed(3), y: +(c.eyeTurn?.y ?? 0).toFixed(3), eyeBones: Boolean(c.bones?.LeftEye && c.bones?.RightEye), lookingAway: Boolean(c.eyes && performance.now() < c.eyes.awayUntil) }));
// amySleep('deep') shows her asleep in that stage (light, deep, rem, stirring), amySleep(false) awake again.
// Plays one of her moves by name (checking a fidget by eye): amyPlay('neck_stretch'), amyPlay('settle', 5000).
window.amyPlay = (name, ms = 0) => { const c = cast.find((x) => x.main); if (!c || !GESTURE_DEFS[name]) return `no move called ${name}`; playGesture(c, name, 0, ms); return `playing ${name}`; };
window.amySleep = (stage = 'deep') => { for (const c of cast) if (c.main) setSleep(c, { asleep: Boolean(stage), stage: stage || null }); return stage; };

// Her sleep, from the server. Waking (asleep -> awake): heavy eyes that clear over the next minutes.
let sleepNow = null;
function setSleep(c, sl) {
  const was = c.sleep?.asleep;
  // Settling in to sleep counts: her eyes close as she lies down, not minutes later when she's under.
  c.sleep = { asleep: Boolean(sl.asleep || sl.settling), stage: sl.asleep ? (sl.stage ?? null) : 'drifting off' };
  if (!sl.asleep && sl.groggy > 0) c.grog = Math.max(c.grog ?? 0, sl.groggy);
  if (was && !sl.asleep) c.grog = Math.max(c.grog ?? 0, 0.8);
}

// The bot going offline: she falls asleep (eyes drift shut). Coming back online: she wakes, slowly,
// heavy-eyed, with a sigh. A blip under a few seconds doesn't count.
let offlineTimer = null, botOffline = false;
function fallOffline() {
  clearTimeout(offlineTimer);
  botOffline = true;
  for (const c of cast) if (c.main) c.offline = true;
}
function wentOffline() {
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(fallOffline, 1500);
}
function cameOnline() {
  clearTimeout(offlineTimer);
  botOffline = false;
  for (const c of cast) if (c.main && c.offline) { c.offline = false; c.grog = Math.max(c.grog ?? 0, 0.85); setTimeout(() => playGesture(c, 'sigh'), 1200); }
}
// Asleep (the server's sleep cycle says when and which stage): her eyes drift shut over a few
// seconds and stay shut, her face goes slack, and her breathing slows and deepens. In deep sleep her
// jaw drops a touch; in REM her eyes dart under the lids and her face twitches with the dream;
// between cycles she stirs. Woken, her eyes come open heavy-lidded and clear over the next minutes.
function updateSleep(c, dt) {
  const sl = c.sleep;
  const speaking = c.lips.speechActive;
  const asleep = !speaking && Boolean(sl?.asleep || c.offline);
  if (speaking) c.sleepK = 0;
  c.sleepK = Math.max(0, Math.min(1, (c.sleepK ?? 0) + (asleep ? dt / (c.offline ? 1.5 : 4) : -dt / 1.5)));
  if (c.grog > 0) { c.grog = Math.max(0, c.grog - dt / 600); for (const e of ['eyeBlinkLeft', 'eyeBlinkRight']) c.weights.set(e, Math.max(c.weights.get(e) || 0, 0.45 * c.grog)); }
  if (c.sleepK <= 0) return;
  const k = smoothstep(c.sleepK), st = sl?.stage;
  for (const eye of ['eyeBlinkLeft', 'eyeBlinkRight']) c.weights.set(eye, Math.max(c.weights.get(eye) || 0, k));
  for (const s of ['browDownLeft', 'browDownRight', 'browInnerUp', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'mouthSmileLeft', 'mouthSmileRight']) if (c.weights.has(s)) c.weights.set(s, c.weights.get(s) * (1 - k));
  c.fx.breath *= 1 + k * (st === 'deep' ? 1.2 : 0.6);
  c.fx.motion *= 1 - 0.8 * k;
  if (!asleep) return;
  if (st === 'deep') add(c, 'jawOpen', 0.06 * k);
  const z = (c.dream ??= { t: 0, x: 0, y: 0, next: 0, twitch: 0, stir: 0 });
  z.t += dt;
  if (st !== 'rem' && z.t > z.next) { // light or deep sleep: an occasional slow drift and a small flutter of the lids
    z.x = (Math.random() - 0.5) * 0.9; z.y = (Math.random() - 0.5) * 0.4;
    z.next = z.t + 3 + Math.random() * 6;
    if (Math.random() < 0.3) z.twitch = 0.6;
  }
  if (st === 'rem' && z.t > z.next) { // a quick dart of the eyes under her lids, in bursts
    z.x = (Math.random() - 0.5) * 2; z.y = (Math.random() - 0.5) * 0.8;
    z.next = z.t + (Math.random() < 0.7 ? 0.15 + Math.random() * 0.35 : 1.5 + Math.random() * 4);
    if (Math.random() < 0.08) z.twitch = 1;
  }
  if (st !== 'rem') { z.x *= 1 - Math.min(1, dt * 1.5); z.y *= 1 - Math.min(1, dt * 1.5); } // drifts back slowly
  const look = 0.35 * k;
  add(c, z.x > 0 ? 'eyeLookOutLeft' : 'eyeLookInLeft', Math.abs(z.x) * look); add(c, z.x > 0 ? 'eyeLookInRight' : 'eyeLookOutRight', Math.abs(z.x) * look);
  add(c, z.y > 0 ? 'eyeLookUpLeft' : 'eyeLookDownLeft', Math.abs(z.y) * look); add(c, z.y > 0 ? 'eyeLookUpRight' : 'eyeLookDownRight', Math.abs(z.y) * look);
  if (z.twitch > 0) { z.twitch = Math.max(0, z.twitch - dt * 2.5); const w = Math.sin(z.twitch * Math.PI) * 0.35; add(c, 'browInnerUp', w); add(c, 'mouthLeft', w * 0.4); }
  if (st === 'stirring' && Math.random() < dt / 20) z.stir = 1; // a shift and a deeper breath
  if (z.stir > 0) { z.stir = Math.max(0, z.stir - dt / 3); const w = Math.sin(z.stir * Math.PI); c.fx.roll += 6 * w; c.fx.breath += 2 * w; add(c, 'mouthPressLeft', 0.2 * w); add(c, 'mouthPressRight', 0.2 * w); }
}

// Blink (BlinkDriver): fast close, slower open, random interval, sometimes a double blink.
const CLOSE_MS = 90, OPEN_MS = 170;
function updateBlink(c, ms) {
  if (!opts.blink) return;
  const blink = c.blink;
  if (blink.elapsed >= 0) {
    blink.elapsed += ms;
    if (blink.elapsed >= CLOSE_MS + OPEN_MS) {
      blink.elapsed = -1;
      blink.until = blink.double ? 120 : 2000 + Math.random() * 4000;
      blink.double = false;
      return;
    }
    const w = blink.elapsed <= CLOSE_MS ? smoothstep(blink.elapsed / CLOSE_MS) : smoothstep(1 - (blink.elapsed - CLOSE_MS) / OPEN_MS);
    add(c, 'eyeBlinkLeft', w);
    add(c, 'eyeBlinkRight', w);
    return;
  }
  blink.until -= ms;
  if (blink.until <= 0) {
    blink.elapsed = 0;
    blink.double = Math.random() < 0.18;
    beat('blink', c.id);
  }
}

// Gaze (GazeDriver): eyes ease toward a point on screen, measured from the face. That point is
// the pointer, or, while someone else is talking or thinking, that person's face.
// "In"/"out" are relative to the nose, so the two eyes take opposite targets horizontally.
const _v = new THREE.Vector3();
function onScreen(c, out = new THREE.Vector2()) {
  (c.bones.Head ?? c.model).getWorldPosition(_v).add(new THREE.Vector3(0, 0.07, 0)).project(camera);
  return out.set(((_v.x + 1) / 2) * innerWidth, ((1 - _v.y) / 2) * innerHeight);
}
// Thinking cues: moments in her mind, sent by the server as they happen. Each one is a pose a person
// makes at that moment: eyes and head drift up and aside while working something out, further aside
// while searching memory, down while reading, then back with a lift of the brows when it comes
// together. Degrees: +pitch is chin down. gx/gy are eye targets (-1..1). The side is picked per cue,
// the way a person favours one side for a stretch of thought.
const CUE_POSES = {
  listening: { yaw: 0, pitch: 1.5, roll: 5, gx: 0, gy: 0, rise: 0.35, hold: 2.5, fall: 1.2, feel: { curious: 0.2 } },
  thinking: { yaw: 8, pitch: -5, roll: 4, gx: 0.5, gy: -0.5, rise: 0.5, hold: 2.2, fall: 1.0, feel: { pensive: 0.45 } },
  recalling: { yaw: 12, pitch: -4, roll: 2, gx: 0.65, gy: -0.4, rise: 0.5, hold: 2.8, fall: 1.0, feel: { pensive: 0.35 } },
  searching: { yaw: 5, pitch: 6, roll: 1, gx: 0.25, gy: 0.45, rise: 0.5, hold: 3.0, fall: 1.0, feel: { curious: 0.25 } },
  realized: { yaw: 0, pitch: -3, roll: -2, gx: 0, gy: 0, rise: 0.25, hold: 1.0, fall: 1.0, feel: { surprised: 0.18, joy: 0.15 }, nod: true },
};
function setCue(c, kind, strength = 1) {
  if (!c || !CUE_POSES[kind]) return;
  const keepSide = c.cue && ['thinking', 'recalling', 'searching'].includes(c.cue.kind) && ['thinking', 'recalling', 'searching'].includes(kind);
  c.cue = { kind, strength, start: performance.now(), side: keepSide ? c.cue.side : Math.random() < 0.5 ? 1 : -1 };
}
// The active cue's pose this frame, scaled by its envelope (0 when none).
function cueNow(c, now = performance.now()) {
  const cue = c.cue;
  const pose = cue && CUE_POSES[cue.kind];
  if (!pose) return null;
  const t = (now - cue.start) / 1000;
  const total = pose.rise + pose.hold + pose.fall;
  if (t >= total) { c.cue = null; return null; }
  const env = (t < pose.rise ? smoothstep(t / pose.rise) : t < pose.rise + pose.hold ? 1 : smoothstep(1 - (t - pose.rise - pose.hold) / pose.fall)) * cue.strength;
  const nod = pose.nod ? Math.sin(Math.min(1, t / 0.6) * Math.PI) * 4 : 0; // one small nod as it lands
  return { env, t, pose, yaw: pose.yaw * cue.side * env, pitch: pose.pitch * env + nod, roll: pose.roll * cue.side * env, gx: pose.gx * cue.side * env, gy: pose.gy * env };
}
// A feeling arriving with a sentence moves the head for a moment too, in that feeling's direction
// (amused tilts, sad drops, surprised lifts), stronger than the slow pose it settles into.
const BEAT_S = 1.3;
function beatNow(c, now = performance.now()) {
  const pulse = c.feel?.pulse;
  if (!pulse) return null;
  const t = (now - pulse.start) / 1000;
  if (t < 0 || t > BEAT_S) return null;
  const x = EXPRESSIONS[pulse.name];
  if (!x) return null;
  const v = Math.min(1, c.feel.now[pulse.name] ?? c.feel.target[pulse.name] ?? 0.5);
  const bump = Math.sin(Math.PI * (t / BEAT_S));
  const side = pulse.side === 'L' ? -1 : 1;
  return { pitch: x.pitch * 1.4 * v * bump, yaw: x.yaw * side * v * bump, roll: (x.roll || 0) * 1.6 * side * v * bump };
}

const _me = new THREE.Vector2(), _them = new THREE.Vector2();
function updateGaze(c, dt, now) {
  const gaze = c.gaze;
  // Whoever is saying a line in the Discord call (her, or a peer like Nova) counts as talking too.
  const other = speaker && speaker !== c ? speaker : thinker && thinker !== c ? thinker : cast.find((x) => x !== c && x.lips?.discord && x.lips.speechActive) ?? null;
  c.watching = Boolean(other && opts.gaze);
  const mode=performanceState.gaze;
  const directed={camera:[0,0],left:[-.65,0],right:[.65,0],up:[0,-.5],down:[0,.5]}[mode];
  if(directed){[gaze.tx,gaze.ty]=directed;c.watching=false;}
  else if (!opts.gaze || !c.bones.Head) { gaze.tx = gaze.ty = 0; }
  else if (other?.model) {
    // Look at whoever is talking. Screen distance understates a turn toward someone beside you,
    // so the head adds most of the turn (see updateHead).
    onScreen(c, _me);
    onScreen(other, _them);
    gaze.tx = clamp((_them.x - _me.x) / 300, -1, 1);
    gaze.ty = clamp((_them.y - _me.y) / 520, -1, 1);
  } else {
    // Nobody to watch: her eyes are her own. She looks at whoever she's with (the camera) much of the
    // time, but not always: when she isn't the one talking she lets her eyes wander off now and then
    // (to the side, down, out somewhere) and comes back, the way people do.
    const e = (c.eyes ??= { awayUntil: 0, nextAway: now + 3000, ax: 0, ay: 0 });
    if (now > e.nextAway && speaker !== c && performanceState.gaze !== 'camera') {
      e.ax = (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.45);
      e.ay = (Math.random() - 0.35) * 0.5;
      e.awayUntil = now + 900 + Math.random() * 2200;
      e.nextAway = now + 3500 + Math.random() * 7000;
      beat('glance', c.id);
    }
    const away = now < e.awayUntil;
    gaze.tx = away ? e.ax : 0;
    gaze.ty = away ? e.ay : 0;
  }
  // Fixational eye movements: real eyes never sit still. Every fraction of a second they make a tiny
  // jump (a microsaccade) to a slightly different point, and hold there. Always on, whatever she's
  // looking at, so her eyes are alive even while she holds your gaze.
  const mic = (c.microSaccade ??= { x: 0, y: 0, next: 0 });
  if (now > mic.next) {
    mic.x = (Math.random() - 0.5) * 0.09;
    mic.y = (Math.random() - 0.5) * 0.06;
    mic.next = now + 250 + Math.random() * 900;
  }
  gaze.tx = clamp(gaze.tx + mic.x, -1, 1);
  gaze.ty = clamp(gaze.ty + mic.y, -1, 1);
  // What she's thinking moves the eyes first (up and aside to work something out, down to read),
  // even over a chosen gaze: nobody holds eye contact while searching their memory.
  const cueG = cueNow(c, now);
  if (cueG) { gaze.tx = clamp(gaze.tx * (1 - cueG.env) + cueG.gx, -1, 1); gaze.ty = clamp(gaze.ty * (1 - cueG.env) + cueG.gy, -1, 1); }
  // Feelings pull the eyes too: shy looks down and away, thinking looks up.
  const fx = c.fx;
  const k = ease(0.30, dt);
  gaze.x += (clamp(gaze.tx + (directed ? 0 : fx.gx), -1, 1) - gaze.x) * k;
  gaze.y += (clamp(gaze.ty + (directed ? 0 : fx.gy), -1, 1) - gaze.y) * k;
  // The head follows the eyes through a slower filter so it glides to the target instead of
  // snapping with them (a glance: eyes lead, then the head catches up and eases off).
  const kH = ease(0.07, dt);
  gaze.hx += (clamp(gaze.tx + (directed ? 0 : fx.gx), -1, 1) - gaze.hx) * kH;
  gaze.hy += (clamp(gaze.ty + (directed ? 0 : fx.gy), -1, 1) - gaze.hy) * kH;
  if (fx.gaze) { gaze.x = fx.gaze.x; gaze.y = fx.gaze.y; } // eye roll: eyes only, head stays put

  const MAX = 0.55;
  const h = Math.abs(gaze.x) * MAX, v = Math.abs(gaze.y) * MAX;
  if (gaze.x > 0) { add(c, 'eyeLookOutLeft', h); add(c, 'eyeLookInRight', h); }
  else { add(c, 'eyeLookInLeft', h); add(c, 'eyeLookOutRight', h); }
  if (gaze.y > 0) { add(c, 'eyeLookDownLeft', v); add(c, 'eyeLookDownRight', v); }
  else { add(c, 'eyeLookUpLeft', v); add(c, 'eyeLookUpRight', v); }
  c.eyeTurn = { x: gaze.x, y: gaze.y }; // the eye bones turn with it (applyEyes, after head motion)
}

// The eyeballs themselves turn (when the model has eye bones), not just the eyelid shapes: up to about
// 20 degrees side to side and 13 up and down, about her head's own axes, so it reads at any distance.
const _eq = new THREE.Quaternion(), _ea = new THREE.Vector3(), _eb = new THREE.Vector3();
function applyEyes(c) {
  const t = c.eyeTurn, B = c.bones;
  if (!t || !B.Head || !B.LeftEye || !B.RightEye) return;
  c.root.getWorldQuaternion(_eq); // her body's axes (head bone axes differ between rigs)
  _ea.set(0, 1, 0).applyQuaternion(_eq); // up
  _eb.set(1, 0, 0).applyQuaternion(_eq); // toward her left (she faces +z, her left is +x)
  // gaze.x > 0 is toward her left (matching eyeLookOutLeft), gaze.y > 0 is down
  const yaw = THREE.MathUtils.degToRad(20) * t.x, pitch = THREE.MathUtils.degToRad(13) * t.y;
  for (const eye of [B.LeftEye, B.RightEye]) {
    if (!c.rest.has(eye)) c.rest.set(eye, eye.quaternion.clone());
    rotateWorld(eye, new THREE.Quaternion().setFromAxisAngle(_ea, yaw));
    rotateWorld(eye, new THREE.Quaternion().setFromAxisAngle(_eb, pitch));
  }
}

// ---------------------------------------------------------------- dancing with real moves
// Bodies converted with dances baked in (scripts/rocketbox-to-glb.py: dance_cool, dance_neutral, dance_aggressive,
// dance_silly: motion capture recorded in place) dance those to the music instead of swaying. The song decides
// which: big and loud brings out the aggressive one, a groove the cool or silly one, quiet the neutral one; she
// moves on to another every 32 beats or when the song's energy changes, blending between them, at the song's
// tempo. Her face, eyes and lips stay her (the clips don't touch them), and she eases in and out of it.
const DANCE_CLIP_BPM = 115; // the tempo the captures move at, near enough
function setupDanceClips(c, animations) {
  c.danceClips = null;
  const clips = (animations || []).filter((a) => /^dance_/i.test(a.name));
  if (!clips.length) return;
  const mixer = new THREE.AnimationMixer(c.model);
  const bones = new Set();
  for (const clip of clips) for (const t of clip.tracks) { const o = c.model.getObjectByName(t.name.split('.')[0]); if (o?.isBone) bones.add(o); }
  const rest = [...bones].map((b) => [b, b.quaternion.clone(), b.position.clone()]);
  const actions = Object.fromEntries(clips.map((clip) => [clip.name.replace(/^dance_/i, '').toLowerCase(), mixer.clipAction(clip)]));
  c.danceClips = { mixer, actions, rest, current: null, since: 0, fading: 0 };
}
function pickDance(d, energy, not) {
  const pool = energy > 0.72 ? ['aggressive', 'cool', 'silly'] : energy > 0.45 ? ['cool', 'silly', 'neutral'] : ['neutral', 'cool'];
  const have = pool.filter((n) => d.actions[n] && n !== not);
  return have[Math.floor(Math.random() * have.length)] ?? Object.keys(d.actions).find((n) => n !== not) ?? Object.keys(d.actions)[0];
}
// After the frame's reset to rest and before her head and face are layered on: the dance sets her body.
function updateDanceClips(c, dt) {
  const d = c.danceClips;
  if (!d) return;
  for (const [b, q, p] of d.rest) { b.quaternion.copy(q); b.position.copy(p); }
  const on = (c.danceLevel ?? 0) > 0.3;
  if (on && !d.current) {
    d.current = pickDance(d, c.danceEnergy ?? 0.5);
    d.actions[d.current].reset().fadeIn(0.8).play();
    d.since = 0; d.fading = 0;
  } else if (on) {
    d.since += dt;
    const wants = pickDance(d, c.danceEnergy ?? 0.5);
    const poolChanged = !(['aggressive', 'cool', 'silly', 'neutral'].includes(d.current)) || ((c.danceEnergy ?? 0.5) > 0.72) !== (d.current === 'aggressive');
    if (d.since > (c.danceBeatSec ?? 0.5) * 32 || (poolChanged && d.since > 4)) {
      const next = wants === d.current ? pickDance(d, c.danceEnergy ?? 0.5, d.current) : wants;
      if (next && next !== d.current) {
        const to = d.actions[next].reset().play();
        d.actions[d.current].crossFadeTo(to, 1.2, false);
        d.current = next;
      }
      d.since = 0;
    }
  } else if (d.current) {
    d.actions[d.current].fadeOut(0.8);
    d.current = null; d.fading = 0.8;
  }
  if (!d.current && d.fading <= 0) return;
  if (!d.current) { d.fading -= dt; if (d.fading <= 0) { d.mixer.stopAllAction(); return; } }
  d.mixer.timeScale = Math.max(0.75, Math.min(1.35, (c.danceBpm || DANCE_CLIP_BPM) / DANCE_CLIP_BPM));
  d.mixer.update(dt);
}

// Head motion (HeadMotionDriver): layered sines at unrelated periods plus occasional glances.
// The head also turns toward where the eyes are looking, and nods with speech.
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
function updateHead(c, dt) {
  const B = c.bones, fx = c.fx, s = c.head;
  for (const [bone, q] of c.rest) bone.quaternion.copy(q);
  updateDanceClips(c, dt); // a real dance, if her body has them and the music's on: her body first, then the rest on top
  s.t += dt;
  const t = s.t;

  // Breathing: a slow, tiny lift of the chest (deeper during a sigh).
  const breath = Math.sin(t * 1.6) * THREE.MathUtils.degToRad(0.7) * fx.breath;
  if (B.Spine2) rotateWorld(B.Spine2, _q.setFromEuler(_e.set(-breath, 0, 0)));

  // Shrugs and laughs lift the shoulders. Each shoulder bone points outward, so raising its far
  // end is a turn about Z in opposite directions on each side.
  // Each shoulder can also move on its own (a shoulder roll), on top of both lifting together.
  const liftL = fx.shoulders + fx.shoulderL, liftR = fx.shoulders + fx.shoulderR;
  if (liftL > 0.001 && B.LeftShoulder) rotateWorld(B.LeftShoulder, _q.setFromEuler(_e.set(0, 0, THREE.MathUtils.degToRad(9) * liftL)));
  if (liftR > 0.001 && B.RightShoulder) rotateWorld(B.RightShoulder, _q.setFromEuler(_e.set(0, 0, -THREE.MathUtils.degToRad(9) * liftR)));
  // Swaying her hips (dancing): the whole body rocks a little from the hips.
  if (Math.abs(fx.hipRoll) > 0.001 && B.Hips) rotateWorld(B.Hips, _q.setFromEuler(_e.set(0, 0, THREE.MathUtils.degToRad(fx.hipRoll))));
  // Shifting her weight and settling: a small turn and lean of the torso (body engine fidgets).
  if ((Math.abs(fx.spineYaw) > 0.001 || Math.abs(fx.spineRoll) > 0.001) && (B.Spine1 || B.Spine)) {
    rotateWorld(B.Spine1 ?? B.Spine, _q.setFromEuler(_e.set(0, THREE.MathUtils.degToRad(fx.spineYaw), THREE.MathUtils.degToRad(fx.spineRoll))));
  }

  const deg = THREE.MathUtils.degToRad;
  // Turning to face whoever's talking takes the head, not just the eyes. The amplitude itself is
  // eased so a watcher appearing/disappearing doesn't jerk the head.
  const turnT = deg(performanceState.gaze === 'ambient' ? (c.watching ? 26 : 12) : 24);
  s.turn += (turnT - s.turn) * ease(0.10, dt);
  const turn = s.turn;
  // Feeling and gesture poses apply even with idle motion off.
  const poseP = deg(fx.pitch), poseY = deg(fx.yaw), poseR = deg(fx.roll);
  if (!opts.head) {
    // Idle sway off: thinking cues and feeling beats still move her, since they're her, not idling.
    const cq = cueNow(c), bt = beatNow(c);
    const y = poseY + (c.watching ? c.gaze.hx * turn : 0) + deg((cq?.yaw ?? 0) + (bt?.yaw ?? 0));
    const pp = poseP + deg((cq?.pitch ?? 0) + (bt?.pitch ?? 0)), rr = poseR + deg((cq?.roll ?? 0) + (bt?.roll ?? 0));
    const nP = deg(fx.neckPitch), nY = deg(fx.neckYaw);
    if (B.Neck) rotateWorld(B.Neck, _q.setFromEuler(_e.set(pp * 0.4 + nP * 0.6, y * 0.4 + nY * 0.6, rr * 0.4, 'YXZ')));
    if (B.Head) rotateWorld(B.Head, _q.setFromEuler(_e.set(pp * 0.6 + nP * 0.4, y * 0.6 + nY * 0.4, rr * 0.6, 'YXZ')));
    return;
  }
  let yaw = 0.55 * Math.sin(t * 0.23) + 0.3 * Math.sin(t * 0.61 + 1.7) + 0.15 * Math.sin(t * 1.3 + 0.4);
  let pitch = 0.5 * Math.sin(t * 0.19 + 2.1) + 0.32 * Math.sin(t * 0.53 + 0.9) + 0.18 * Math.sin(t * 1.1 + 2.7);
  const roll = 0.6 * Math.sin(t * 0.17 + 0.6) + 0.4 * Math.sin(t * 0.44 + 1.2);

  // The sway above is only the small, constant motion of a living body (breath, balance), kept low.
  // Real head movement comes from what's going on in her mind: thinking cues and feeling beats.
  if (performanceState.gaze === 'camera') { yaw = 0; pitch = 0; }
  const SWAY = 0.35;
  const cueH = cueNow(c), beat = beatNow(c);
  const cueY = deg((cueH?.yaw ?? 0) + (beat?.yaw ?? 0)), cueP = deg((cueH?.pitch ?? 0) + (beat?.pitch ?? 0)), cueR = deg((cueH?.roll ?? 0) + (beat?.roll ?? 0));

  const speak = speaker === c ? 1.45 : 1;
  const i = opts.intensity * speak * fx.motion;
  const y = deg(yaw * 3.2 * i * SWAY) + c.gaze.hx * turn + poseY + cueY;
  const p = deg(pitch * 2 * i * SWAY) + c.gaze.hy * deg(4) + c.lips.level * deg(2.2) * opts.intensity + poseP + cueP;
  const r = deg(roll * 1.4 * i * SWAY) + poseR + cueR;

  // Shared between neck and head so the bend isn't all at one joint. A yes or no is driven mostly
  // from the neck, the way a real one is.
  const nP = deg(fx.neckPitch), nY = deg(fx.neckYaw);
  if (B.Neck) rotateWorld(B.Neck, _q.setFromEuler(_e.set(p * 0.4 + nP * 0.6, y * 0.4 + nY * 0.6, r * 0.4, 'YXZ')));
  if (B.Head) rotateWorld(B.Head, _q.setFromEuler(_e.set(p * 0.6 + nP * 0.4, y * 0.6 + nY * 0.4, r * 0.6, 'YXZ')));
}

// ---------------------------------------------------------------- feelings

// There are no presets. The server keeps each character's emotional state as a blend of feelings
// (0..1 each), updated from the conversation, and the face is the weighted sum of every feeling's
// expression. Each expression also biases head pose (degrees; +pitch is chin down), gaze, how much
// they move, and how often they blink, so "sad" droops and looks down while "excited" is wide-eyed.
const LR = (base, v) => ({ [base + 'Left']: v, [base + 'Right']: v });
const X = (face, more = {}) => ({ face, pitch: 0, yaw: 0, roll: 0, gx: 0, gy: 0, motion: 1, blink: 1, ...more });
const EXPRESSIONS = {
  calm: X({ ...LR('mouthSmile', 0.08) }, { motion: 0.85 }),
  joy: X({ ...LR('mouthSmile', 0.62), ...LR('cheekSquint', 0.38), ...LR('eyeSquint', 0.15), browInnerUp: 0.1 }, { pitch: -1.5, motion: 1.2 }),
  amused: X({ mouthSmileLeft: 0.55, mouthSmileRight: 0.42, ...LR('cheekSquint', 0.45), ...LR('eyeSquint', 0.35), ...LR('mouthDimple', 0.2) }, { roll: 3, pitch: -1, motion: 1.25 }),
  fond: X({ ...LR('mouthSmile', 0.3), ...LR('eyeSquint', 0.12), ...LR('eyeBlink', 0.12), browInnerUp: 0.18 }, { roll: 4, pitch: 1.5, motion: 0.9 }),
  playful: X({ mouthSmileLeft: 0.48, mouthSmileRight: 0.18, browOuterUpLeft: 0.42, eyeSquintRight: 0.22, mouthLeft: 0.1 }, { roll: -5, yaw: 3, motion: 1.2 }),
  smug: X({ mouthSmileLeft: 0.5, mouthPressRight: 0.22, ...LR('eyeSquint', 0.3), browDownRight: 0.15, ...LR('eyeBlink', 0.1) }, { pitch: -4, roll: 2 }),
  excited: X({ ...LR('mouthSmile', 0.7), browInnerUp: 0.4, ...LR('browOuterUp', 0.45), ...LR('eyeWide', 0.35), jawOpen: 0.06 }, { pitch: -2, motion: 1.6, blink: 1.3 }),
  flirty: X({ mouthSmileLeft: 0.36, mouthSmileRight: 0.24, ...LR('eyeBlink', 0.22), browOuterUpLeft: 0.15, ...LR('cheekSquint', 0.12) }, { roll: 6, pitch: 2.5, gx: -0.22, gy: 0.05, motion: 0.9 }),
  confident: X({ ...LR('mouthSmile', 0.2), ...LR('eyeSquint', 0.1), ...LR('browDown', 0.06) }, { pitch: -3, motion: 0.9 }),
  curious: X({ browInnerUp: 0.3, browOuterUpLeft: 0.45, ...LR('eyeWide', 0.15), mouthPucker: 0.08 }, { roll: 7, yaw: 2, pitch: 1 }),
  pensive: X({ browInnerUp: 0.2, browDownLeft: 0.25, mouthPressLeft: 0.25, mouthRollLower: 0.2, mouthLeft: 0.15 }, { pitch: -2, gx: -0.4, gy: -0.45, motion: 0.7 }),
  confused: X({ browDownLeft: 0.45, browOuterUpRight: 0.4, browInnerUp: 0.15, mouthLeft: 0.2, mouthPressRight: 0.2, eyeSquintLeft: 0.2 }, { roll: -6 }),
  skeptical: X({ browDownLeft: 0.65, browOuterUpRight: 0.6, eyeSquintLeft: 0.45, mouthPressLeft: 0.35, mouthRight: 0.2, mouthSmileRight: 0.12 }, { pitch: -3, roll: 4 }),
  surprised: X({ browInnerUp: 0.7, ...LR('browOuterUp', 0.6), ...LR('eyeWide', 0.55), jawOpen: 0.12, mouthFunnel: 0.1 }, { pitch: -3, motion: 1.2 }),
  worried: X({ browInnerUp: 0.65, ...LR('browDown', 0.1), ...LR('eyeWide', 0.2), ...LR('mouthPress', 0.25), ...LR('mouthStretch', 0.15), ...LR('mouthFrown', 0.1) }, { pitch: 2, gy: 0.1, blink: 1.6 }),
  sad: X({ browInnerUp: 0.6, ...LR('mouthFrown', 0.45), ...LR('mouthPress', 0.15), mouthShrugLower: 0.2, ...LR('eyeBlink', 0.18) }, { pitch: 6, gy: 0.3, motion: 0.6 }),
  embarrassed: X({ ...LR('mouthSmile', 0.25), ...LR('mouthPress', 0.2), ...LR('eyeBlink', 0.2), browInnerUp: 0.25, ...LR('cheekSquint', 0.15) }, { pitch: 6, yaw: -6, gx: -0.35, gy: 0.35, blink: 1.5 }),
  annoyed: X({ ...LR('browDown', 0.45), ...LR('eyeSquint', 0.25), ...LR('mouthPress', 0.35), ...LR('mouthFrown', 0.15), ...LR('noseSneer', 0.1) }, { pitch: -1, motion: 0.9 }),
  frustrated: X({ ...LR('browDown', 0.55), ...LR('browInnerUp', 0.4), ...LR('eyeSquint', 0.3), ...LR('mouthPress', 0.45), ...LR('mouthFrown', 0.25), ...LR('noseSneer', 0.2) }, { pitch: 1.5, roll: 2, motion: 1.1, gx: -0.15, gy: 0.1 }),
  angry: X({ ...LR('browDown', 1), ...LR('eyeSquint', 0.3), ...LR('noseSneer', 0.55), ...LR('mouthPress', 0.5), ...LR('mouthFrown', 0.4), ...LR('mouthUpperUp', 0.2), jawForward: 0.12 }, { pitch: 4, motion: 1.1, blink: 0.6 }),
  disgusted: X({ ...LR('noseSneer', 0.6), ...LR('mouthUpperUp', 0.45), ...LR('browDown', 0.35), ...LR('eyeSquint', 0.3), ...LR('mouthFrown', 0.25) }, { pitch: -3, yaw: 6 }),
  bored: X({ ...LR('eyeBlink', 0.3), ...LR('mouthPress', 0.1), mouthLeft: 0.2, mouthRollLower: 0.1 }, { roll: -4, gx: 0.3, gy: -0.1, motion: 0.5, blink: 0.7 }),
  tired: X({ ...LR('eyeBlink', 0.45), browInnerUp: 0.2, ...LR('mouthFrown', 0.1), jawOpen: 0.03 }, { pitch: 5, motion: 0.5, blink: 0.6 }),
  determined: X({ ...LR('browDown', 0.35), ...LR('mouthPress', 0.3), ...LR('eyeSquint', 0.15), jawForward: 0.1 }, { pitch: 1 }),
  scared: X({ browInnerUp: 0.7, ...LR('eyeWide', 0.7), ...LR('mouthStretch', 0.35), jawOpen: 0.08 }, { pitch: 3, motion: 1.3, blink: 1.5 }),
};
const NEGATIVE = ['sad', 'annoyed', 'angry', 'disgusted', 'worried', 'scared', 'tired', 'bored', 'skeptical', 'frustrated'];
const SPEECH_SAFE = /Smile|cheek|eye|brow|nose/; // mouth shapes that would fight lip sync get damped while talking
const HALF_LIFE = 90; // seconds, matching the server

// beat: a new sentence started, so give its strongest feeling a visible push even if the mix is similar.
function setFeelings(c, f, beat = false) {
  if (!c) return;
  c.feel.target = { ...(f || {}) };
  if (beat) {
    const top = Object.entries(c.feel.target).sort((a, b) => b[1] - a[1])[0];
    if (top) c.feel.pulse = { name: top[0], start: performance.now(), pulseAt: performance.now(), side: Math.random() < 0.5 ? 'L' : 'R' };
  }
  if (c === current) renderFeelings();
}

// Lopsided expressions (a smirk, one raised brow) are written for one side. Each time a feeling
// starts, it picks a side at random, so the face doesn't lean the same way all the time.
const mirror = (shape) => shape.replace(/Left|Right/, (m) => (m === 'Left' ? 'Right' : 'Left'));

// The micro-expression driver. The broad feeling blend (updateFeelings) already moves the
// eyebrows to the right pose for whatever she feels; this layer adds a tiny, decaying *impulse*
// right when an expression changes: a quick eyebrow lift/lower and a mouth flick that fades to
// zero, so the face reacts and then settles instead of twitching forever.
const MICRO_PULSE_MS = 700; // the whole micro impulse lasts well under a second
const MICRO_PER = {
  angry: { up: 0.25, down: 0.6, frown: 0.5 },
  annoyed: { up: 0.3, down: 0.45, frown: 0.4 },
  frustrated: { up: 0.2, down: 0.55, frown: 0.45 },
  sad: { up: 0.45, down: 0.1, frown: 0.5 },
  worried: { up: 0.5, down: 0.1, frown: 0.4 },
  surprised: { up: 0.7, down: 0, frown: 0.2 },
  scared: { up: 0.55, down: 0.1, frown: 0.4 },
  confused: { up: 0.4, down: 0.25, frown: 0.2 },
  skeptical: { up: 0.3, down: 0.35, frown: 0.35 },
  joy: { up: 0.35, down: 0, frown: -0.3 },
  amused: { up: 0.3, down: 0, frown: -0.35 },
  excited: { up: 0.55, down: 0, frown: -0.25 },
  flirty: { up: 0.45, down: 0, frown: -0.3 },
  pensive: { up: 0.35, down: 0.1, frown: 0.1 },
  bored: { up: 0, down: 0.2, frown: 0.2 },
  tired: { up: 0.15, down: 0.2, frown: 0.25 },
  determined: { up: 0.2, down: 0.45, frown: -0.2 },
};
function microProfileOf(c) {
  // The strongest feeling whose expression actually drives her face right now.
  let best = null, bestV = 0;
  for (const [name, v] of Object.entries(c.feel.now)) {
    const p = MICRO_PER[name];
    if (p && v > bestV) { best = p; bestV = v; }
  }
  return best ? { ...best, v: bestV } : null;
}
function updateMicro(c, dt, now) {
  if (!opts.expr) return;
  // Only pulse while a beat (a newly received expression) is still recent. No beat: no micro-motion.
  const pulse = c.feel.pulse;
  if (!pulse || pulse.pulseAt === undefined) return;
  const elapsed = now - pulse.start;
  if (elapsed < 0 || elapsed > MICRO_PULSE_MS) return;
  const t = elapsed / MICRO_PULSE_MS;
  const bump = Math.sin(Math.PI * t); // 0 -> 1 -> 0: one clean flick that ends back at zero
  const p = microProfileOf(c);
  if (!p) return;

  // Eyebrows: a single raise-or-lower flick in the mood's direction (down for anger, up for
  // surprise), favouring one side so it reads as a real micro-tell rather than a symmetric twitch.
  const side = pulse.side ?? (pulse.side = Math.random() < 0.5 ? 'L' : 'R');
  const up = 0.18 * p.up * p.v * bump;
  const down = 0.18 * p.down * p.v * bump;
  const ui = up + down * 0.25, ul = side === 'L' ? up : up * 0.55, ur = side === 'R' ? up : up * 0.55;
  add(c, 'browInnerUp', ui);
  add(c, side === 'L' ? 'browOuterUpLeft' : 'browOuterUpRight', ul);
  add(c, side === 'L' ? 'browOuterUpRight' : 'browOuterUpLeft', ur);
  const dl = down * 0.8, dr = down * 0.8;
  add(c, 'browDownLeft', dl);
  add(c, 'browDownRight', dr);

  // Mouth: a faint press/frown or the start of a smile, once, that fades with the beat.
  const mouth = 0.14 * p.frown * p.v * bump;
  add(c, 'mouthFrownLeft', Math.max(0, mouth));
  add(c, 'mouthFrownRight', Math.max(0, mouth));
  add(c, 'mouthSmileLeft', Math.max(0, -mouth));
  add(c, 'mouthSmileRight', Math.max(0, -mouth));
  if (t > 0.65) {
    add(c, 'mouthPressLeft', Math.max(0, 0.3 * p.frown * p.v * (1 - t)));
    add(c, 'mouthPressRight', Math.max(0, 0.3 * p.frown * p.v * (1 - t)));
  }

  // Eyes: a hint of squint or widen following the same beat, then releases.
  const eye = 0.1 * p.v * bump * (p.down > p.up ? -1 : 1);
  if (eye > 0) { add(c, 'eyeWideLeft', eye); add(c, 'eyeWideRight', eye); }
  else { add(c, 'eyeSquintLeft', -eye); add(c, 'eyeSquintRight', -eye); }
}

// ---------------------------------------------------------------- face: one weight per target per frame

// Per-frame effects of feelings and gestures (c.fx), read by gaze, blink and head motion.
function updateFeelings(c, dt) {
  const feel = c.feel;
  const decay = Math.pow(0.5, dt / HALF_LIFE);
  for (const k of Object.keys(feel.target)) if ((feel.target[k] *= decay) < 0.03) delete feel.target[k];
  const goal = { ...feel.target };
  if (thinker === c) goal.pensive = Math.max(goal.pensive || 0, 0.5);
  // The face of the moment in her mind (pensive while working something out, a lift when it lands),
  // blended in only while that cue lasts.
  const cueF = cueNow(c);
  if (cueF) for (const [name, v] of Object.entries(cueF.pose.feel)) goal[name] = Math.max(goal[name] || 0, v * cueF.env);

  const fx = (c.fx = { pitch: 0, yaw: 0, roll: 0, gx: 0, gy: 0, motion: 1, blink: 1, shoulders: 0, breath: 1, gaze: null, neckPitch: 0, neckYaw: 0, yesNo: 0, spineYaw: 0, spineRoll: 0, shoulderL: 0, shoulderR: 0, hipRoll: 0 });
  // Dancing and singing along to whatever's playing (avatar-dance.js); she stops while she talks.
  if (c.main) dance.apply(c, fx, add, dt, Boolean(c.lips?.speechActive));
  if (c.main) playDueFidgets(c);
  const k = ease(0.06, dt);
  for (const name of new Set([...Object.keys(feel.now), ...Object.keys(goal)])) {
    const was = feel.now[name] || 0;
    const v = (feel.now[name] = was + ((goal[name] || 0) - was) * k);
    if (was < 0.1 && (goal[name] || 0) >= 0.1) feel.side[name] = Math.random() < 0.5 ? 1 : -1;
    if (v < 0.005) delete feel.now[name];
  }

  // The strongest feeling leads and the others only colour it. Simply adding every lingering feeling
  // saturates the smile shapes after a few messages, and then nothing visibly changes.
  const names = Object.keys(feel.now).filter((n) => EXPRESSIONS[n]);
  const vmax = Math.max(0.001, ...names.map((n) => feel.now[n]));
  const share = {};
  let total = 0;
  for (const n of names) total += share[n] = feel.now[n] * Math.pow(feel.now[n] / vmax, 1.5);
  const norm = total > 1 ? 1 / total : 1;

  const pulse = feel.pulse && (performance.now() - feel.pulse.start) / 1500;
  if (pulse >= 1) feel.pulse = null;
  const strength = opts.expr * 1.4; // these rigs' face shapes are subtle at their authored range
  const talking = clamp(c.lips.level * 3);
  let negative = 0;
  for (const name of names) {
    const e = EXPRESSIONS[name];
    if (NEGATIVE.includes(name)) negative += feel.now[name];
    const beat = feel.pulse?.name === name ? 1 + 0.45 * Math.sin(Math.PI * Math.min(1, pulse * 1.6)) : 1;
    const w = share[name] * norm * strength * beat;
    const flip = feel.side[name] === -1;
    for (const [shape, amount] of Object.entries(e.face)) {
      add(c, flip ? mirror(shape) : shape, amount * w * (SPEECH_SAFE.test(shape) ? 1 : 1 - 0.55 * talking));
    }
    fx.pitch += e.pitch * w; fx.yaw += e.yaw * w * (flip ? -1 : 1); fx.roll += e.roll * w * (flip ? -1 : 1);
    fx.gx += e.gx * w * (flip ? -1 : 1); fx.gy += e.gy * w;
    fx.motion += (e.motion - 1) * share[name] * norm; fx.blink += (e.blink - 1) * share[name] * norm;
  }
  // A resting smile that fades when they're upset or another expression takes over.
  const rest = opts.restSmile * 0.25 * clamp(1 - negative) * (1 - 0.7 * Math.min(1, total));
  add(c, 'mouthSmileLeft', rest);
  add(c, 'mouthSmileRight', rest);
  fx.motion = Math.max(0.3, fx.motion);
  fx.blink = Math.max(0.4, fx.blink);
}

// One of the named face quirks at level b (0..1): its shapes on the face, its lean on the head.
function quirk(c, name, b, o) {
  for (const [shape, v] of Object.entries(FACE_PRESETS[name] ?? {})) add(c, shape, v * b);
  const lean = FACE_HEAD[name];
  if (lean) { o.roll += lean.roll * b; o.pitch += lean.pitch * b; o.yaw += lean.yaw * b; }
}

// Gestures: short one-off motions, from the model's tags or the Expressions menu.
const bell = (t) => (t < 0.25 ? smoothstep(t / 0.25) : t > 0.7 ? smoothstep((1 - t) / 0.3) : 1);

// A full yes or no, from the neck: big, unmistakable, and fluid. t runs 0..1 over the gesture.
// Yes: three deep nods, chin dropping well down and coming back up each time, the first deepest.
// No: three wide side-to-side swings, the first widest. Both fade in and out with a smooth window,
// so they start and end at rest with no jolt. Degrees (+pitch is chin down). Most of it goes to the
// neck (see updateHead), the way a real head shake is driven.
const YES_DEG = 24, NO_DEG = 34, STROKES = 3;
function yesNo(name, t, strength = 1) {
  const win = Math.sin(Math.PI * clamp(t)) ** 0.6; // 0 at both ends, full in the middle
  const decay = 1 - 0.35 * t; // later strokes a little smaller, like a real nod
  if (name === 'nod') return { pitch: YES_DEG * strength * win * decay * (1 - Math.cos(2 * Math.PI * STROKES * t)) / 2, yaw: 0 };
  if (name === 'shake') return { pitch: 0, yaw: NO_DEG * strength * win * decay * Math.sin(2 * Math.PI * STROKES * t) };
  return null;
}
// ---- Emotional outbursts: every laugh, cry and frustrated style ---------------------------------
// The styles and their performer live in avatar-moments.js. Each becomes a gesture here. The side a
// lopsided style leans to is picked per outburst (c.momentSide).
const MOMENTS = Object.fromEntries(Object.entries(STYLES).map(([name, s]) => [name,
  [s.ms, (c, t, o) => performStyle(name, t, (shape, v) => add(c, shape, v), o, c.momentSide ?? 1)]]));
for (const [alias, name] of Object.entries(STYLE_ALIASES)) MOMENTS[alias] = MOMENTS[name];

const GESTURE_DEFS = {
  ...MOMENTS,
  // Face quirks share their shapes and head lean with the poses she calls herself (avatar-performance.js).
  wink: [900, (c, t, o) => quirk(c, 'wink_left', bell(t), o)],
  scrunch: [1100, (c, t, o) => quirk(c, 'nose_scrunch', bell(t), o)],
  smirk: [1600, (c, t, o) => quirk(c, 'smirk_left', bell(t), o)],
  tongue: [1400, (c, t, o) => quirk(c, 'tongue_out', bell(t), o)],
  puff: [1300, (c, t, o) => quirk(c, 'puff_cheeks', bell(t), o)],
  pout: [1800, (c, t, o) => quirk(c, 'pout', bell(t), o)],
  browraise: [1500, (c, t, o) => quirk(c, 'one_brow_up', bell(t), o)],
  nod: [1500, (c, t, o) => { const m = yesNo('nod', t); o.neckPitch += m.pitch; o.yesNo = 1; }],
  shake: [1700, (c, t, o) => { const m = yesNo('shake', t); o.neckYaw += m.yaw; o.yesNo = 1; }],
  tilt: [1600, (c, t, o) => { o.roll += bell(t) * 9; }],
  sigh: [1800, (c, t, o) => { const b = bell(t); add(c, 'eyeBlinkLeft', 0.35 * b); add(c, 'eyeBlinkRight', 0.35 * b); add(c, 'browInnerUp', 0.25 * b); o.pitch += 4 * b; o.breath += 4 * b; o.shoulders += 0.5 * Math.sin(Math.PI * t); }],
  eyeroll: [1200, (c, t, o) => { const b = bell(t); o.gaze = { x: Math.cos(Math.PI * (1 - t)) * 0.8, y: -0.95 * b }; add(c, 'browOuterUpLeft', 0.25 * b); add(c, 'browOuterUpRight', 0.25 * b); o.pitch -= 3 * b; o.roll += 3 * b; }],
  crosseyed: [1100, (c, t, o) => {
    // Both eyes look sharply inward, with squint and raised brows: a "cross-eyed" stare.
    const b = bell(t), cross = Math.max(0, Math.sin(t * Math.PI * 2)) * 0.9;
    add(c, 'eyeLookInLeft', cross * b);
    add(c, 'eyeLookInRight', cross * b);
    add(c, 'eyeSquintLeft', 0.5 * b);
    add(c, 'eyeSquintRight', 0.5 * b);
    add(c, 'browInnerUp', 0.35 * b);
    add(c, 'browOuterUpLeft', 0.3 * b);
    add(c, 'browOuterUpRight', 0.3 * b);
    o.roll += -2 * b;
  }],
  shrug: [1300, (c, t, o) => { const b = bell(t); o.shoulders += b; add(c, 'mouthShrugLower', 0.4 * b); add(c, 'browInnerUp', 0.3 * b); add(c, 'browOuterUpLeft', 0.3 * b); add(c, 'browOuterUpRight', 0.3 * b); o.roll += 5 * b; }],
  // Idle fidgets, played by her body engine (src/body.js) from her moods. A living body doesn't stand
  // still: it stretches its neck, rolls its shoulders, shifts its weight and looks off now and then.
  neck_stretch: [3400, (c, t, o) => { const s = Math.sin(t * Math.PI * 2); o.roll += 13 * s * bell(t); o.neckPitch += 3 * bell(t); add(c, 'eyeBlinkLeft', 0.25 * bell(t)); add(c, 'eyeBlinkRight', 0.25 * bell(t)); }],
  neck_roll: [3600, (c, t, o) => { const a = t * Math.PI * 2, b = bell(t); o.neckPitch += 7 * Math.sin(a) * b; o.neckYaw += 8 * Math.cos(a) * b; o.roll += 6 * Math.cos(a) * b; }],
  shoulder_roll: [2600, (c, t, o) => { o.shoulderL += Math.sin(Math.PI * Math.min(1, t / 0.6)) * 0.9; o.shoulderR += t > 0.4 ? Math.sin(Math.PI * (t - 0.4) / 0.6) * 0.9 : 0; o.breath += 1.5 * bell(t); }],
  settle: [3000, (c, t, o) => { const b = bell(t); o.spineRoll += 3 * Math.sin(Math.PI * t); o.spineYaw += 4 * Math.sin(Math.PI * t) * (c.momentSide ?? 1); o.roll -= 2 * b; o.breath += 1 * b; }],
  deep_breath: [2800, (c, t, o) => { const b = Math.sin(Math.PI * t); o.breath += 3 * b; o.shoulders += 0.35 * b; o.pitch -= 2 * b; add(c, 'mouthPressLeft', 0.15 * b); add(c, 'mouthPressRight', 0.15 * b); }],
  look_away: [2600, (c, t, o) => { const b = bell(t), side = c.momentSide ?? 1; o.gx += 0.42 * b * side; o.yaw += 11 * b * side; o.gy -= 0.15 * b; }],
  head_tilt: [2400, (c, t, o) => { const b = bell(t); o.roll += 7 * b * (c.momentSide ?? 1); o.pitch += 2 * b; add(c, 'browInnerUp', 0.12 * b); }],
  lip_press: [1300, (c, t, o) => { const b = bell(t); add(c, 'mouthPressLeft', 0.45 * b); add(c, 'mouthPressRight', 0.45 * b); add(c, 'mouthRollLower', 0.2 * b); }],
  chin_up: [2200, (c, t, o) => { const b = bell(t); o.pitch -= 5 * b; add(c, 'eyeSquintLeft', 0.15 * b); add(c, 'eyeSquintRight', 0.15 * b); }],
  gasp: [800, (c, t, o) => { const b = bell(t); add(c, 'eyeWideLeft', 0.6 * b); add(c, 'eyeWideRight', 0.6 * b); add(c, 'browInnerUp', 0.5 * b); add(c, 'jawOpen', 0.25 * b); o.pitch -= 3 * b; }],
};
// ms: how long it plays this time (her body engine stretches or quickens moves with her mood).
function playGesture(c, name, delay = 0, ms = 0) {
  if (!c || !GESTURE_DEFS[name]) return;
  if (!STYLES[STYLE_ALIASES[name] ?? name]) c.momentSide = Math.random() < 0.5 ? -1 : 1; // which way a fidget leans
  // One outburst at a time: a new one replaces any still playing. Real tears when the style has them.
  const style = STYLE_ALIASES[name] ?? name;
  if (STYLES[style]) {
    c.gestures = c.gestures.filter((g) => !MOMENTS[g.name]);
    c.momentSide = Math.random() < 0.5 ? -1 : 1;
    if (STYLES[style].tears) setTimeout(() => startTears(c, STYLES[style].tears), delay);
  }
  c.gestures.push({ name, start: performance.now() + delay, ...(ms > 0 && { ms: Math.min(15000, ms) }) });
}
function updateGestures(c, now) {
  for (let i = c.gestures.length - 1; i >= 0; i--) {
    const g = c.gestures[i];
    const [defMs, run] = GESTURE_DEFS[g.name];
    const ms = g.ms ?? defMs;
    const t = (now - g.start) / ms;
    if (t < 0) continue;
    if (t >= 1) { c.gestures.splice(i, 1); continue; }
    run(c, t, c.fx);
  }
}

// ---------------------------------------------------------------- lip sync from audio

// Fish Audio returns only audio, so the mouth shape is estimated from it each frame: loudness opens
// the jaw, and where the energy sits in the spectrum picks the shape - dark (O/U), open (aa),
// bright (E/I), or hissy (S/SH). Coarser than real visemes, but it tracks the voice exactly.
let audioCtx = null, analyser = null, gainNode = null;
let timeBuf, freqBuf;
const VISEMES = SPEECH_SHAPES;
// Models without viseme shapes (only ARKit) build each mouth shape from jaw and lip controls.
const VISEME_ARKIT = {
  viseme_aa: { jawOpen: 0.55, ...LR('mouthLowerDown', 0.25) },
  viseme_O: { jawOpen: 0.3, mouthFunnel: 0.6 },
  viseme_U: { jawOpen: 0.12, mouthPucker: 0.7 },
  viseme_E: { jawOpen: 0.3, ...LR('mouthStretch', 0.35) },
  viseme_I: { jawOpen: 0.15, ...LR('mouthStretch', 0.3), ...LR('mouthSmile', 0.1) },
  viseme_SS: { jawOpen: 0.05, ...LR('mouthStretch', 0.25) },
  viseme_CH: { jawOpen: 0.1, mouthFunnel: 0.35, mouthPucker: 0.2 },
  viseme_PP: { ...LR('mouthPress', 0.5) },
  viseme_FF:{jawOpen:.08,mouthRollLower:.35,...LR('mouthUpperUp',.25)},
  viseme_TH:{jawOpen:.15,tongueOut:.12},viseme_DD:{jawOpen:.12},viseme_kk:{jawOpen:.18},
  viseme_nn:{jawOpen:.1},viseme_RR:{jawOpen:.16,mouthPucker:.22},
};
function addViseme(c, name, w) {
  if (c.hasVisemes || name === 'jawOpen') return add(c, name, w);
  for (const [shape, k] of Object.entries(VISEME_ARKIT[name] ?? {})) add(c, shape, w * k);
}

// ---- Enunciated viseme track ------------------------------------------------------------
// Legacy letter-based fallback for older servers without phoneme data. The primary
// engine uses pronunciation phonemes with audio-guided alignment and coarticulation.
const VOWEL_VISEME = {
  a: 'viseme_aa', 'á': 'viseme_aa', 'â': 'viseme_aa', 'ä': 'viseme_aa', 'à': 'viseme_aa', 'å': 'viseme_aa',
  e: 'viseme_E', 'é': 'viseme_E', 'è': 'viseme_E', 'ê': 'viseme_E', 'ë': 'viseme_E',
  i: 'viseme_I', 'í': 'viseme_I', 'ì': 'viseme_I', 'î': 'viseme_I', 'ï': 'viseme_I',
  o: 'viseme_O', 'ó': 'viseme_O', 'ò': 'viseme_O', 'ô': 'viseme_O', 'ö': 'viseme_O',
  u: 'viseme_U', 'ú': 'viseme_U', 'ù': 'viseme_U', 'û': 'viseme_U', 'ü': 'viseme_U',
  y: 'viseme_I', w: 'viseme_U',
};
const CONSONANT_VISEME = {
  p: 'viseme_PP', b: 'viseme_PP', m: 'viseme_PP',
  s: 'viseme_SS', z: 'viseme_SS', f: 'viseme_SS', v: 'viseme_SS',
  c: 'viseme_CH', j: 'viseme_CH', g: 'viseme_CH', x: 'viseme_CH', h: 'viseme_CH', k: 'viseme_aa',
  d: 'viseme_aa', t: 'viseme_aa', n: 'viseme_aa', l: 'viseme_aa', r: 'viseme_aa', q: 'viseme_aa',
};
// How long each class of sound holds, relative to one another (vowels and sibilants linger,
// hard stops are quick so the next shape can come).
const SOUND_WEIGHT = (ch) => {
  if (VOWEL_VISEME[ch]) return 2.4;
  if (ch === 's' || ch === 'z' || ch === 'f' || ch === 'v' || ch === 'j' || ch === 'c' || ch === 'x') return 1.6;
  if (CONSONANT_VISEME[ch]) return 1.0;
  return 0.35; // spaces and punctuation: a brief neutral
};
// Build a {at, hold, mouth} list covering `ms` of speech for `text`.
function visemeTrack(text, ms) {
  const chars = [...String(text).toLowerCase().replace(/[0-9]/g, (d) => ({ 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine' })[d])].filter((ch) => /[a-zà-öø-ÿ'\- ]/.test(ch));
  if (!chars.length || !ms || ms <= 0) return [];
  const total = chars.reduce((a, ch) => a + Math.max(0.3, SOUND_WEIGHT(ch)), 0);
  const track = [];
  let at = 0;
  for (const ch of chars) {
    const hold = (Math.max(0.3, SOUND_WEIGHT(ch)) / total) * ms;
    const v = VOWEL_VISEME[ch], cv = CONSONANT_VISEME[ch];
    const mouth = { viseme_aa: 0, viseme_O: 0, viseme_U: 0, viseme_E: 0, viseme_I: 0, viseme_SS: 0, viseme_CH: 0, viseme_PP: 0, jawOpen: 0 };
    if (v) {
      mouth[v] = 1;
      mouth.jawOpen = v === 'viseme_aa' ? 0.55 : v === 'viseme_O' ? 0.32 : v === 'viseme_E' ? 0.32 : 0.2;
    } else if (cv) {
      mouth[cv] = cv === 'viseme_PP' ? 1 : 0.75;
      if (cv === 'viseme_aa') mouth.jawOpen = 0.3;
    }
    track.push({ at, hold, mouth });
    at += hold;
  }
  // Give the last phoneme a moment to close, so the mouth settles rather than snapping shut.
  const end = track.length ? track[track.length - 1] : null;
  if (end) end.hold += ms * 0.08;
  return track;
}
function visemeAt(track, at) {
  if (!track.length) return null;
  if (at < track[0].at) return track[0].mouth;
  for (const seg of track) if (at >= seg.at && at < seg.at + seg.hold) return seg.mouth;
  return track[track.length - 1].mouth;
}

let recordDest = null; // speech audio as a stream, for recording video replies
function ensureAudio() {
  if (audioCtx) return audioCtx;
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.35;
  gainNode = audioCtx.createGain();
  // ?silent: her lips move but nothing plays (her own browser: her voice already reaches Discord).
  gainNode.gain.value = new URLSearchParams(location.search).has('silent') ? 0 : opts.volume;
  analyser.connect(gainNode).connect(audioCtx.destination);
  recordDest = audioCtx.createMediaStreamDestination();
  analyser.connect(recordDest); // before the volume control, so clips don't depend on it
  timeBuf = new Float32Array(analyser.fftSize);
  freqBuf = new Uint8Array(analyser.frequencyBinCount);
  return audioCtx;
}

function updateLips(c, dt, now) {
  const lips = c.lips;
  const target = {};
  let vol = 0;
  const mirror=c.lips.discord;
  const frame=mirror?.frames?.[Math.floor((Date.now()-mirror.at)/mirror.frameMs)];
  let solved=null;
  if(mirror?.articulation?.version===2){
    const track=mirror.speechTrack ||= {...mirror,...mirror.articulation};
    solved=sampleArticulation(track,Date.now()-mirror.at);
  }else if(c.lips.articulation&&playing===c._playing){
    solved=sampleArticulation(c.lips.articulation.track,(audioCtx.currentTime-c.lips.articulation.at)*1000);
  }
  lips.closure=solved?.closure||0;lips.speechActive=Boolean(solved?.active||frame);
  if(solved){
    vol=solved.level*opts.lips;for(const name of VISEMES)target[name]=(solved.mouth[name]||0)*opts.lips;
    // Smiles remain in the cheeks/eyes while the lips make a clear consonant seal.
    for(const name of ['mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight','mouthPucker'])if(c.weights.has(name))c.weights.set(name,c.weights.get(name)*(1-.8*lips.closure));
  }else if(frame){
    vol=frame.open*opts.lips;
    // Enunciate: use the line's vowel track (built once when the speech started) rather than the
    // coarse open/round/wide envelope, so vowels actually move. Amplitude still follows the audio.
    let track = mirror.track;
    if (!track) {
      const ms = (mirror.frames?.length ?? 1) * (mirror.frameMs ?? 40);
      track = mirror.track = { at: mirror.at, ms, segs: visemeTrack(mirror.text || '', ms) };
    }
    const m = visemeAt(track.segs, Date.now() - track.at);
    if (m) {
      const scale = clamp((frame.open / (Math.max(0.01, frame.wide + frame.round) + 0.02)) * 2.2, 0.5, 1.4);
      for (const name of VISEMES) {
        const goal = (m[name] ?? 0) * scale * opts.lips;
        target[name] = name === 'jawOpen' ? goal * (0.5 + vol * 0.7) : goal * (0.35 + vol * 0.9);
      }
      // Sibilants: keep a little of the envelope's own hiss energy for S/CH clarity.
      target.viseme_SS = Math.max(target.viseme_SS ?? 0, frame.open * Math.max(0, frame.bright - 0.3) * 0.7 * opts.lips);
    } else {
      target.viseme_aa=vol*.55;target.viseme_O=frame.round*opts.lips*.4;
      target.viseme_E=frame.wide*opts.lips*.4;target.jawOpen=vol*.2;
    }
  } else if (analyser && playing && speaker === c) {
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (const v of timeBuf) sum += v * v;
    const rms = Math.sqrt(sum / timeBuf.length);
    vol = clamp((rms - 0.012) * 7 * opts.lips);

    analyser.getByteFrequencyData(freqBuf);
    const hz = audioCtx.sampleRate / analyser.fftSize;
    const band = (lo, hi) => {
      let s = 0, n = 0;
      for (let i = Math.floor(lo / hz); i <= Math.ceil(hi / hz) && i < freqBuf.length; i++) { s += freqBuf[i]; n++; }
      return n ? s / n / 255 : 0;
    };
    const low = band(150, 900), mid = band(900, 2400), high = band(3200, 8000);
    const hiss = clamp((high / (low + mid + high + 1e-6) - 0.28) * 3.5);
    const bright = mid / (low + mid + 1e-6);
    const open = vol * (1 - hiss * 0.7);
    // Enunciate in the studio too: the exact line's vowel track is running, so the mouth follows
    // real A/E/I/O/U shapes while the audio still sets loudness and sibilance.
    const track = c.lips.track && playing === c._playing ? c.lips.track : null;
    if (track && track.segs.length) {
      const m = visemeAt(track.segs, now - track.at);
      if (m) {
        for (const name of VISEMES) {
          const goal = (m[name] ?? 0) * opts.lips;
          target[name] = name === 'jawOpen' ? goal * (0.5 + vol * 0.7) : goal * (0.35 + vol * 0.85);
        }
        target.viseme_SS = Math.max(target.viseme_SS ?? 0, vol * hiss * 0.6);
        target.viseme_CH = Math.max(target.viseme_CH ?? 0, vol * hiss * 0.3);
      }
    } else {
      const wO = clamp(1 - bright / 0.38), wE = clamp((bright - 0.5) / 0.3), wA = clamp(1 - wO - wE);
      target.viseme_aa = open * wA * 0.85;
      target.viseme_O = open * wO * 0.55;
      target.viseme_U = open * wO * 0.35;
      target.viseme_E = open * wE * 0.55;
      target.viseme_I = open * wE * 0.35;
      target.jawOpen = open * 0.22;
      target.viseme_SS = vol * hiss * 0.6;
      target.viseme_CH = vol * hiss * 0.25;
    }
  } else if (lips.fake && now < lips.fake.until) {
    // No audio (voice off, no voice set, or Fish failed): flap the mouth for roughly as long as
    // the line takes to say.
    const t = (now - lips.fake.start) / 1000;
    vol = clamp(0.35 + 0.35 * Math.sin(t * 17) + 0.2 * Math.sin(t * 7.3 + 1));
    target.viseme_aa = vol * 0.5;
    target.viseme_O = vol * 0.2 * (Math.sin(t * 3.1) > 0.4 ? 1 : 0);
    target.jawOpen = vol * 0.15;
  }
  // Brows flick up on stressed syllables, the way people's do when they talk.
  if (vol - lips.level > 0.22 && now - lips.flashAt > 700 && Math.random() < 0.6) lips.flashAt = now;
  const flash = lips.flashAt ? Math.max(0, 1 - (now - lips.flashAt) / 380) : 0;
  if (flash > 0) {
    const f = smoothstep(flash) * 0.32 * opts.expr;
    add(c, 'browInnerUp', f);
    add(c, 'browOuterUpLeft', f * 0.8);
    add(c, 'browOuterUpRight', f * 0.8);
  }
  lips.level += (vol - lips.level) * ease(0.3, dt);
  for (const name of VISEMES) {
    const cur = lips.cur[name] || 0;
    const tgt = target[name] || 0;
    lips.velocity ||= {};
    [lips.cur[name],lips.velocity[name]]=smoothSpeech(cur,tgt,lips.velocity[name]||0,dt,lips.closure>.4?2:1);
    addViseme(c, name, lips.cur[name]);
  }
}

// ---------------------------------------------------------------- speech queue

const speech = []; // { char, text, buffer, feelings, gestures }
let playing = null; // the BufferSource now playing
let speakToken = 0;

function enqueueSpeech(item) {
  speech.push(item);
  if (!playing && !cast.some((c) => c.lips.fake)) playNext();
}

function playNext() {
  const item = speech.shift();
  if (!item) {
    caption(null);
    speaker = null;
    if (state === 'speaking') setState(streaming ? 'thinking' : 'idle');
    if (!streaming) turnFinished();
    return;
  }
  const c = byId.get(item.char);
  // Feelings and gestures land as the sentence starts, not when it arrives.
  if (item.feelings) setFeelings(c, item.feelings, Boolean(item.text));
  item.gestures?.forEach((g, i) => playGesture(c, g, i * 700));
  if (!item.text || !c) return playNext(); // a tag on its own: nothing to say
  speaker = c;
  setState('speaking');
  caption(item.text, c);
  const token = speakToken;
  if (item.buffer) {
    const src = audioCtx.createBufferSource();
    src.buffer = item.buffer;
    src.connect(analyser);
    const startedAt=audioCtx.currentTime+.025;
    c.lips.articulation=item.articulation?{track:item.articulation,at:startedAt}:null;
    // Backwards-compatible fallback when no pronunciation data is available.
    c.lips.track = { at: performance.now(), ms: item.buffer.duration * 1000, segs: visemeTrack(item.text, item.buffer.duration * 1000) };
    c._playing = src;
    src.onended = () => {
      if (token !== speakToken) return;
      playing = null;
      c._playing = null;
      c.lips.articulation=null;
      playNext();
    };
    playing = src;
    src.start(startedAt);
  } else {
    const ms = Math.max(900, item.text.length * 62);
    c.lips.fake = { start: performance.now(), until: performance.now() + ms };
    setTimeout(() => {
      if (token !== speakToken) return;
      c.lips.fake = null;
      playNext();
    }, ms + 150);
  }
}

function stopSpeaking() {
  speakToken++;
  speech.length = 0;
  for (const c of cast) { c.lips.fake = null; c.lips.track = null; c.lips.articulation=null;c._playing = null; }
  if (playing) { try { playing.stop(); } catch {} playing = null; }
  speaker = null;
  caption(null);
}

function caption(text, c) {
  if (text && opts.subs) {
    $('#captionText').innerHTML = (cast.length > 1 && c ? `<b>${escapeHtml(c.name)}</b> ` : '') + escapeHtml(text);
  }
  $('#caption').classList.toggle('show', Boolean(text && opts.subs));
}

// ---------------------------------------------------------------- chat

let streaming = null; // AbortController for the reply in flight
let state = 'loading';

function setState(next, label) {
  state = next;
  duckMusic(next === 'speaking');
  const labels = { idle: 'Ready', thinking: 'Thinking…', speaking: 'Speaking', listening: 'Listening…', transcribing: 'Transcribing…', error: 'Error', loading: 'Loading' };
  const who = next === 'thinking' && thinker ? `${thinker.name} is thinking…` : next === 'speaking' && speaker ? `${speaker.name} is speaking` : null;
  $('#stateText').textContent = label ?? who ?? labels[next] ?? next;
  $('#stateDot').className = 'dot ' + ({ idle: 'good', error: 'bad' }[next] ?? 'busy');
}

const log = $('#log');
function bubble(role, text = '', who = null) {
  $('#empty')?.remove();
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  if (who) el.dataset.who = who;
  const body = document.createElement('span');
  body.className = 'text';
  body.textContent = text;
  if (role === 'assistant' && who && cast.length > 1) {
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = who;
    el.append(name);
  }
  el.append(body);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function send(text) {
  if(WATCH)return;
  text = text.trim();
  if (!text) return;
  ensureAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  interrupt();
  bubble('user', text);
  await requestReply({ text, character: current?.id });
}

// Streams one character's reply: to your message, or (auto) their own turn in banter.
async function requestReply(request) {
  let out = null;
  setState('thinking');

  const ctrl = new AbortController();
  streaming = ctrl;
  let gotText = false;
  let who = null;
  try {
    const res = await fetch('/api/avatar/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, name: opts.name || undefined, speak: opts.voice }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'speaker') {
          // The server decided who answers (whoever was named, or who you were talking to).
          who = byId.get(msg.character) ?? current;
          if (!request.auto) setCurrent(who); // banter shouldn't change who you're talking to
          lastTurn = who;
          thinker = who;
          setState('thinking');
          out = bubble('assistant', '', who?.name);
          out.querySelector('.text').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
        } else if (msg.type === 'state') {
          setFeelings(who, msg.feelings); // their first reaction while they think
        } else if (msg.type === 'notice') {
          toast(msg.message);
        } else if (msg.type === 'image') {
          // A picture they made with generate_image: shown in their bubble; click to open full size.
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([base64ToArrayBuffer(msg.base64)], { type: msg.mime }));
          link.target = '_blank';
          link.download = msg.name;
          const img = document.createElement('img');
          img.src = link.href;
          img.alt = 'Generated image';
          img.className = 'gen';
          img.onload = () => (log.scrollTop = log.scrollHeight);
          link.append(img);
          out.append(link);
        } else if (msg.type === 'music') {
          musicCommand(msg);
        } else if (msg.type === 'audio') {
          // A song they made with generate_music: a player in their bubble, plus a download link.
          const url = URL.createObjectURL(new Blob([base64ToArrayBuffer(msg.base64)], { type: msg.mime }));
          const player = document.createElement('audio');
          player.controls = true;
          player.src = url;
          player.className = 'song';
          const link = document.createElement('a');
          link.href = url;
          link.download = msg.name;
          link.className = 'file';
          link.textContent = `🎵 ${msg.name}`;
          out.append(player, link);
          log.scrollTop = log.scrollHeight;
        } else if (msg.type === 'file') {
          // A file they wrote with send_file: a download link in their bubble.
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([base64ToArrayBuffer(msg.base64)]));
          link.download = msg.name;
          link.className = 'file';
          link.textContent = `📄 ${msg.name}`;
          out.append(link);
          log.scrollTop = log.scrollHeight;
        } else if (msg.type === 'sentence') {
          if (msg.text) {
            const t = out.querySelector('.text');
            if (!gotText) t.textContent = '';
            t.textContent += (gotText ? ' ' : '') + msg.text;
            gotText = true;
            log.scrollTop = log.scrollHeight;
          }
          let buffer = null;
          if (msg.audio) {
            try { buffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(msg.audio)); } catch {}
          }
          if (streaming !== ctrl) return;
          const articulation=buffer&&msg.phones?.length?compileArticulation(buffer.getChannelData(0),buffer.sampleRate,msg.phones):null;
          enqueueSpeech({ char: who?.id, text: msg.text, buffer: opts.voice ? buffer : null, articulation, feelings: msg.feelings, gestures: msg.gestures });
        } else if (msg.type === 'error') {
          toast(msg.message);
        }
      }
    }
    if (out && !gotText) out.querySelector('.text').textContent = '…';
  } catch (err) {
    if (err.name === 'AbortError') return;
    out?.remove();
    bubble('err', err.message);
    thinker = null;
    if (banter.on) setBanter(false, 'Banter stopped after an error.');
    setState('error', 'Error');
    setTimeout(() => state === 'error' && setState('idle'), 3000);
    return;
  } finally {
    if (streaming === ctrl) {
      streaming = null;
      thinker = null;
    }
  }
  if (!playing && !cast.some((c) => c.lips.fake) && !speech.length) {
    setState('idle');
    turnFinished();
  }
}

function interrupt() {
  clearTimeout(banter.timer);
  if (streaming) { streaming.abort(); streaming = null; }
  thinker = null;
  stopSpeaking();
}

// ---------------------------------------------------------------- banter

// Banter: the cast keep talking among themselves, taking turns, until it's switched off. You can
// jump in at any time (type or hold Space); they answer you, then carry on. It pauses while the
// page is hidden, and it isn't remembered between visits, so a forgotten tab can't run up
// Fish Audio credits.
const banter = { on: false, timer: null };
let lastTurn = null; // the character who spoke last

function setBanter(on, message) {
  banter.on = on && cast.length > 1;
  clearTimeout(banter.timer);
  $('#banterBtn').classList.toggle('on', banter.on);
  $('#banterBtn').setAttribute('aria-pressed', String(banter.on));
  if (message) toast(message);
  if (banter.on && state === 'idle' && !streaming) nextBanterTurn(400);
}

// Called whenever a reply has been fully spoken.
function turnFinished() {
  loadStatus();
  if (banter.on) nextBanterTurn(900 + Math.random() * 1400); // a natural beat between lines
}

function nextBanterTurn(delay) {
  clearTimeout(banter.timer);
  banter.timer = setTimeout(() => {
    if (!banter.on || document.hidden) return; // hidden: resumes when the page is visible again
    // Someone's still talking, or you're about to: try again shortly instead of talking over it.
    if (streaming || speech.length || playing || state !== 'idle' || mic.recording || mic.busy) return nextBanterTurn(1000);
    // Peers (Nova, Alex) are other bots' avatars: they talk for themselves in Discord, never in her banter.
    const others = cast.filter((c) => c !== lastTurn && c.model && !c.peer);
    const next = others[Math.floor(Math.random() * others.length)] ?? cast.find((c) => !c.peer) ?? cast[0];
    if (next.peer) return setBanter(false, 'Banter needs a cast member of her own; the others here are other bots who talk for themselves.');
    ensureAudio();
    requestReply({ auto: true, character: next.id });
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && banter.on && state === 'idle' && !streaming) nextBanterTurn(800);
});

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadHistory() {
  try {
    const rows = await fetch('/api/conversations/avatar').then((r) => r.json());
    const mainName = byId.get('main')?.name;
    for (const m of rows.slice(-40)) {
      if (m.role === 'assistant') {
        bubble('assistant', m.content, m.name ?? mainName);
        lastTurn = cast.find((c) => c.name === (m.name ?? mainName)) ?? lastTurn;
      } else bubble('user', m.content);
    }
  } catch {}
}

// ---------------------------------------------------------------- who you're talking to

function setCurrent(c) {
  if (!c || c === current) return;
  current = c;
  renderEyeColors();
  opts.talkingTo = c.id;
  save();
  document.querySelectorAll('#castPicker button').forEach((b) => b.classList.toggle('on', b.dataset.id === c.id));
  $('#input').placeholder = cast.length > 1 ? `Message ${c.name}… (or name someone)` : 'Message…';
  renderFeelings();
  if (opts.frame === 'face' || opts.frame === 'eyes') frame(opts.frame);
}

function renderCastPicker() {
  const picker = $('#castPicker');
  picker.hidden = cast.length < 2;
  $('#banterBtn').hidden = cast.length < 2;
  picker.innerHTML = cast.map((c) => `<button data-id="${c.id}" class="${c === current ? 'on' : ''}">${escapeHtml(c.name)}</button>`).join('');
}
$('#banterBtn').addEventListener('click', () => {
  ensureAudio(); // a click, so audio can start
  if (audioCtx.state === 'suspended') audioCtx.resume();
  setBanter(!banter.on, banter.on ? 'Banter off. They’ll finish their thought.' : 'Banter on. Jump in any time, or press Esc to stop.');
});
$('#castPicker').addEventListener('click', (e) => {
  const c = byId.get(e.target.closest('button')?.dataset.id);
  if (c) setCurrent(c);
});

// Clicking a character (without dragging the camera) talks to them.
const raycaster = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  // Skinned meshes raycast against their bind pose, so use each character's rough box instead.
  let best = null;
  for (const c of cast) {
    if (!c.model) continue;
    const box = new THREE.Box3().setFromObject(c.model, Object.keys(c.bones ?? {}).length > 0); // posed, as on the stage
    const hit = raycaster.ray.intersectBox(box, new THREE.Vector3());
    if (hit) {
      const d = hit.distanceTo(raycaster.ray.origin);
      if (!best || d < best.d) best = { c, d };
    }
  }
  if (best) setCurrent(best.c);
});

// ---------------------------------------------------------------- microphone

// Captures 48kHz mono PCM (what the bot's speech-to-text expects) for push-to-talk or hands-free.
const mic = { stream: null, ctx: null, node: null, rate: 48000, recording: false, chunks: [], preroll: [],
  voiced: 0, silent: 0, level: 0, busy: false };

async function startMic() {
  if(WATCH)return false;
  ensureAudio(); // called from a click, so the speaker side is unlocked too
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (mic.stream) return true;
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (err) {
    toast('Microphone blocked: ' + err.message);
    return false;
  }
  try { mic.ctx = new AudioContext({ sampleRate: 48000 }); } catch { mic.ctx = new AudioContext(); }
  mic.rate = mic.ctx.sampleRate;
  const src = mic.ctx.createMediaStreamSource(mic.stream);
  mic.node = mic.ctx.createScriptProcessor(2048, 1, 1);
  mic.node.onaudioprocess = (e) => onMicAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(mic.node);
  mic.node.connect(mic.ctx.destination); // ScriptProcessor only runs when connected; it outputs silence
  return true;
}

function stopMicStream() {
  mic.node?.disconnect();
  mic.stream?.getTracks().forEach((t) => t.stop());
  mic.ctx?.close();
  Object.assign(mic, { stream: null, ctx: null, node: null, recording: false, chunks: [] });
  updateMicButton();
}

function onMicAudio(data) {
  let sum = 0;
  for (const v of data) sum += v * v;
  const rms = Math.sqrt(sum / data.length);
  mic.level = rms;
  $('#micBtn').style.setProperty('--lvl', String(1 + clamp(rms * 8, 0, 0.35)));

  if (mic.recording) mic.chunks.push(data);
  if (!opts.handsFree || mic.busy || pushToTalk) return;
  // While a character talks, their own voice would trigger the mic, so hands-free waits.
  if (state === 'speaking' || state === 'thinking') { mic.voiced = 0; return; }

  const blockMs = (data.length / mic.rate) * 1000;
  if (!mic.recording) {
    mic.preroll.push(data);
    if (mic.preroll.length > 8) mic.preroll.shift();
    mic.voiced = rms > 0.02 ? mic.voiced + blockMs : 0;
    if (mic.voiced > 120) {
      mic.recording = true;
      mic.chunks = [...mic.preroll];
      mic.silent = 0;
      setState('listening');
      updateMicButton();
    }
  } else {
    mic.silent = rms < 0.012 ? mic.silent + blockMs : 0;
    if (mic.silent > 900) finishRecording();
  }
}

let pushToTalk = false;
async function beginTalk() {
  if (mic.busy) return;
  if (!(await startMic())) return;
  interrupt();
  pushToTalk = true;
  mic.recording = true;
  mic.chunks = [];
  setState('listening');
  updateMicButton();
}

async function finishRecording() {
  if (!mic.recording) return;
  mic.recording = false;
  pushToTalk = false;
  const chunks = mic.chunks;
  mic.chunks = [];
  mic.preroll = [];
  updateMicButton();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total / mic.rate < 0.35) { setState('idle'); return; }

  // Float32 at the mic's rate -> 16-bit at 48kHz.
  const flat = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { flat.set(c, o); o += c.length; }
  const ratio = mic.rate / 48000;
  const n = Math.floor(total / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = clamp(flat[Math.floor(i * ratio)], -1, 1) * 0x7fff;

  mic.busy = true;
  setState('transcribing');
  updateMicButton();
  try {
    const res = await fetch('/api/avatar/listen', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.buffer });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.text) send(data.text);
    else { setState('idle'); toast("Didn't catch that."); }
  } catch (err) {
    setState('idle');
    toast('Transcription failed: ' + err.message);
  } finally {
    mic.busy = false;
    updateMicButton();
  }
}

function updateMicButton() {
  const b = $('#micBtn');
  b.classList.toggle('rec', mic.recording);
  b.classList.toggle('working', mic.busy);
  b.classList.toggle('armed', opts.handsFree && Boolean(mic.stream) && !mic.recording);
}

// Hold to talk; a quick click toggles instead.
let pressAt = 0;
$('#micBtn').addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  if (mic.recording && pushToTalk) return; // second click of a toggle; handled on pointerup
  pressAt = performance.now();
  await beginTalk();
});
$('#micBtn').addEventListener('pointerup', () => {
  if (!mic.recording || !pushToTalk) return;
  const held = performance.now() - pressAt;
  if (held > 300 || pressAt === 0) finishRecording();
  else pressAt = 0; // short click: keep recording until the next click
});
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.target.closest('textarea, input, select')) return;
  e.preventDefault();
  pressAt = performance.now();
  beginTalk();
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && pushToTalk && !e.target.closest('textarea, input, select')) finishRecording();
  if (e.code === 'Escape') { setBanter(false); interrupt(); setState('idle'); }
});

// ---------------------------------------------------------------- UI wiring

const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  $('#sendBtn').disabled = !input.value.trim();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});
$('#sendBtn').addEventListener('click', submit);
function submit() {
  const text = input.value;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  send(text);
}

$('#framing').addEventListener('click', (e) => e.target.dataset.frame && saveAvatarView({frame:e.target.dataset.frame}));
// Live readout of the strongest feelings of whoever you're talking to, in the dock.
let lastReadout = '';
function renderFeelings() {
  if (!current) return;
  const top = Object.entries(current.feel.target).filter(([, v]) => v >= 0.08).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const who = cast.length > 1 ? `<span class="feel who">${escapeHtml(current.name)}</span>` : '';
  const html = who + (top.length
    ? top.map(([n, v]) => `<span class="feel" title="${n} ${v.toFixed(2)}">${n}<i style="--v:${v.toFixed(2)}"></i></span>`).join('')
    : '<span class="feel calm">calm</span>');
  if (html !== lastReadout) $('#feelings').innerHTML = lastReadout = html;
}
setInterval(renderFeelings, 1000); // feelings fade between replies

// Expressions menu: nudge how they feel (the conversation sees it too) or play a gesture.
async function nudgeFeeling(c, body) {
  try {
    const res = await fetch('/api/avatar/emotion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, character: c.id }) });
    setFeelings(c, (await res.json()).feelings);
  } catch (err) {
    toast(err.message);
  }
}
$('#exprBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#exprPanel').hidden = !$('#exprPanel').hidden;
  $('#exprBtn').classList.toggle('on', !$('#exprPanel').hidden);
  $('#exprWho').textContent = current?.name ?? 'them';
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#exprPanel')) { $('#exprPanel').hidden = true; $('#exprBtn').classList.remove('on'); }
});
$('#exprPanel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !current) return;
  if (b.dataset.feel) nudgeFeeling(current, { feelings: { [b.dataset.feel]: 0.85 } });
  if (b.dataset.gesture) playGesture(current, b.dataset.gesture);
  if (b.id === 'calmBtn') nudgeFeeling(current, { reset: true });
});
$('#exprFeelings').innerHTML = Object.keys(EXPRESSIONS).map((n) => `<button data-feel="${n}">${n}</button>`).join('');
$('#exprGestures').innerHTML = Object.keys(GESTURE_DEFS).map((n) => `<button data-gesture="${n}">${n}</button>`).join('');

function setCollapsed(c) {
  opts.collapsed = c;
  save();
  document.body.classList.toggle('collapsed', c);
  $('#reopen').hidden = !c;
  setTimeout(resize, 260);
  resize();
}
$('#collapseBtn').addEventListener('click', () => setCollapsed(true));
$('#reopen').addEventListener('click', () => setCollapsed(false));
$('#settingsBtn').addEventListener('click', () => {
  const s = $('#settings');
  s.hidden = !s.hidden;
  $('#panelTitle').textContent = s.hidden ? 'Conversation' : 'Settings';
});
$('#clearBtn').addEventListener('click', async () => {
  if (!confirm('Clear this conversation? Long-term memories are kept.')) return;
  await fetch('/api/conversations/avatar', { method: 'DELETE' });
  log.innerHTML = '';
  toast('Conversation cleared');
});

// Settings controls, bound to opts.
const bind = (id, key, apply) => {
  const el = $(id);
  const isBox = el.type === 'checkbox';
  if (isBox) el.checked = opts[key]; else el.value = opts[key];
  el.addEventListener(isBox || el.tagName === 'SELECT' ? 'change' : 'input', () => {
    opts[key] = isBox ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    save();
    apply?.(opts[key]);
  });
  apply?.(opts[key], true);
};
function renderEyeColors(){
  if(!current)return;
  $('#innerEyeColor').value=current.appearance?.eyes||'#408b57';
  $('#outerEyeColor').value=current.appearance?.outerEye||'#eeeeee';
  for(const [field,fallback] of [['irisInner','#cda54e'],['irisOuter','#111111'],['irisStarburst','#bfc4ce'],['irisFlecks','#cda54e']])$(`#${field}Color`).value=current.appearance?.[field]||fallback;
  $('#lipGloss').value=current.appearance?.lipGloss||0;
  $('#hairStreakColor').value=current.appearance?.hairStreak||'#dc709d';
  $('#hairStreakAmount').value=current.appearance?.hairStreakAmount??.35;
}
async function sendPerformance(command){
  try{const response=await fetch('/api/avatar/performance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Animation failed');performanceState=result;
  }catch(error){toast(error.message);}
}
$('#expressionGain').addEventListener('change',event=>sendPerformance({action:'settings',gain:Number(event.target.value)}));
$('#autonomousExpression').addEventListener('change',event=>sendPerformance({action:'settings',autonomous:event.target.checked?'on':'off'}));
$('#avatarGaze').addEventListener('change',event=>sendPerformance({action:'gaze',gaze:event.target.value}));
$('#faceActions').addEventListener('click',event=>{
  if(event.target.dataset.face)sendPerformance({action:'pose',expression:event.target.dataset.face});
  if(event.target.dataset.gesture)sendPerformance({action:'gesture',gesture:event.target.dataset.gesture});
  if(event.target.dataset.release)sendPerformance({action:'reset'});
});
function applyAvatarView(next){
  viewSettings=next;opts.frame=next.frame;
  $('#avatarScale').value=next.scale;$('#avatarZoom').value=next.zoom;
  $('#avatarScaleValue').textContent=`${Number(next.scale.toFixed(2))}×`;
  $('#avatarZoomValue').textContent=`${Number(next.zoom.toFixed(2))}×`;
  for(const c of cast)c.root.scale.setScalar(next.scale);
  layout();frame(next.frame);
}
async function saveAvatarView(patch){
  try{const response=await fetch('/api/avatar/view',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
    const next=await response.json();if(!response.ok)throw new Error(next.error||'Could not save view');applyAvatarView(next);
  }catch(error){toast(error.message);}
}
$('#avatarScale').addEventListener('input',event=>$('#avatarScaleValue').textContent=`${event.target.value}×`);
$('#avatarZoom').addEventListener('input',event=>$('#avatarZoomValue').textContent=`${event.target.value}×`);
$('#avatarScale').addEventListener('change',event=>saveAvatarView({scale:Number(event.target.value)}));
$('#avatarZoom').addEventListener('change',event=>saveAvatarView({zoom:Number(event.target.value)}));
$('#resetAvatarView').addEventListener('click',()=>saveAvatarView({reset:true}));
async function saveEyeColor(field,value){
  if(!current)return;
  try{
    const response=await fetch(`/api/avatar/appearance/${current.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({[field]:value})});
    const appearance=await response.json();if(!response.ok)throw new Error(appearance.error||'Could not save appearance');
  }catch(error){toast(error.message);}
}
$('#innerEyeColor').addEventListener('change',event=>saveEyeColor('eyes',event.target.value));
$('#outerEyeColor').addEventListener('change',event=>saveEyeColor('outerEye',event.target.value));
$('#resetInnerEye').addEventListener('click',()=>saveEyeColor('eyes',null));
$('#resetOuterEye').addEventListener('click',()=>saveEyeColor('outerEye',null));
for(const field of ['irisInner','irisOuter','irisStarburst','irisFlecks']){
  $(`#${field}Color`).addEventListener('change',event=>saveEyeColor(field,event.target.value));
  $(`#reset${field[0].toUpperCase()+field.slice(1)}`).addEventListener('click',()=>saveEyeColor(field,null));
}
$('#lipGloss').addEventListener('change',event=>saveEyeColor('lipGloss',Number(event.target.value)));
$('#hairStreakColor').addEventListener('change',event=>saveEyeColor('hairStreak',event.target.value));
$('#hairStreakAmount').addEventListener('change',event=>saveEyeColor('hairStreakAmount',Number(event.target.value)));
$('#removeHairStreaks').addEventListener('click',()=>saveEyeColor('hairStreak',null));
$('#avatarOutfit').addEventListener('change',async(event)=>{
  try{const response=await fetch('/api/avatar/outfits',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:event.target.value})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not change outfit');
    await syncAvatarLibrary();
  }catch(error){toast(error.message);}
});
async function loadOutfits(){
  try{const response=await fetch('/api/avatar/outfits');if(!response.ok)return;
    const wardrobe=await response.json();const select=$('#avatarOutfit');
    outfitPalettes=wardrobe.palettes||{};activeOutfitId=wardrobe.active||'custom';
    select.replaceChildren(...wardrobe.outfits.map(outfit=>new Option(outfit.name,outfit.id)));
    select.add(new Option('Custom avatar','custom'));select.querySelector('[value="custom"]').disabled=true;
    select.value=wardrobe.active||'custom';
    renderOutfitColors();for(const c of cast)if(c.main&&c.model)applyCharacterAppearance(c);
  }catch{}
}
function applyCharacterAppearance(c){
  if(c.model)applyAvatarAppearance(c.model,{...c.appearance,outfitColors:c.main?outfitPalettes[activeOutfitId]:null},THREE);
}
function renderOutfitColors(){
  const palette=outfitPalettes[activeOutfitId]||{};
  $('#outfitFabricColor').value=palette.fabric||'#25878c';$('#outfitSheenColor').value=palette.sheen||'#889999';
  for(const id of ['outfitFabricColor','outfitSheenColor','resetOutfitFabric','resetOutfitSheen'])$('#'+id).disabled=activeOutfitId==='custom';
}
async function saveOutfitColor(field,value){
  try{const response=await fetch('/api/avatar/outfit-colors',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:activeOutfitId,[field]:value})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not save outfit color');
    outfitPalettes[result.id]=result.colors;renderOutfitColors();for(const c of cast)if(c.main&&c.model)applyCharacterAppearance(c);
  }catch(error){toast(error.message);}
}
$('#outfitFabricColor').addEventListener('change',event=>saveOutfitColor('fabric',event.target.value));
$('#outfitSheenColor').addEventListener('change',event=>saveOutfitColor('sheen',event.target.value));
$('#resetOutfitFabric').addEventListener('click',()=>saveOutfitColor('fabric',null));
$('#resetOutfitSheen').addEventListener('click',()=>saveOutfitColor('sheen',null));
bind('#optName', 'name');
bind('#optVoice', 'voice', (on) => !on && playing && stopSpeaking());
bind('#optVolume', 'volume', (v) => gainNode && (gainNode.gain.value = v));
bind('#optHandsFree', 'handsFree', async (on, init) => {
  if (init) return; // the mic needs a click before it can start
  if (on) { if (!(await startMic())) { opts.handsFree = false; $('#optHandsFree').checked = false; save(); } }
  else if (!pushToTalk) stopMicStream();
  updateMicButton();
});
bind('#optSubs', 'subs', (on) => !on && caption(null));
bind('#optBlink', 'blink');
bind('#optGaze', 'gaze');
bind('#optHead', 'head');
bind('#optIntensity', 'intensity');
bind('#optLips', 'lips');
bind('#optExpr', 'expr');
bind('#optRest', 'restSmile');
bind('#optBackdrop', 'backdrop', (v,init) => {
  if(v==='custom')return;
  document.body.dataset.backdrop=v;setBackdrop(v);
  if(!init)fetch('/api/avatar/background',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'preset',value:v})})
    .then(r=>{if(!r.ok)throw new Error('Background was not saved');}).catch(error=>toast(error.message));
});
bind('#optQuality', 'quality', (v, init) => { if (!init) { fps.steppedDown = true; applyQuality(); } });

// Each character's name, persona and Fish voice. The main one is also the Discord bot.
// The others also carry how she knows them and what they look like, for her cast context.
function renderCharacterEditors() {
  $('#castEditors').innerHTML = cast.map((c) => {
    const family = c.main ? '' : `
      <div class="set"><label>Family role<span class="hint">How she knows them, e.g. “your grandpa” or “your sister”</span></label><input type="text" data-field="role" value="${escapeHtml(c.role || '')}" placeholder="your sister"></div>
      <div class="set"><label>Looks &amp; clothing<span class="hint">What she should remember about their appearance</span></label><textarea data-field="description" rows="2" placeholder="Hair, face, what they are wearing…">${escapeHtml(c.description || '')}</textarea></div>`;
    return `
    <div class="char-edit" data-id="${c.id}">
      <div class="set"><label>Name${c.main ? '<span class="hint">Also the Discord bot’s name, persona and voice</span>' : ''}</label><input type="text" data-field="name" value="${escapeHtml(c.name)}"></div>
      <div class="set"><label>Fish voice ID<span class="hint">From a voice’s page on fish.audio${c.main ? '' : '. Without one they stay silent'}</span></label><input type="text" data-field="voiceId" value="${escapeHtml(c.voiceId || '')}" placeholder="voice ID"></div>${family}
      <label class="persona-label">Persona</label>
      <textarea data-field="persona" rows="4" placeholder="Who ${escapeHtml(c.name)} is: personality, how they talk, what they like…">${escapeHtml(c.persona || '')}</textarea>
      <button class="save-char">Save ${escapeHtml(c.name)}</button>
    </div>`;
  }).join('');
}
$('#castEditors').addEventListener('click', async (e) => {
  if (!e.target.matches('.save-char')) return;
  const box = e.target.closest('.char-edit');
  const c = byId.get(box.dataset.id);
  const patch = Object.fromEntries([...box.querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el.value]));
  try {
    const res = await fetch(`/api/avatar/characters/${c.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const updated = await res.json();
    if (!res.ok) throw new Error(updated.error || res.statusText);
    Object.assign(c, { name: updated.name, persona: updated.persona, voiceId: updated.voiceId, role: updated.role, description: updated.description });
    renderCastPicker();
    renderCharacterEditors();
    renderFeelings();
    toast(`Saved ${c.name}`);
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
});

// Swap the model of whoever you're talking to by dropping a .glb on the page (this browser only).
$('#pickGlb').addEventListener('click', () => $('#glbFile').click());
$('#glbFile').addEventListener('change', (e) => e.target.files[0] && current && loadModel(current, URL.createObjectURL(e.target.files[0])));
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  const file = [...e.dataTransfer.files].find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (file && current) loadModel(current, URL.createObjectURL(file));
  else toast('Drop a .glb file');
});

// Tool bubbles: each call she makes shows what she's reaching for, on the left or right, and floats up.
const TOOL_LABELS = { guide: 'Checking her guide', web_search: 'Searching the web', files: 'Going through files', self: 'Looking at herself', news_feeds: 'Reading the news', threads: 'Reading threads', thread: 'Reading a thread', system_info: 'Checking the system', topics: 'Looking over topics', memories: 'Remembering', knowledge: 'Checking her knowledge' };
const toolBubbles = new Map();
function toolBubble(message) {
  const host = $('#toolBubbles');
  if (!host) return;
  if (message.phase === 'start') {
    const el = document.createElement('div');
    el.className = `tool-bubble ${Math.random() < 0.5 ? 'left' : 'right'}`;
    el.append(message.label ?? TOOL_LABELS[message.tool] ?? `Using ${message.tool}`);
    if (message.detail) { const d = document.createElement('small'); d.textContent = message.detail; el.append(d); }
    el.addEventListener('animationend', () => { el.remove(); toolBubbles.delete(message.id); });
    host.append(el);
    toolBubbles.set(message.id, el);
    while (host.children.length > 6) { const old = host.firstElementChild; toolBubbles.forEach((v, k) => { if (v === old) toolBubbles.delete(k); }); old.remove(); }
    return;
  }
  const el = toolBubbles.get(message.id);
  if (!el) return;
  el.classList.toggle('failed', !message.ok);
  const status = document.createElement('em');
  status.textContent = message.ok ? ' · done' : ' · failed';
  el.append(status);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function loadStatus() {
  try {
    const s = await fetch('/api/avatar/status').then((r) => r.json());
    $('#modelName').textContent = s.model;
    $('#voiceName').textContent = s.ttsReady ? (s.ttsProvider === 'xtts' ? 'XTTS (local clone)' : s.ttsProvider === 'kokoro' ? 'Kokoro (local)' : s.ttsProvider === 'gtts' ? 'gTTS (Google)' : 'Fish Audio') : 'not set up';
    $('#fishDot').className = 'dot ' + (s.ttsReady ? 'good' : 'bad');
    if (!s.ttsReady) toast('Speech is not configured. Check the selected provider and local voice sample.');
  } catch {
    toast("Can't reach the bot. Is it running?");
  }
}

// ---------------------------------------------------------------- loop

// If High can't hold ~25fps for a few seconds, step down a level once rather than stutter.
const fps = { time: 0, frames: 0, steppedDown: false };
function watchFrameRate(dt) {
  if (fps.steppedDown || opts.quality === 'low' || document.hidden || loading.size || !cast.some((c) => c.model) || dt >= 0.1) return;
  fps.time += dt;
  fps.frames++;
  if (fps.time < 4) return;
  const rate = fps.frames / fps.time;
  fps.time = fps.frames = 0;
  if (rate < 25) {
    fps.steppedDown = true;
    opts.quality = opts.quality === 'high' ? 'medium' : 'low';
    $('#optQuality').value = opts.quality;
    save();
    applyQuality();
    toast(`Graphics lowered to ${opts.quality} to keep things smooth (${Math.round(rate)} fps).`);
  }
}

const clock = new THREE.Clock();
function prepareBodyPerformance(c){
  // A facial quirk moves the head with it (a wink tips toward that side), following the same curve as the face.
  const face=activeAnimation(performanceState.face),lean=face&&FACE_HEAD[face.name];
  if(lean){
    const k=(PULSED.includes(face.name)?Math.min(1,Math.sin(face.t*Math.PI)*1.6):face.envelope)*face.strength;
    c.fx.roll+=lean.roll*k;c.fx.pitch+=lean.pitch*k;c.fx.yaw+=lean.yaw*k;
  }
  const motion=c.controlledMotion=activeAnimation(performanceState.motion);
  if(!motion)return;const strength=motion.strength*motion.envelope,t=motion.t;
  if(motion.name==='nod'||motion.name==='shake'){const m=yesNo(motion.name,t,motion.strength);c.fx.neckPitch+=m.pitch;c.fx.neckYaw+=m.yaw;c.fx.yesNo=1;}
  if(motion.name==='tilt')c.fx.roll+=12*strength;
  if(motion.name==='shrug')c.fx.shoulders+=.85*strength;
  if(motion.name==='yawn'){c.fx.pitch-=5*Math.sin(t*Math.PI)*strength;c.fx.breath+=2*strength;}
}
// Whether her mouth is moving right now: the jaw shape written last frame, whichever mesh carries it.
function isTalking(c){
  const jaw=c.morphs.get('jawOpen')?.[0]??c.morphs.get('viseme_aa')?.[0];
  return Boolean(jaw&&(jaw.mesh.morphTargetInfluences?.[jaw.index]??0)>0.08);
}
function updateArmPerformance(c){
  const motion=c.controlledMotion;if(!motion)return;
  const waveEase=(value)=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t);};
  const waveEnvelope=waveEase(motion.t/.25)*waveEase((1-motion.t)/.25);
  const strength=motion.strength*(motion.name==='wave'?waveEnvelope:motion.envelope);
  const aim=(bone,child,target)=>{
    if(!bone||!child)return;c.root.updateMatrixWorld(true);
    const a=bone.getWorldPosition(new THREE.Vector3()),b=child.getWorldPosition(new THREE.Vector3());
    const direction=b.sub(a).normalize(),wanted=direction.clone().lerp(new THREE.Vector3(...target).normalize(),strength).normalize();
    rotateWorld(bone,new THREE.Quaternion().setFromUnitVectors(direction,wanted));
  };
  const sides=['arms_open','stretch'].includes(motion.name)?['Left','Right']:['Right'];
  for(const side of sides){
    const arm=c.bones[side+'Arm'],fore=c.bones[side+'ForeArm'],hand=c.bones[side+'Hand'];if(!arm||!fore)continue;
    c.root.updateMatrixWorld(true);const out=Math.sign(fore.getWorldPosition(new THREE.Vector3()).x-arm.getWorldPosition(new THREE.Vector3()).x)||1;
    if(motion.name==='wave'){
      // Keep the elbow low and bring the hand up, rather than lifting the whole arm.
      aim(arm,fore,[out*.35,-.85,.13]);aim(fore,hand,[-out*.16,.78,.5]);
      const middle=c.bones[side+'HandMiddle1']||c.bones[side+'HandIndex1'];
      aim(hand,middle,[out*.08,1,.10]);
      if(hand){
        const wrist=Math.sin(motion.t*Math.PI*4)*THREE.MathUtils.degToRad(8)*strength;
        rotateWorld(hand,new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),wrist));
      }
    }else if(motion.name==='raise_hand'){aim(arm,fore,[out*.5,.8,.1]);aim(fore,hand,[out*.08,1,.05]);}
    else if(motion.name==='arms_open'){aim(arm,fore,[out,-.3,.15]);aim(fore,hand,[out,-.05,.25]);}
    else if(motion.name==='stretch'){aim(arm,fore,[out*.6,.8,-.1]);aim(fore,hand,[out*.2,1,-.1]);}
    else if(motion.name==='point'){aim(arm,fore,[out*.4,-.15,.5]);aim(fore,hand,[0,0,1]);}
  }
}
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();
  if (camTween) {
    camTween.t = Math.min(1, camTween.t + dt / 0.7);
    const k = smoothstep(camTween.t);
    controls.target.lerpVectors(camTween.fromT, camTween.toT, k);
    camera.position.lerpVectors(camTween.fromP, camTween.toP, k);
    if (camTween.t >= 1) camTween = null;
  }
  controls.update();
  for (const c of cast) {
    if (!c.model) continue;
    updateFeelings(c, dt);
    updateGestures(c, now);
    updateMicro(c, dt, now);
    updateBlink(c, dt * 1000 * c.fx.blink);
    updateGaze(c, dt, now);
    updateLips(c, dt, now);
    applyFacePerformance(c.weights,performanceState,Date.now(),{active:c.lips.speechActive,closure:c.lips.closure});
    updateSleep(c, dt);
    updatePupils(c, dt, now);
    prepareBodyPerformance(c);
    updateHead(c, dt);
    sleepHead(c);                // asleep: her head is still, down, breathing; nothing else moves it
    updateArmPerformance(c);
    // Her fingers: the hand pose she's holding (or her resting hand), with her voice and mood in them.
    updateHands(c, dt, now, c.main ? activeAnimation(performanceState.hands, Date.now()) : null, { talking: isTalking(c), energy: weatherNow.mood.energy, tension: weatherNow.mood.tension }, THREE);
    applyEyes(c);                // the eyeballs turn with her gaze and its tiny jumps
    // Last: every bone glides to where this frame put it, so nothing snaps.
    smoothBones(c, dt, { quickNeck: c.fx.yesNo > 0 });
    updateTears(c, now);
    c.dt = dt;
    applyWeights(c);
    c.model.userData.hair?.update(dt);
  }
  if (RECORDER) frameFace();
  renderShaderBackground();
  renderSceneBackground(dt);
  renderMoodOverlay(dt); // her mood over whatever backdrop is up, every frame, on its own
  if (composer && opts.quality !== 'low') {
    grain.uniforms.time.value = (now / 1000) % 100;
    composer.render(dt);
  } else {
    renderer.render(scene, camera);
  }
  if (clipRec) copyClipFrame(); // straight after rendering, while the frame is still in the buffer
  watchFrameRate(dt);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- video replies (recorder mode)
// /avatar.html?recorder=1, left open, records Discord replies as clips of her face saying them
// (Amy's spec). The server sends each reply's lines with their voice; this page plays them through
// the normal speech path (so the mouth follows the audio), records a fixed 720x720 crop of her face
// plus the speech audio as WebM, and uploads it. One clip at a time, in order.

const RECORDER = !WATCH&&new URLSearchParams(location.search).has('recorder');
const CLIP_SIZE = 720;
const clipCanvas = Object.assign(document.createElement('canvas'), { width: CLIP_SIZE, height: CLIP_SIZE });
const clipCtx = clipCanvas.getContext('2d');
let clipRec = null; // the MediaRecorder while a clip is being recorded
const clipJobs = [];
let clipBusy = false;

// A still camera square on to her face: placed from the body (not the head), so it doesn't move
// when she nods or looks around.
const _fv = new THREE.Vector3(), _fq = new THREE.Quaternion();
function frameFace() {
  const c = cast[0];
  if (!c?.model) return;
  (c.bones.Head ?? c.model).getWorldPosition(_fv);
  const head = _fv.clone().add(new THREE.Vector3(0, 0.03, 0));
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(c.model.getWorldQuaternion(_fq)).setY(0).normalize();
  camera.position.copy(head).addScaledVector(forward, 0.95);
  controls.target.copy(head);
  camera.lookAt(head);
}

// Copies the middle square of the rendered frame into the clip canvas.
function copyClipFrame() {
  const src = renderer.domElement;
  const s = Math.min(src.width, src.height);
  clipCtx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, CLIP_SIZE, CLIP_SIZE);
}

function recorderBar(text, recording = false) {
  const bar = $('#recorderBar');
  bar.textContent = text;
  bar.classList.toggle('rec', recording);
}

const speechDone = () =>
  new Promise((ok) => {
    const check = () => (!playing && !speech.length && !cast.some((c) => c.lips.fake) ? ok() : setTimeout(check, 100));
    check();
  });

async function recordClip(job) {
  const fail = (reason) => fetch(`/api/avatar/recorder/${job.id}/failed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
  if (!audioCtx || audioCtx.state !== 'running') return fail('audio is blocked; click the recorder page once to allow it');
  if (!cast[0]?.model) return fail('the avatar is still loading');
  const buffers = [];
  for (const line of job.lines) buffers.push(await audioCtx.decodeAudioData(base64ToArrayBuffer(line.audio)));
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const stream = new MediaStream([...clipCanvas.captureStream(30).getVideoTracks(), ...recordDest.stream.getAudioTracks()]);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((ok) => (rec.onstop = ok));
  copyClipFrame();
  clipRec = rec;
  rec.start(); // before the audio, so the first syllable is in
  recorderBar(`Recording reply #${job.id}`, true);
  fetch(`/api/avatar/recorder/${job.id}/ack`, { method: 'POST' });
  const articulations=await Promise.all(job.lines.map(async(line,i)=>{
    try{const response=await fetch('/api/avatar/phones',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:line.text})});
      if(!response.ok)return null;const {phones}=await response.json();return compileArticulation(buffers[i].getChannelData(0),buffers[i].sampleRate,phones);
    }catch{return null;}
  }));
  job.lines.forEach((line, i) => enqueueSpeech({ char: cast[0].id, text: line.text, buffer: buffers[i],articulation:articulations[i] }));
  await speechDone();
  await new Promise((ok) => setTimeout(ok, 250)); // tail, so the last syllable isn't clipped (frame holds)
  rec.stop();
  await stopped;
  clipRec = null;
  // Only this clip's canvas track: the audio track is recordDest's, shared by every clip, and
  // stopping it would leave all later clips silent.
  stream.getVideoTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: 'video/webm' });
  await fetch(`/api/avatar/recorder/${job.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  recorderBar(`Sent reply #${job.id} (${(blob.size / 1048576).toFixed(1)} MB). Waiting for the next one.`);
}

async function nextClip() {
  if (clipBusy || !clipJobs.length) return;
  clipBusy = true;
  const job = clipJobs.shift();
  try {
    await recordClip(job);
  } catch (err) {
    clipRec = null;
    fetch(`/api/avatar/recorder/${job.id}/failed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: err.message }) });
    recorderBar(`Reply #${job.id} failed: ${err.message}`);
  }
  clipBusy = false;
  nextClip();
}

function startRecorder() {
  document.body.classList.add('recorder');
  const bar = Object.assign(document.createElement('div'), { id: 'recorderBar' });
  document.body.append(bar);
  recorderBar('Video recorder: click here once to allow audio.');
  // Browsers only let audio start after a click on the page, unless started to allow it (the
  // bot's own hidden recorder is), in which case it's running already.
  const ready = () => recorderBar('Video recorder ready. Keep this window open (not minimised).');
  if (ensureAudio().state === 'running') ready();
  if (new URLSearchParams(location.search).has('silent')) gainNode.gain.value = 0;
  addEventListener('pointerdown', () => {
    ensureAudio().resume().then(ready);
  });
  const events = new EventSource('/api/avatar/recorder');
  events.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'job') {
      clipJobs.push(msg);
      nextClip();
    }
  };
  events.onerror = () => recorderBar('Lost the connection to the bot; reconnecting…');
  events.onopen = () => audioCtx?.state === 'running' && recorderBar('Video recorder ready. Keep this window open (not minimised).');
}

// ---------------------------------------------------------------- start

async function loadCast() {
  let list;
  try {
    list = await fetch('/api/avatar/characters').then((r) => r.json());
  } catch {
    list = [{ id: 'main', main: true, name: 'Companion', persona: '', voiceId: '', feelings: {} }];
  }
  // A character marked "solo" gets its own page (avatar.html?character=<id>) instead of joining
  // the cast. Without a ?character= the main studio page shows every non-solo character.
  const only = RECORDER ? 'main' : new URLSearchParams(location.search).get('character');
  list = only ? list.filter((c) => c.id === only) : list.filter((c) => !c.solo);
  if (!list.length) list = [{ id: 'main', main: true, name: 'Companion', persona: '', voiceId: '', feelings: {} }];
  for (const info of list) {
    const c = createCharacter(info);
    c.look = info.look;
    c.appearance = pendingAvatarAppearance.get(c.id) || info.appearance;
    const speech = pendingAvatarSpeech.get(c.id);
    if((!WATCH||speech?.peer)&&speech?.type === 'start') c.lips.discord = speech;
    c.feel.target = { ...(info.feelings || {}) };
    cast.push(c);
    byId.set(c.id, c);
  }
  setCurrent(byId.get(opts.talkingTo) ?? cast[0]);
  renderCastPicker();
  renderCharacterEditors();
  $('#botName').textContent = cast.length > 1 ? 'Studio' : cast[0].name;
  document.title = `${cast.map((c) => c.name).join(' & ')} · Avatar Studio`;
  if(!WATCH)await loadHistory();
  await Promise.all(cast.filter((c) => !c.main).map((c) => loadModel(c, `/api/avatar/model/${c.id}`).catch(() => {})));
  await syncAvatarLibrary();
  await loadOutfits();
  setInterval(syncAvatarLibrary, 2500);
}

let avatarRevision = null, syncingAvatar = false;
async function syncAvatarLibrary() {
  const c = cast.find((character) => character.main);
  if (!c || syncingAvatar) return;
  syncingAvatar = true;
  try {
    const response = await fetch('/api/avatar/library');
    if (!response.ok) throw new Error('Could not read avatar selection');
    const library = await response.json();
    const outfitId=library.active==='original'?'suit':library.models.find(model=>model.id===library.active)?.outfit||'custom';
    if(outfitId!==activeOutfitId){activeOutfitId=outfitId;renderOutfitColors();}
    $('#avatarOutfit').value=outfitId;
    if (library.revision === avatarRevision) return;
    let report;
    try {
      const loaded = await loadModel(c, `/api/avatar/model/main?revision=${library.revision}`);
      if (loaded?.error) throw new Error(loaded.error);
      renderer.render(scene, camera);
      report = { ok: true, details: `Loaded in player. Skeleton: ${Object.keys(c.bones).length} bones; visemes: ${c.hasVisemes}; blink shapes: ${c.morphs.has('eyeBlinkLeft')}.` };
    } catch (error) {
      report = { ok: false, error: error.message || String(error) };
    }
    if(WATCH)avatarRevision=library.revision;
    else{
      const receipt = await fetch('/api/avatar/library/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: library.revision, ...report }) });
      if (receipt.ok) avatarRevision = library.revision;
    }
  } catch (error) { console.warn('Avatar selection:', error); }
  finally { syncingAvatar = false; }
}

document.body.dataset.backdrop = opts.backdrop;
document.body.classList.toggle('collapsed', opts.collapsed);
$('#reopen').hidden = !opts.collapsed;
resize();
buildComposer();
setState('loading');
tick();
if(!WATCH)loadStatus();
// The recorder takes clips once her model is in, so the first one doesn't fail on "still loading".
let watchReady=false,watchLoaded=false,watchPending=[],watchDecode=Promise.resolve();
if(WATCH){
  const button=document.createElement('button');button.id='startWatching';button.textContent='Loading avatar…';button.disabled=true;document.body.append(button);
  button.addEventListener('click',async()=>{ensureAudio();await audioCtx.resume();watchReady=true;button.remove();for(const packet of watchPending)watchIncoming(packet);watchPending=[];});
}
function watchIncoming(packet){
  if(!watchReady||!watchLoaded){watchPending=[packet];return;}
  watchDecode=watchDecode.then(async()=>{
    if(Date.now()-packet.at>30000)return;
    const buffer=await audioCtx.decodeAudioData(base64ToArrayBuffer(packet.audio));
    const articulation=packet.articulation?{...packet,...packet.articulation}:compileArticulation(buffer.getChannelData(0),buffer.sampleRate,packet.phones||[]);
    enqueueSpeech({char:'main',text:packet.text,buffer,articulation});
  }).catch(error=>toast(`Could not play reply: ${error.message}`));
}
loadCast().then(()=>{watchLoaded=true;if(WATCH){const button=$('#startWatching');button.disabled=false;button.textContent='Start watching · Enable audio';}}).finally(() => RECORDER && startRecorder());
if (!RECORDER&&!WATCH) watchGeneration('avatar', (text, name) => bubble('assistant', text, name));

const pendingAvatarAppearance=new Map(),pendingAvatarSpeech=new Map();
// Who a live event is for: that cast member, or her when it names nobody. An event for someone not on
// this page (a peer like Nova on a page showing only her) goes nowhere, never onto her face.
function castMember(id){return !id||id==='main'?cast.find((x)=>x.main):byId.get(id)??null;}
const liveAvatar=new EventSource('/api/avatar/live');
liveAvatar.onerror=()=>wentOffline();
liveAvatar.onopen=()=>clearTimeout(offlineTimer); // the page is back; she wakes when the server says she's on Discord
liveAvatar.onmessage=(event)=>{
  let message;try{message=JSON.parse(event.data);}catch{return;}
  if(message.type==='relay-status'){const badge=$('#watchStatus');if(badge)badge.textContent=message.online?'LIVE · New Champ':'Waiting for New Champ';return;}
  if(message.type==='view'){applyAvatarView(message.view);return;}
  if(message.type==='performance'){
    performanceState=message.performance;$('#expressionGain').value=performanceState.gain;
    $('#autonomousExpression').checked=performanceState.autonomous;$('#avatarGaze').value=performanceState.gaze;return;
  }
  if(message.type==='outfit-colors'){outfitPalettes=message.palettes;renderOutfitColors();for(const c of cast)if(c.main&&c.model)applyCharacterAppearance(c);return;}
  if(message.type==='background'){applyBackground(message.background);return;}
  if(message.type==='mood'){applyMoodWeather(message);return;} // her mood as weather, for her scenes
  if(message.type==='phrase'){applyPhrase(message);return;} // a phrase of her instrument landing, while she plays
  if(message.type==='dance'){dance.set(message);return;}
  if(message.type==='fidgets'){const base=Date.now();for(const f of message.items||[])fidgetPlan.push({...f,due:base+(Number(f.at)||0)});fidgetPlan.sort((a,b)=>a.due-b.due);return;}
  if(message.type==='play'&&dance.active()&&IDLE_FIDGETS.has(message.name))return; // dancing: no idle fidgets on top
  if(message.type==='play'){playGesture(castMember(message.character),message.name,0,Number(message.ms)||0);return;}
  if(message.type==='power'){if(message.online)cameOnline();else fallOffline();return;}
  if(message.type==='sleep'){sleepNow=message.sleep;for(const c of cast)if(c.main&&c.model)setSleep(c,sleepNow);return;}
  if(message.type==='cue'){setCue(castMember(message.character),message.kind,message.strength??1);return;}
  if(message.type==='tool'){toolBubble(message);return;}
  if(message.type==='bubble-style'){document.documentElement.style.setProperty('--bubble-scale',String(message.scale||1));return;}
  if(message.type==='appearance'){
    pendingAvatarAppearance.set(message.appearance.character,message.appearance);
    const c=byId.get(message.appearance.character);if(!c)return;
    c.appearance=message.appearance;if(c.model)applyCharacterAppearance(c);if(c===current)renderEyeColors();
  } else if(message.type==='expression'){
    const c=castMember(message.character);
    if(c)setFeelings(c,message.feelings||{},Boolean(message.at));
  } else if(message.type==='discord-speech'){
    const packet=message.speech;pendingAvatarSpeech.set(packet.character,packet);
    // The close-up follows the speaker on every page, the watch-only stream included.
    if(packet.type==='start'&&(opts.frame==='face'||opts.frame==='eyes')){const who=byId.get(packet.character);if(who&&who!==current)setCurrent(who);}
    // A peer bot's line (peer-avatar.js) never carries audio, here or on the watch page: its own voice
    // is already in the call, so only its mouth moves, through the same mirror path as below.
    if(WATCH&&!packet.peer){
      if(packet.type==='start'&&packet.audio)watchIncoming(packet);
      else if(packet.type==='stop'&&packet.reason==='interrupted')stopSpeaking();
      return;
    }
    const c=byId.get(packet.character);if(!c)return;
    if(packet.type==='start'){c.lips.discord=packet;caption(packet.text,c);}
    else if(c.lips.discord?.id===packet.id){c.lips.discord=null;if(!playing)caption(null);}
  }
};

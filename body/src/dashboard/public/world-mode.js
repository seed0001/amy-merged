// World mode: her beach house around her on the Studio page, instead of a backdrop behind her. This
// first pass is the framing: the house stands as a timber frame on its piers, every stud, joist and
// header in place, the openings to the water shown as ghost glass, the agreed furniture taped out on
// the subfloor, and the land, the sea and the sky around it following the sun. She stands in the living
// room facing the water. Every layer can be switched on and off, and the hour of the day set, from the
// page's "Her house" settings; the camera gets a "House" framing that pulls back to see the whole frame.
//
// On: the background preset "house" (the Backdrop menu, or her avatar_background tool with preset
// house). Off: any other backdrop. start() and stop() leave the page's own lights and camera as they
// found them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, WALL, WATERLINE, SEA_LEVEL, HOUSE, ROOMS, TAPE_OUTS, STAND, framingPlan, terrainAt, sunAt, lightFor, GOLDEN_HOUR } from './world-layout.js';
import { sharedUniforms, createSky, createOcean, groundMaterial, lumberMaterial, ghostGlassMaterial, tapeMaterial, dustField, KIND } from './world-shaders.js';

// The layers, in the order they are listed on the page, with what each one holds.
export const LAYERS = [
  ['sky', 'Sky & sea'], ['land', 'Sand & land'], ['foundation', 'Piers & posts'], ['floor', 'Floor framing'], ['subfloor', 'Subfloor'],
  ['walls', 'Wall framing'], ['headers', 'Headers & beams'], ['roof', 'Roof framing'], ['deck', 'Deck framing'], ['decking', 'Deck boards'],
  ['openings', 'Glass (ghost)'], ['tape', 'Furniture tape-outs'], ['labels', 'Room labels'], ['dust', 'Sun dust'],
];
export const DEFAULT_HOUSE = { hour: GOLDEN_HOUR, clock: false, layers: Object.fromEntries(LAYERS.map(([k]) => [k, true])) };

let world = null; // { group, page, uniforms, sun, moon, hemi, saved, layers: Map(name -> Object3D[]), ... }
const _v = new THREE.Vector3();

export const active = () => Boolean(world);

// ---------------------------------------------------------------- building the frame

const KIND_OF = { stud: KIND.spf, plate: KIND.spf, sill: KIND.spf, header: KIND.spf, block: KIND.spf, joist: KIND.spf, rafter: KIND.spf, fascia: KIND.spf, post: KIND.treated, pier: KIND.concrete, beam: KIND.lvl, sheet: KIND.plywood, board: KIND.deck };

// Every piece of lumber as one merged mesh per layer, each vertex carrying its piece's local frame for
// the grain. Pieces are boxes l (along x) by h (up) by w, tilted by pitch about z, turned by yaw about y.
function buildFrame(plan, material, layers) {
  const byTag = new Map();
  const m = new THREE.Matrix4(), rot = new THREE.Matrix4();
  for (const p of plan) {
    if (p.kind === 'opening') continue;
    const g = new THREE.BoxGeometry(p.l, p.h, p.w);
    const n = g.attributes.position.count;
    g.setAttribute('aLocal', new THREE.BufferAttribute(g.attributes.position.array.slice(), 3));
    g.setAttribute('aLocalN', new THREE.BufferAttribute(g.attributes.normal.array.slice(), 3));
    const seed = Math.abs(Math.sin(p.x * 12.9898 + p.z * 78.233 + p.y * 37.719) * 43758.5453) % 1;
    g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(n).fill(seed), 1));
    g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(n).fill(KIND_OF[p.kind] ?? KIND.spf), 1));
    rot.makeRotationY(p.yaw || 0);
    if (p.pitch) rot.multiply(m.makeRotationZ(-p.pitch));
    g.applyMatrix4(rot);
    g.translate(p.x, FLOOR + p.y, p.z);
    (byTag.get(p.tag) ?? byTag.set(p.tag, []).get(p.tag)).push(g);
  }
  const meshes = [];
  for (const [tag, list] of byTag) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = `frame ${tag}`;
    (layers.get(tag) ?? layers.set(tag, []).get(tag)).push(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

// The ghost of the glass: a pane in every window, slider and glass bay (doors stay open air).
function buildGhostGlass(plan, material, layers) {
  const panes = [];
  const rot = new THREE.Matrix4();
  for (const p of plan) {
    if (p.kind !== 'opening' || p.opening === 'door') continue;
    const g = new THREE.PlaneGeometry(p.l, p.h);
    const n = g.attributes.position.count;
    const pane = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { pane[i * 2] = p.l; pane[i * 2 + 1] = p.h; }
    g.setAttribute('aPane', new THREE.BufferAttribute(pane, 2));
    rot.makeRotationY((p.yaw || 0) + Math.PI / 2); // the plane faces +z; turn it to face across the wall
    g.applyMatrix4(rot);
    g.translate(p.x, FLOOR + p.y, p.z);
    panes.push(g);
  }
  if (!panes.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(panes, false), material);
  for (const g of panes) g.dispose();
  mesh.renderOrder = 5;
  mesh.userData.noAO = true;
  mesh.name = 'ghost glass';
  (layers.get('openings') ?? layers.set('openings', []).get('openings')).push(mesh);
  return mesh;
}

// A label in the air: her deep teal tag with sand-coloured text, always readable (drawn over the frame).
function label(text, { width = 2.4, height = 0.6, small = false } = {}) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  const r = 60;
  g.fillStyle = 'rgba(15, 92, 100, 0.92)';
  g.beginPath(); g.roundRect(8, 8, c.width - 16, c.height - 16, r); g.fill();
  g.strokeStyle = 'rgba(232, 214, 180, 0.55)'; g.lineWidth = 6; g.stroke();
  g.fillStyle = '#efe3cc';
  g.font = `${small ? 500 : 600} ${small ? 88 : 104}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = small ? 88 : 104;
  while (g.measureText(text).width > c.width - 90 && size > 40) { size -= 6; g.font = `${small ? 500 : 600} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`; }
  g.fillText(text, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  sprite.scale.set(width, height, 1);
  sprite.renderOrder = 20;
  sprite.userData.noAO = true;
  return sprite;
}

// The agreed program taped out on the subfloor, each with its name.
function buildTapeOuts(layers) {
  const mat = tapeMaterial();
  const group = new THREE.Group(); group.name = 'tape-outs';
  const T = 0.05, Y = FLOOR + 0.0025;
  for (const t of TAPE_OUTS) {
    const [cx, cz] = t.at, [l, d] = t.size, yaw = THREE.MathUtils.degToRad(t.turn || 0);
    const g = new THREE.Group();
    const strip = (len, x, z, turn) => { const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.004, T), mat); m.position.set(x, 0, z); m.rotation.y = turn; m.receiveShadow = true; g.add(m); };
    strip(l + T, 0, -d / 2, 0); strip(l + T, 0, d / 2, 0); strip(d + T, -l / 2, 0, Math.PI / 2); strip(d + T, l / 2, 0, Math.PI / 2);
    // a cross for the dog's bed, as a mark she can find
    if (t.dog) { strip(Math.hypot(l, d) * 0.8, 0, 0, Math.atan2(d, l)); strip(Math.hypot(l, d) * 0.8, 0, 0, -Math.atan2(d, l)); }
    g.position.set(cx, Y, cz); g.rotation.y = -yaw;
    group.add(g);
    const tag = label(t.name, { width: 1.5, height: 0.36, small: true });
    tag.position.set(cx, FLOOR + 0.55, cz);
    group.add(tag);
  }
  (layers.get('tape') ?? layers.set('tape', []).get('tape')).push(group);
  return group;
}

function buildRoomLabels(layers) {
  const group = new THREE.Group(); group.name = 'room labels';
  for (const r of Object.values(ROOMS)) {
    const s = label(r.name);
    s.position.set((r.x[0] + r.x[1]) / 2, FLOOR + (r.outdoor ? 1.4 : 2.1), (r.z[0] + r.z[1]) / 2);
    group.add(s);
  }
  const site = label('↓ the water', { width: 2.6, height: 0.6 });
  site.position.set(0, FLOOR + 1.2, 16);
  group.add(site);
  (layers.get('labels') ?? layers.set('labels', []).get('labels')).push(group);
  return group;
}

// ---------------------------------------------------------------- the land and the sea

function buildLand(uniforms, layers) {
  const N = 300, SPAN = 5200;
  const geo = new THREE.PlaneGeometry(2, 2, N, N);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const warp = (u) => Math.sign(u) * Math.pow(Math.abs(u), 3.0) * SPAN;
  for (let k = 0; k < pos.count; k++) {
    const x = warp(pos.getX(k)), z = warp(pos.getZ(k));
    let y = terrainAt(x, z);
    if (Math.abs(x) <= 10.6 && z <= 10.6 && z >= -8.6) y = Math.min(y, FLOOR - 0.45); // the sand under the house and deck, below the piers' feet
    pos.setXYZ(k, x, y, z);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const ground = new THREE.Mesh(geo, groundMaterial(uniforms, { waterline: WATERLINE }));
  ground.receiveShadow = true;
  ground.frustumCulled = false;
  ground.name = 'land';
  (layers.get('land') ?? layers.set('land', []).get('land')).push(ground);
  return ground;
}

function buildSea(uniforms, layers) {
  const near = createOcean(uniforms, { seaLevel: SEA_LEVEL, waterline: WATERLINE, near: true });
  const far = createOcean(uniforms, { seaLevel: SEA_LEVEL - 0.02, waterline: WATERLINE, size: 5200 });
  const list = layers.get('sky') ?? layers.set('sky', []).get('sky');
  list.push(near, far);
  return {
    near, far,
    follow(camX) { const cx = Math.round(camX / 10) * 10; near.position.x = cx; far.userData.hole.value.set(cx, 0, 235, WATERLINE + 233); },
  };
}

// ---------------------------------------------------------------- start / stop

// page: { scene, renderer, camera, controls, pmrem, lights: { key, fill, rimCool, rimWarm, sky }, cast, status }
export async function start(page, settings = DEFAULT_HOUSE) {
  if (world) { applySettings(settings); return world; }
  page.status?.('Framing her house…');
  const group = new THREE.Group();
  group.name = 'world';
  // She stands at STAND in the house, so the house moves so that point is the page's origin (where the
  // cast stands) and the finished floor is the page's y = 0.
  group.position.set(-STAND.at[0], -FLOOR, -STAND.at[1]);
  const uniforms = sharedUniforms();
  const layers = new Map();
  const plan = framingPlan();
  const lumber = lumberMaterial(uniforms);
  buildFrame(plan, lumber, layers);
  buildGhostGlass(plan, ghostGlassMaterial(uniforms), layers);
  buildTapeOuts(layers);
  buildRoomLabels(layers);
  buildLand(uniforms, layers);
  const sea = buildSea(uniforms, layers);
  const sky = createSky(uniforms);
  (layers.get('sky') ?? layers.set('sky', []).get('sky')).push(sky);
  const dust = dustField(uniforms, { center: [0, FLOOR + 1.6, -1], area: [19, 2.8, 13.5] });
  (layers.get('dust') ?? layers.set('dust', []).get('dust')).push(dust);
  for (const list of layers.values()) for (const o of list) group.add(o);

  // The sun and the moon: real shadows across the frame. The shadow box covers the house and deck.
  const sun = new THREE.DirectionalLight(0xfff3e0, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -19, right: 19, top: 19, bottom: -19, near: 1, far: 160 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04; sun.shadow.radius = 3; sun.shadow.blurSamples = 12;
  sun.target.position.set(0, FLOOR + 1.5, -1);
  const moon = new THREE.DirectionalLight(0x9fb2e6, 0);
  moon.target.position.copy(sun.target.position);
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x8a7458, 0.4);
  group.add(sun, sun.target, moon, moon.target, hemi);
  // The sky alone, to light everything from (reflections and the soft daylight on her and the frame).
  const skyScene = new THREE.Scene();
  skyScene.add(createSky(uniforms, 4000));

  const { scene, camera, controls, lights } = page;
  const saved = {
    background: scene.background, environment: scene.environment, environmentIntensity: scene.environmentIntensity,
    near: camera.near, far: camera.far, controls: { minDistance: controls.minDistance, maxDistance: controls.maxDistance, maxPolarAngle: controls.maxPolarAngle, enablePan: controls.enablePan },
    lights: lights ? Object.fromEntries(Object.entries(lights).map(([k, l]) => [k, { intensity: l.intensity, castShadow: l.castShadow, color: l.color.clone() }])) : null,
    exposure: page.renderer.toneMappingExposure,
  };
  scene.background = null;
  camera.near = 0.08; camera.far = 6000; camera.updateProjectionMatrix();
  Object.assign(controls, { minDistance: 0.3, maxDistance: 320, maxPolarAngle: Math.PI * 0.52, enablePan: true });
  // The portrait rig steps back so the sun is the key, but keeps her face readable in the shade.
  if (lights) {
    lights.key.intensity *= 0.45; lights.key.castShadow = false;
    lights.fill.intensity *= 0.7;
    lights.rimCool.intensity *= 0.35; lights.rimWarm.intensity *= 0.5;
    lights.sky.intensity = 0.35; lights.sky.color.set(0xcfe2ff);
  }
  scene.add(group);
  world = { group, page, uniforms, layers, sun, moon, hemi, sea, sky, dust, skyScene, saved, envTarget: null, lastEnv: 0, envDirty: true, settings: structuredClone(DEFAULT_HOUSE), hour: GOLDEN_HOUR, light: null, plan };
  applySettings(settings);
  page.status?.(null);
  return world;
}

export function stop() {
  if (!world) return;
  const { group, page, saved } = world;
  const { scene, camera, controls, lights, renderer } = page;
  scene.remove(group);
  group.traverse((o) => { o.geometry?.dispose?.(); if (o.material) { for (const m of [].concat(o.material)) { m.map?.dispose?.(); m.dispose?.(); } } });
  world.envTarget?.dispose();
  world.skyScene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  scene.environment = saved.environment; scene.environmentIntensity = saved.environmentIntensity;
  camera.near = saved.near; camera.far = saved.far; camera.updateProjectionMatrix();
  Object.assign(controls, saved.controls);
  if (lights && saved.lights) for (const [k, l] of Object.entries(lights)) { l.intensity = saved.lights[k].intensity; l.castShadow = saved.lights[k].castShadow; l.color.copy(saved.lights[k].color); }
  renderer.toneMappingExposure = saved.exposure;
  for (const c of page.cast ?? []) if (c.root?.userData.blob) c.root.userData.blob.visible = true;
  world = null;
}

// ---------------------------------------------------------------- settings: layers and the hour

export function applySettings(settings) {
  if (!world) return;
  const s = { ...DEFAULT_HOUSE, ...settings, layers: { ...DEFAULT_HOUSE.layers, ...(settings?.layers ?? {}) } };
  world.settings = s;
  for (const [name, list] of world.layers) for (const o of list) o.visible = s.layers[name] !== false;
  setHour(s.clock ? clockHour() : s.hour);
}
export const settings = () => (world ? world.settings : null);

const clockHour = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };

// The hour of the day (0..24): where the sun and moon are, and so the colour and strength of every light.
export function setHour(hours) {
  if (!world) return;
  const h = ((Number(hours) % 24) + 24) % 24;
  const { sun: s, moon: m } = sunAt(h);
  const u = world.uniforms;
  if (Math.abs(u.uSun.value.x - s[0]) + Math.abs(u.uSun.value.y - s[1]) + Math.abs(u.uSun.value.z - s[2]) > 1e-4) world.envDirty = true;
  u.uSun.value.set(...s); u.uMoon.value.set(...m);
  world.hour = h;
  const L = lightFor(s[1]);
  world.light = L;
  world.sun.color.setRGB(...L.color);
  world.sun.intensity = L.intensity;
  world.moon.intensity = L.day < 0.2 ? 0.3 : 0;
  world.hemi.intensity = 0.12 + 0.3 * L.day;
  world.hemi.color.set(L.day > 0.3 ? 0xc9dcf5 : 0x2a3a66);
  world.hemi.groundColor.set(L.golden > 0.4 ? 0xa0724a : 0x8a7458);
  world.page.renderer.toneMappingExposure = 0.95 - 0.1 * L.day + 0.08 * L.golden;
  const dir = s[1] > -0.05 ? s : m;
  world.sun.position.copy(world.sun.target.position).add(_v.set(...dir).multiplyScalar(80));
  world.moon.position.copy(world.sun.target.position).add(_v.set(...m).multiplyScalar(80));
}
export const hour = () => world?.hour ?? null;
export const light = () => world?.light ?? null;

// Re-light the scene from the sky when the sun has moved (an expensive render, so never every frame).
function refreshEnvironment(now) {
  if (!world.envDirty || now - world.lastEnv < 400) return;
  world.lastEnv = now; world.envDirty = false;
  const { scene, pmrem } = world.page;
  const next = pmrem.fromScene(world.skyScene, 0, 1, 5000);
  world.envTarget?.dispose();
  world.envTarget = next;
  scene.environment = next.texture;
  scene.environmentIntensity = 0.3 + 0.6 * (world.light?.day ?? 0.5);
}

// ---------------------------------------------------------------- every frame

export function update(t, dt, camera) {
  if (!world) return;
  const u = world.uniforms;
  u.uTime.value = t;
  if (world.settings.clock && (t - (world.lastClock ?? -10)) > 5) { world.lastClock = t; setHour(clockHour()); }
  // The sky dome and the near sea go with the camera; the far sea leaves a hole for the near one.
  world.sky.position.copy(camera.position).sub(world.group.position);
  world.sea.follow(camera.position.x - world.group.position.x);
  // Her painted blob shadow is the studio's; here the sun casts it.
  for (const c of world.page.cast ?? []) if (c.root?.userData.blob) c.root.userData.blob.visible = false;
  refreshEnvironment(performance.now());
}

// ---------------------------------------------------------------- the House framing

// The whole frame from the water side, a little above: pos and target in page coordinates, at a
// distance that fits the house and deck in the visible area (fit: tall, wide -> distance).
export function overview(fit) {
  const cx = (HOUSE.x[0] + HOUSE.x[1]) / 2, cz = (HOUSE.z[0] + 10) / 2; // house and deck together
  const target = new THREE.Vector3(cx - STAND.at[0], WALL * 0.45, cz - STAND.at[1]);
  const dist = fit(WALL + 9, HOUSE.x[1] - HOUSE.x[0] + 10) * 1.05;
  const dir = new THREE.Vector3(0.42, 0.46, 0.78).normalize();
  return { target, pos: target.clone().addScaledVector(dir, dist) };
}

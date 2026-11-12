// The materials of her world, every one written here: the sky, the sea, the sand, the lumber the house
// is framed from, the concrete it stands on, the ghost of the glass to come, the tape on the floor, and
// the dust in the sunlight. Each follows one set of uniforms (sun, moon, time, cloud cover) so they agree.
//   sky     the dome: blue day, golden sunrise and sunset toward the sun, the disk and its glow, two layers
//           of drifting clouds lit by the sun, stars and the moon at night
//   ocean   Gerstner swells rolling to the beach, the sky reflected by Fresnel, sun glints, light through
//           the crests, whitecaps, foam at the break and the wash, haze into the sky at the horizon
//   ground  sand at many scales with grain, wind ripples, wet shining sand where the waves wash up, dune
//           scrub inland, hills fading into the haze
//   lumber  one lit material for the whole frame: SPF studs with cathedral grain, knots and saw marks;
//           pressure-treated posts; layered LVL beams; plywood sheets with their edge plies; concrete piers;
//           deck boards. Grain is bumped into the normal and into the roughness
//   glass   where the glass will go: a faint pane in her deep teal, brighter at the edges
//   tape    painter's tape on the subfloor marking where the furniture goes
//   dust    motes drifting in the sunlight inside the frame
import * as THREE from 'three';

// ---------------------------------------------------------------- shared GLSL

export const NOISE = /* glsl */ `
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float vnoise3(vec3 p){ vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i), hash13(i+vec3(1,0,0)), u.x), mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), u.x), u.y),
             mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), u.x), mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), u.x), u.y), u.z); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 r = mat2(0.8, 0.6, -0.6, 0.8); for (int i = 0; i < 5; i++){ v += a * vnoise(p); p = r * p * 2.03 + 11.7; a *= 0.5; } return v; }
float fbm3(vec2 p){ float v = 0.0, a = 0.5; mat2 r = mat2(0.8, 0.6, -0.6, 0.8); for (int i = 0; i < 3; i++){ v += a * vnoise(p); p = r * p * 2.03 + 11.7; a *= 0.5; } return v; }
`;

// skyColor(dir): the colour of the sky in direction dir (unit, y up). uSun / uMoon are unit vectors.
export const SKY = /* glsl */ `
uniform vec3 uSun; uniform vec3 uMoon; uniform float uTime; uniform float uCloudCover;
vec3 skyColor(vec3 dir, bool withSunDisk){
  float sunH = uSun.y;
  float day = smoothstep(-0.12, 0.12, sunH);
  float golden = exp(-pow((sunH - 0.02) / 0.13, 2.0));
  float h = max(dir.y, 0.0);
  float toSun = max(dot(dir, uSun), 0.0);
  // Day: deep blue overhead, paler and warmer toward the horizon.
  vec3 zenith = mix(vec3(0.012, 0.02, 0.05), vec3(0.17, 0.38, 0.76), day);
  vec3 horizon = mix(vec3(0.03, 0.05, 0.11), vec3(0.66, 0.78, 0.88), day);
  vec3 col = mix(horizon, zenith, pow(h, 0.45));
  // Golden hour: orange and rose along the horizon, strongest toward the sun, a violet wash overhead.
  vec3 warm = mix(vec3(1.0, 0.40, 0.14), vec3(1.0, 0.70, 0.38), toSun);
  float band = exp(-h * 6.0) * (0.35 + 0.65 * pow(toSun, 2.0));
  col = mix(col, warm, golden * band);
  col = mix(col, vec3(0.44, 0.27, 0.46), golden * 0.35 * smoothstep(0.1, 0.8, h) * (1.0 - toSun));
  // Mie glow around the sun, and the disk itself.
  col += mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.92, 0.75), day) * (pow(toSun, 8.0) * 0.35 + pow(toSun, 64.0) * 0.6) * smoothstep(-0.08, 0.02, sunH);
  if (withSunDisk) col += vec3(1.0, 0.9, 0.7) * smoothstep(0.9994, 0.9998, toSun) * 18.0 * smoothstep(-0.03, 0.02, sunH);
  // Night: twinkling stars, a faint galaxy band, the moon and its halo.
  float night = 1.0 - smoothstep(-0.18, 0.02, sunH);
  if (night > 0.0 && dir.y > 0.0) {
    vec3 d = dir * 420.0; vec3 cell = floor(d);
    float star = hash13(cell);
    float tw = 0.6 + 0.4 * sin(uTime * (1.5 + star * 4.0) + star * 40.0);
    float s = smoothstep(0.988, 1.0, star) * smoothstep(0.42, 0.0, length(fract(d) - 0.5)) * tw * (0.4 + 1.6 * pow(hash13(cell + 7.0), 6.0));
    float milky = fbm(vec2(atan(dir.z, dir.x) * 3.0, dir.y * 6.0)) * exp(-pow(dot(dir, normalize(vec3(0.3, 0.6, -0.7))) * 3.0, 2.0));
    col += night * (vec3(s) * 2.2 + vec3(0.35, 0.38, 0.5) * milky * 0.25) * smoothstep(0.0, 0.15, dir.y);
    float toMoon = max(dot(dir, uMoon), 0.0);
    col += night * (vec3(0.9, 0.93, 1.0) * smoothstep(0.99965, 0.9999, toMoon) * 3.0 + vec3(0.25, 0.3, 0.42) * pow(toMoon, 30.0) * 0.5);
  }
  // Clouds: two drifting layers, lit by the sun (gold at the edges at golden hour, slate at night).
  if (dir.y > 0.01) {
    vec2 uv = dir.xz / (dir.y + 0.08) * 0.9;
    float c = fbm(uv * 0.7 + vec2(uTime * 0.004, uTime * 0.0025));
    c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.32, c + 0.12 * fbm(uv * 3.1 - uTime * 0.01));
    vec3 lit = mix(vec3(0.05, 0.06, 0.09), mix(vec3(0.96, 0.97, 1.0), vec3(1.0, 0.64, 0.40), golden), max(day, golden * 0.8));
    vec3 shade = lit * mix(0.55, 0.85, pow(toSun, 3.0));
    col = mix(col, shade, c * smoothstep(0.01, 0.12, dir.y) * 0.92);
  }
  if (dir.y < 0.0) col = horizon * 0.85;
  return col;
}
`;

export function sharedUniforms() {
  return { uSun: { value: new THREE.Vector3(0, 1, 0) }, uMoon: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 }, uCloudCover: { value: 0.42 } };
}

// ---------------------------------------------------------------- sky dome

export function createSky(uniforms, radius = 4500) {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
    fragmentShader: NOISE + SKY + /* glsl */ `
      varying vec3 vDir;
      void main(){
        gl_FragColor = vec4(skyColor(normalize(vDir), true), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  sky.userData.noAO = true;
  sky.name = 'sky';
  return sky;
}

// ---------------------------------------------------------------- ocean

// Waves rolling in toward the beach (+z is out to sea, so they travel toward -z): direction (x, z),
// wavelength (m), height (m), steepness. Summed as Gerstner waves: crests sharpen, troughs flatten.
const WAVES = [
  [-0.05, -1, 38, 0.42, 0.55], [0.22, -1, 23, 0.26, 0.5], [-0.35, -1, 14, 0.14, 0.45],
  [0.6, -0.8, 8.5, 0.07, 0.4], [-0.75, -0.66, 5.2, 0.04, 0.35], [0.1, -1, 3.1, 0.02, 0.3],
];
const GERSTNER = /* glsl */ `
uniform float uTime; uniform float uWaterline;
vec3 gerstner(vec2 p, inout vec3 tangent, inout vec3 binormal, float calm){
  vec3 o = vec3(0.0);
  ${WAVES.map(([dx, dz, L, A, Q]) => {
    const len = Math.hypot(dx, dz), x = (dx / len).toFixed(4), z = (dz / len).toFixed(4);
    const k = ((2 * Math.PI) / L).toFixed(5), c = Math.sqrt(9.81 / ((2 * Math.PI) / L)).toFixed(4);
    return `{ vec2 d = vec2(${x}, ${z}); float k = ${k}; float a = ${A.toFixed(3)} * calm; float f = k * (dot(d, p) - ${c} * uTime);
      float q = ${Q.toFixed(2)}; o.x += q * a * d.x * cos(f); o.z += q * a * d.y * cos(f); o.y += a * sin(f);
      tangent += vec3(-q * d.x * d.x * k * a * sin(f), d.x * k * a * cos(f), -q * d.x * d.y * k * a * sin(f));
      binormal += vec3(-q * d.x * d.y * k * a * sin(f), d.y * k * a * cos(f), -q * d.y * d.y * k * a * sin(f)); }`;
  }).join('\n  ')}
  return o;
}
`;

export function createOcean(uniforms, { seaLevel, waterline, size = 9000, near = false }) {
  const segs = near ? 240 : 150;
  const geo = new THREE.PlaneGeometry(2, 2, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const extent = near ? 240 : size;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i), v = pos.getZ(i);
    const warp = (t) => Math.sign(t) * Math.pow(Math.abs(t), near ? 1.6 : 3.2);
    pos.setX(i, warp(u) * extent);
    pos.setZ(i, waterline - 2 + (warp(v) * 0.5 + 0.5) * extent);
  }
  geo.computeBoundingSphere();
  const hole = { value: new THREE.Vector4(0, 0, -1, 0) };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uSeaLevel: { value: seaLevel }, uWaterline: { value: waterline }, uHole: hole },
    transparent: true, depthWrite: true,
    vertexShader: GERSTNER + /* glsl */ `
      uniform float uSeaLevel;
      varying vec3 vWorld; varying vec3 vNormal2; varying float vCrest; varying float vShore;
      void main(){
        vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
        float shoreDist = p.z - uWaterline;
        float calm = smoothstep(-1.0, 22.0, shoreDist) * 0.85 + 0.15; // nearly flat at the waterline, full swells offshore
        vec3 t = vec3(1.0, 0.0, 0.0), b = vec3(0.0, 0.0, 1.0);
        vec3 w = gerstner(p.xz, t, b, calm);
        p += w;
        p.y += uSeaLevel;
        vNormal2 = normalize(cross(b, t));
        vCrest = w.y / (0.9 * calm + 0.01);
        vShore = shoreDist;
        vWorld = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: NOISE + SKY + /* glsl */ `
      uniform float uSeaLevel; uniform vec4 uHole;
      varying vec3 vWorld; varying vec3 vNormal2; varying float vCrest; varying float vShore;
      vec3 ripple(vec2 p){
        float e = 0.08;
        vec2 d1 = uTime * vec2(0.03, -0.05), d2 = uTime * vec2(-0.06, 0.04);
        float h0 = fbm3(p * 0.35 + d1) + 0.5 * fbm3(p * 1.3 - d2);
        float hx = fbm3((p + vec2(e, 0.0)) * 0.35 + d1) + 0.5 * fbm3((p + vec2(e, 0.0)) * 1.3 - d2);
        float hz = fbm3((p + vec2(0.0, e)) * 0.35 + d1) + 0.5 * fbm3((p + vec2(0.0, e)) * 1.3 - d2);
        return normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e));
      }
      void main(){
        if (uHole.z > 0.0 && abs(vWorld.x - uHole.x) < uHole.z && vWorld.z < uHole.w) discard;
        vec3 view = normalize(cameraPosition - vWorld);
        float dist = length(cameraPosition - vWorld);
        vec3 r = ripple(vWorld.xz);
        float detail = 0.22 * exp(-dist / 45.0);
        vec3 n = normalize(vNormal2 + vec3(r.x, 0.0, r.z) * detail);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
        vec3 refl = skyColor(normalize(reflect(-view, n) + vec3(0.0, 0.02, 0.0)), false);
        float day = smoothstep(-0.12, 0.12, uSun.y);
        // Her teal: turquoise shallows by the beach, deep blue-green offshore, near black at night.
        float depthT = smoothstep(0.0, 60.0, vShore);
        vec3 shallow = vec3(0.09, 0.50, 0.48), deep = vec3(0.01, 0.11, 0.18);
        vec3 body = mix(shallow, deep, depthT) * mix(0.08, 1.0, day);
        float sss = pow(max(dot(view, -uSun), 0.0), 3.0) * clamp(vCrest, 0.0, 1.0) * day;
        body += vec3(0.05, 0.45, 0.38) * sss * 0.9;
        vec3 col = mix(body, refl, fres);
        vec3 light = uSun.y > -0.05 ? uSun : uMoon;
        vec3 lightCol = uSun.y > -0.05 ? mix(vec3(1.0, 0.55, 0.3), vec3(1.0, 0.95, 0.85), day) * 6.0 : vec3(0.6, 0.65, 0.8) * 1.2;
        vec3 hv = normalize(view + light);
        col += lightCol * pow(max(dot(n, hv), 0.0), 380.0) * max(light.y, 0.0) * 1.5;
        float foamNoise = fbm3(vWorld.xz * 0.9 + uTime * 0.2);
        float caps = smoothstep(0.62, 0.95, vCrest + foamNoise * 0.35) * smoothstep(8.0, 30.0, vShore);
        float surge = sin(uTime * 0.55 + vWorld.x * 0.05) * 0.5 + 0.5;
        float shore = smoothstep(6.0, 0.0, vShore - surge * 2.2) * smoothstep(0.62, 0.32, foamNoise - 0.05 * sin(vWorld.x * 0.7));
        float breakLine = exp(-pow((vShore - 3.5 - surge * 2.0) / 1.2, 2.0)) * smoothstep(0.3, 0.7, foamNoise);
        float foam = clamp(caps * 0.8 + shore * 0.9 + breakLine * 0.8, 0.0, 1.0);
        col = mix(col, vec3(0.92, 0.95, 0.96) * mix(0.15, 1.0, day), foam);
        float haze = 1.0 - exp(-dist / 3800.0);
        col = mix(col, skyColor(normalize(vec3(-view.x, 0.004, -view.z)), false), clamp(haze, 0.0, 1.0));
        float alpha = mix(0.55, 1.0, smoothstep(0.0, 4.0, vShore));
        gl_FragColor = vec4(col, max(alpha, foam));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.userData.noAO = true;
  mesh.userData.water = true;
  mesh.userData.hole = hole;
  mesh.name = near ? 'sea near' : 'sea far';
  return mesh;
}

// ---------------------------------------------------------------- ground

// Screen-space bump: the normal tilted by the derivatives of a procedural height (three's bump map
// method, written out so any material here can use it without a texture).
const BUMP = /* glsl */ `
vec3 bumpNormal(vec3 surfPos, vec3 surfNorm, float h, float scale){
  vec2 dHdxy = vec2(dFdx(h), dFdy(h)) * scale;
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * (float(gl_FrontFacing) * 2.0 - 1.0);
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

// The ground keeps the standard lit material (so the sun, its shadows and the lamps fall on it) and
// writes its own colour, roughness and bumps.
export function groundMaterial(uniforms, { waterline }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uWaterline: { value: waterline } });
    shader.vertexShader = 'varying vec3 vGround;\n' + shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vGround = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = 'varying vec3 vGround; uniform float uWaterline;\n' + NOISE + SKY + BUMP + 'float gWet = 0.0; float gHeight = 0.0;\n' + shader.fragmentShader
      .replace('#include <map_fragment>', /* glsl */ `
        vec2 g = vGround.xz;
        float camDist = length(cameraPosition.xz - g);
        // Sand at several scales: drifts of lighter and darker sand, patches, grains.
        float big = fbm(g * 0.012), mid = fbm3(g * 0.09 + 3.1), small = vnoise(g * 2.7), grain = vnoise(g * 38.0);
        vec3 sand = mix(vec3(0.52, 0.42, 0.29), vec3(0.66, 0.56, 0.41), big);
        sand *= 0.92 + 0.12 * mid + 0.05 * (small - 0.5) + 0.08 * (grain - 0.5) * exp(-camDist / 18.0);
        // Shell flecks and dark grains up close.
        float fleck = step(0.985, hash12(floor(g * 60.0))) * exp(-camDist / 14.0);
        sand = mix(sand, vec3(0.9, 0.86, 0.8), fleck * 0.6);
        // Wet sand: darker and shinier where the waves wash up; the line moves with the surge.
        float surge = sin(uTime * 0.55 + g.x * 0.05) * 0.5 + 0.5;
        float shoreDist = uWaterline - g.y;
        float wet = smoothstep(9.0, 2.0, shoreDist - surge * 2.2 + 1.5);
        float darkWet = smoothstep(4.5, 0.0, shoreDist - surge * 2.2);
        sand = mix(sand, sand * vec3(0.62, 0.58, 0.52), wet * 0.65 + darkWet * 0.2);
        // Inland: dunes turn to dune scrub and grasses.
        float inland = smoothstep(-12.0, -60.0, g.y) * (0.5 + 0.5 * fbm3(g * 0.05));
        vec3 scrub = mix(vec3(0.40, 0.43, 0.22), vec3(0.62, 0.58, 0.34), fbm3(g * 0.2));
        sand = mix(sand, scrub, inland * 0.85);
        diffuseColor.rgb = sand;
        gWet = wet;
        // Height for the bumps: wind ripples across the dry sand (none on the wet), grains up close.
        float ph = g.x * 2.2 + g.y * 0.8 + 1.4 * fbm3(g * 0.3);
        gHeight = (cos(ph) * 0.5 + 0.5) * (1.0 - wet) * 0.6 * exp(-camDist / 30.0) + grain * 0.25 * exp(-camDist / 10.0);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(0.95, 0.22, gWet);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        normal = bumpNormal(-vViewPosition, normal, gHeight, 0.035);
      `)
      .replace('#include <fog_fragment>', /* glsl */ `
        #include <fog_fragment>
        { // far land fades into the haze at the horizon
          vec3 toCam = cameraPosition - vGround;
          float d = length(toCam);
          float haze = 1.0 - exp(-d / 2600.0);
          vec3 hz = skyColor(normalize(vec3(-toCam.x, 0.01, -toCam.z)), false);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, hz, clamp(haze, 0.0, 1.0));
        }
      `);
  };
  mat.customProgramCacheKey = () => 'amy-ground-v2';
  return mat;
}

// ---------------------------------------------------------------- lumber

// What each piece is made of (the aKind attribute).
export const KIND = { spf: 0, treated: 1, lvl: 2, plywood: 3, concrete: 4, deck: 5 };

// One lit material for the whole frame. Each vertex carries its piece's local position (metres from
// the piece's centre, x along the length), its local face normal, a seed and its kind; the shader
// grows grain, knots, plies or aggregate from those, so no two studs are alike.
export function lumberMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'attribute vec3 aLocal; attribute vec3 aLocalN; attribute float aSeed; attribute float aKind;\nvarying vec3 vLocal; varying vec3 vLocalN; varying float vSeed; varying float vKind; varying vec3 vWorldL;\n'
      + shader.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vLocal = aLocal; vLocalN = aLocalN; vSeed = aSeed; vKind = aKind;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWorldL = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = 'varying vec3 vLocal; varying vec3 vLocalN; varying float vSeed; varying float vKind; varying vec3 vWorldL;\n' + NOISE + BUMP + /* glsl */ `
      float lHeight = 0.0; float lRough = 0.75; float lBump = 0.02;
      // Softwood: cathedral grain from the pith (off to one side so every face differs), knots, and
      // the fine fuzz of a planed surface. Returns colour; writes lHeight and lRough.
      vec3 softwood(vec3 L, vec3 N, float seed, vec3 pale, vec3 dark, float ringFreq){
        // The pith sits outside the piece, offset by the seed, so the rings cross the faces as arcs.
        vec2 pith = vec2(0.09 + 0.12 * hash11(seed), -0.05 + 0.1 * hash11(seed + 3.0)) * (hash11(seed + 9.0) > 0.5 ? 1.0 : -1.0);
        vec2 cross = L.yz - pith;
        float wobble = vnoise(vec2(L.x * 0.9 + seed * 7.0, length(cross) * 6.0)) * 0.35;
        float r = length(cross) * ringFreq + wobble * 2.0 + vnoise(vec2(L.x * 3.0, seed)) * 0.6;
        float ring = fract(r);
        float late = smoothstep(0.55, 0.75, ring) * (1.0 - smoothstep(0.88, 1.0, ring)); // the dense late wood band
        // Fine longitudinal fibres along x.
        float fibre = vnoise(vec2(L.x * 1.6 + seed, (L.y * 90.0 + L.z * 70.0))) ;
        // Knots: a few per metre, a dark oval with rings bending round it.
        float kcell = floor(L.x * 1.7 + seed * 5.0);
        float khash = hash11(kcell + seed * 13.0);
        float knot = 0.0;
        if (khash > 0.72) {
          vec2 kc = vec2(fract(L.x * 1.7 + seed * 5.0) - 0.5, (L.y + L.z) * 6.0 - (hash11(kcell + 1.0) - 0.5) * 1.6);
          float kd = length(kc * vec2(2.4, 1.0));
          knot = smoothstep(0.32, 0.10, kd);
          late += smoothstep(0.55, 0.32, kd) * (1.0 - knot) * 0.6 * (0.5 + 0.5 * sin(kd * 40.0));
        }
        vec3 col = mix(pale, dark, late * 0.75 + 0.15 * fibre);
        col = mix(col, dark * 0.45, knot);
        // Tone varies board to board (sapwood to heartwood).
        col *= 0.9 + 0.2 * hash11(seed + 21.0);
        // Saw marks on the cut faces: fine arcs across the end grain.
        float endGrain = step(0.9, abs(N.x));
        if (endGrain > 0.5) { col = mix(col, dark, 0.35 + 0.3 * late); }
        lHeight = late * 0.6 + knot * 0.4 + fibre * 0.15;
        lRough = 0.72 + 0.15 * late - 0.05 * fibre;
        return col;
      }
      // Plywood: a face veneer with fine straight grain and football patches; plies on the edges.
      vec3 plywood(vec3 L, vec3 N, float seed){
        vec3 pale = vec3(0.80, 0.62, 0.40), dark = vec3(0.55, 0.37, 0.20);
        float edge = step(0.5, max(abs(N.x), abs(N.z)));
        if (edge > 0.5) {
          float ply = fract((L.y + 0.009) / 0.0026);
          float band = smoothstep(0.1, 0.3, ply) * (1.0 - smoothstep(0.7, 0.9, ply));
          lHeight = band * 0.3; lRough = 0.85;
          return mix(dark * 0.8, pale, band) * (0.9 + 0.2 * vnoise(vec2(L.x * 30.0, L.z * 30.0)));
        }
        float grain = vnoise(vec2(L.x * 2.0 + seed, L.z * 120.0 + seed * 3.0));
        float wide = fbm3(vec2(L.x * 0.8, L.z * 6.0) + seed);
        vec3 col = mix(pale, dark, 0.25 * grain + 0.45 * wide);
        // the printed grade stamp line, faint
        float stamp = step(0.97, hash12(floor(vec2(L.x * 1.5, L.z * 1.5) + seed))) * smoothstep(0.02, 0.0, abs(fract(L.z * 1.5) - 0.5) - 0.03);
        col = mix(col, vec3(0.35, 0.15, 0.1), stamp * 0.35);
        lHeight = grain * 0.2 + wide * 0.1; lRough = 0.78 - 0.08 * grain;
        return col * (0.92 + 0.16 * hash11(seed + 2.0));
      }
      // LVL: thin plies laminated through the depth, a darker brown, glue lines on the faces.
      vec3 lvl(vec3 L, vec3 N, float seed){
        vec3 pale = vec3(0.62, 0.44, 0.26), dark = vec3(0.38, 0.24, 0.12);
        float side = step(0.5, abs(N.z));
        float ply = fract(L.z / 0.0032 + seed);
        float band = smoothstep(0.15, 0.35, ply) * (1.0 - smoothstep(0.65, 0.85, ply));
        float grain = vnoise(vec2(L.x * 3.0 + seed, L.y * 40.0));
        vec3 col = mix(pale, dark, 0.3 * grain);
        if (side < 0.5) col = mix(dark, pale, band * 0.8);
        lHeight = (side < 0.5 ? band * 0.3 : grain * 0.15); lRough = 0.7;
        return col;
      }
      // Concrete: a grey with sand and aggregate speckle, formwork lines, and darker damp feet.
      vec3 concrete(vec3 L, vec3 N, float seed){
        float speck = vnoise(vec2(L.x * 60.0 + seed, (L.y + L.z) * 60.0));
        float agg = step(0.93, hash12(floor(vec2(L.x * 45.0, (L.y * 1.3 + L.z) * 45.0) + seed)));
        float form = smoothstep(0.02, 0.0, abs(fract(L.y * 2.0 + 0.5) - 0.5) - 0.01) * step(0.5, 1.0 - abs(N.y));
        vec3 col = mix(vec3(0.56, 0.55, 0.52), vec3(0.42, 0.41, 0.39), speck * 0.6 + agg * 0.7);
        col *= 1.0 - form * 0.25;
        col *= 0.85 + 0.15 * smoothstep(-0.25, 0.05, L.y); // damp and sandy at the bottom
        lHeight = speck * 0.3 + agg * 0.6; lRough = 0.95;
        return col;
      }
      vec3 lumberColor(vec3 L, vec3 N, float seed, float kind){
        if (kind < 0.5) return softwood(L, N, seed, vec3(0.86, 0.72, 0.50), vec3(0.60, 0.42, 0.24), 95.0);   // SPF
        if (kind < 1.5) return softwood(L, N, seed, vec3(0.58, 0.55, 0.34), vec3(0.36, 0.33, 0.18), 80.0);   // pressure treated
        if (kind < 2.5) return lvl(L, N, seed);
        if (kind < 3.5) return plywood(L, N, seed);
        if (kind < 4.5) return concrete(L, N, seed);
        return softwood(L, N, seed, vec3(0.70, 0.52, 0.34), vec3(0.46, 0.31, 0.17), 70.0);                    // deck boards, a warmer brown
      }
    ` + shader.fragmentShader
      .replace('#include <map_fragment>', /* glsl */ `
        vec3 lcol = lumberColor(vLocal, normalize(vLocalN), vSeed, vKind);
        // sun-bleaching and a little sand dust on upward faces, as a frame standing in the weather
        float up = max(0.0, normalize(vLocalN).y);
        lcol = mix(lcol, lcol * 0.75 + vec3(0.2, 0.18, 0.14), up * 0.12 * (vKind < 0.5 || vKind > 4.5 ? 1.0 : 0.3));
        diffuseColor.rgb = lcol;
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(lRough, 0.3, 1.0);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        normal = bumpNormal(-vViewPosition, normal, lHeight, 0.012);
      `);
  };
  mat.customProgramCacheKey = () => 'amy-lumber-v1';
  return mat;
}

// ---------------------------------------------------------------- ghost glass

// Where the glass goes: a faint pane in her deep teal, brighter at the edges and where the sun catches
// it, with a slow sweep of light across it so it reads as glass to come and not a wall.
export function ghostGlassMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uTint: { value: new THREE.Color(0x0f6f78) } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec2 aPane; // the pane's width and height in metres
      varying vec2 vUv; varying vec2 vPane; varying vec3 vWorld; varying vec3 vN;
      void main(){ vUv = uv; vPane = aPane; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: NOISE + /* glsl */ `
      uniform vec3 uTint; uniform float uTime; uniform vec3 uSun;
      varying vec2 vUv; varying vec2 vPane; varying vec3 vWorld; varying vec3 vN;
      void main(){
        vec3 view = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - abs(dot(normalize(vN), view)), 3.0);
        // an edge line a few centimetres in, like the sightline of a frame to come
        vec2 m = min(vUv, 1.0 - vUv) * vPane;
        float edge = 1.0 - smoothstep(0.0, 0.04, min(m.x, m.y));
        float inner = smoothstep(0.05, 0.06, min(m.x, m.y)) * (1.0 - smoothstep(0.06, 0.08, min(m.x, m.y)));
        // a slow diagonal sweep of light
        float sweep = exp(-pow((vUv.x * vPane.x - vUv.y * vPane.y * 0.6 - mod(uTime * 0.25, 8.0) + 3.0) / 0.35, 2.0)) * 0.12;
        float sun = pow(max(dot(reflect(-view, normalize(vN)), uSun), 0.0), 60.0) * max(uSun.y, 0.0) * 0.5;
        vec3 col = uTint * (0.6 + 0.6 * fres) + vec3(1.0, 0.95, 0.85) * (sun + sweep);
        float alpha = 0.07 + 0.18 * fres + edge * 0.55 + inner * 0.25 + sweep + sun * 0.5;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.85));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------- tape

// Painter's tape on the subfloor: her deep teal, a paper texture, slightly lifted edges.
export function tapeMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vTape;\n' + shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vTape = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = 'varying vec3 vTape;\n' + NOISE + shader.fragmentShader.replace('#include <map_fragment>', /* glsl */ `
      float paper = vnoise(vTape.xz * 400.0) * 0.5 + vnoise(vTape.xz * 90.0) * 0.5;
      float crease = smoothstep(0.985, 1.0, vnoise(vTape.xz * 7.0));
      diffuseColor.rgb = mix(vec3(0.05, 0.42, 0.45), vec3(0.10, 0.55, 0.57), paper * 0.8 + crease);
    `);
  };
  mat.customProgramCacheKey = () => 'amy-tape-v1';
  return mat;
}

// ---------------------------------------------------------------- dust in the sunlight

// Motes drifting inside the frame, lit only where the day is: a slow rise and fall, a twinkle as they
// turn, brighter toward the sun.
export function dustField(uniforms, { count = 900, center = [0, 1.6, -1], area = [20, 3, 14] } = {}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = center[0] + (Math.random() - 0.5) * area[0];
    pos[i * 3 + 1] = center[1] + (Math.random() - 0.5) * area[1];
    pos[i * 3 + 2] = center[2] + (Math.random() - 0.5) * area[2];
    seed[i] = Math.random();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uArea: { value: new THREE.Vector3(...area) }, uCenter: { value: new THREE.Vector3(...center) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSeed; uniform float uTime; uniform vec3 uArea; uniform vec3 uCenter; uniform vec3 uSun;
      varying float vA;
      void main(){
        vec3 p = position;
        float t = uTime * (0.04 + aSeed * 0.05);
        p.x += sin(t * 1.3 + aSeed * 40.0) * 0.6;
        p.y += sin(t * 0.9 + aSeed * 20.0) * 0.35 - mod(uTime * 0.02 * (0.5 + aSeed), uArea.y) + uArea.y * 0.5;
        p.z += cos(t * 1.1 + aSeed * 30.0) * 0.6;
        p.y = uCenter.y - uArea.y * 0.5 + mod(p.y - (uCenter.y - uArea.y * 0.5), uArea.y);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float day = smoothstep(-0.05, 0.15, uSun.y);
        float twinkle = 0.5 + 0.5 * sin(uTime * (2.0 + aSeed * 6.0) + aSeed * 90.0);
        vA = day * (0.25 + 0.75 * twinkle);
        gl_PointSize = (2.0 + aSeed * 3.0) * (160.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA * 0.35;
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.8) * a, a);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.userData.noAO = true;
  pts.name = 'dust';
  return pts;
}

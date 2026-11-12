// Closes the holes Avaturn left in her body where the original suit covered it, by adding triangles
// to the GLB directly. Nothing else in the file changes: no re-export, same vertices, normals, UVs,
// skin weights, textures and materials. Only Body_Mesh gets new faces, fanned over each small open
// loop inside the chosen regions, using the vertices already on the loop.
//
//   node scripts/patch-body-holes.mjs <in.glb> <out.glb> [arms|torso|legs|all ...]
//
// Prints what it closed. Refuses to touch a loop bigger than 40 vertices (the neck, a cuff).
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst, ...regionArgs] = process.argv.slice(2);
if (!src || !dst) { console.error('usage: patch-body-holes.mjs in.glb out.glb [regions]'); process.exit(2); }
const regions = new Set(regionArgs.length ? regionArgs : ['arms']);
const MAX_LOOP = 40;

const glb = readFileSync(src);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
const binHeaderAt = 20 + jsonLen;
const binLen = glb.readUInt32LE(binHeaderAt);
const bin = glb.subarray(binHeaderAt + 8, binHeaderAt + 8 + binLen);

const TYPED = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function accessor(i) {
  const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), n = SIZE[a.type];
  const T = TYPED[a.componentType];
  return { a, data: new T(bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + a.count * n * T.BYTES_PER_ELEMENT)), n };
}

const mesh = json.meshes.find((m) => m.name === 'Body_Mesh');
if (!mesh) { console.error('no Body_Mesh'); process.exit(1); }
const prim = mesh.primitives[0];
const P = accessor(prim.attributes.POSITION), I = accessor(prim.indices);

// Weld by position so a UV seam doesn't look like an open edge.
const canon = new Int32Array(P.a.count);
const seen = new Map();
for (let v = 0; v < P.a.count; v++) {
  const k = `${P.data[v * 3].toFixed(5)},${P.data[v * 3 + 1].toFixed(5)},${P.data[v * 3 + 2].toFixed(5)}`;
  if (!seen.has(k)) seen.set(k, v);
  canon[v] = seen.get(k);
}
// Directed edges of every triangle (welded), so a boundary edge knows which way its one triangle ran.
const directed = new Map(); // "a>b" -> count
const undirected = new Map(); // "min_max" -> count
const originalAt = new Map(); // welded id -> an original index to use in new triangles
for (let t = 0; t < I.a.count; t += 3) {
  const raw = [I.data[t], I.data[t + 1], I.data[t + 2]];
  const w = raw.map((r) => canon[r]);
  raw.forEach((r, k) => { if (!originalAt.has(w[k])) originalAt.set(w[k], r); });
  for (let k = 0; k < 3; k++) {
    const a = w[k], b = w[(k + 1) % 3];
    if (a === b) continue;
    directed.set(`${a}>${b}`, (directed.get(`${a}>${b}`) ?? 0) + 1);
    const u = a < b ? `${a}_${b}` : `${b}_${a}`;
    undirected.set(u, (undirected.get(u) ?? 0) + 1);
  }
}
const boundary = [...undirected].filter(([, n]) => n === 1).map(([e]) => e.split('_').map(Number));
const adj = new Map();
for (const [a, b] of boundary) { (adj.get(a) ?? adj.set(a, []).get(a)).push(b); (adj.get(b) ?? adj.set(b, []).get(b)).push(a); }

const pos = (v) => [P.data[v * 3], P.data[v * 3 + 1], P.data[v * 3 + 2]];
const regionOf = ([x, y]) => (y > 1.45 && Math.abs(x) > 0.25 ? 'arms' : y > 0.95 ? 'torso' : y > 0.02 ? 'legs' : 'feet');
const wanted = (r) => regions.has('all') || regions.has(r);

// Walk closed loops.
const visited = new Set();
const loops = [];
for (const start of adj.keys()) {
  if (visited.has(start)) continue;
  const loop = [];
  let cur = start, prev = -1, closed = false;
  while (!visited.has(cur)) {
    visited.add(cur); loop.push(cur);
    const next = (adj.get(cur) ?? []).filter((x) => x !== prev);
    if (!next.length) break;
    prev = cur; cur = next[0];
    if (cur === start) { closed = true; break; }
  }
  if (closed) loops.push(loop);
}

const newTris = [];
const report = [];
for (const loop of loops) {
  if (loop.length < 3 || loop.length > MAX_LOOP) continue;
  const centre = loop.reduce((c, v) => { const p = pos(v); return [c[0] + p[0] / loop.length, c[1] + p[1] / loop.length, c[2] + p[2] / loop.length]; }, [0, 0, 0]);
  if (!wanted(regionOf(centre))) continue;
  // Fan around the loop. Orientation: the existing triangle ran a>b along each boundary edge, so the
  // new triangle must run b>a to face the same way. Check the first edge and flip the fan if needed.
  const a0 = loop[0], b0 = loop[1];
  const existingRanAB = (directed.get(`${a0}>${b0}`) ?? 0) > 0;
  const order = existingRanAB ? [...loop].reverse() : loop;
  const apex = order[0];
  for (let k = 1; k + 1 < order.length; k++) newTris.push([originalAt.get(apex), originalAt.get(order[k]), originalAt.get(order[k + 1])]);
  report.push(`${regionOf(centre)} loop of ${loop.length} at (${centre.map((v) => v.toFixed(2)).join(', ')})`);
}
if (!newTris.length) { console.log(`patch-body-holes: ${src}: nothing to close in ${[...regions].join(',')}`); writeFileSync(dst, glb); process.exit(0); }

// New index data: the old indices followed by the new triangles, as a fresh buffer view at the end of
// the binary chunk (4-byte aligned), and the primitive's index accessor repointed at it.
const T = TYPED[I.a.componentType];
const combined = new T(I.a.count + newTris.length * 3);
combined.set(I.data, 0);
newTris.flat().forEach((v, i) => { combined[I.a.count + i] = v; });
const pad = (n) => (4 - (n % 4)) % 4;
const newBytes = Buffer.from(combined.buffer);
const newBin = Buffer.concat([bin, Buffer.alloc(pad(bin.length)), newBytes, Buffer.alloc(pad(newBytes.length))]);
json.bufferViews.push({ buffer: 0, byteOffset: bin.length + pad(bin.length), byteLength: newBytes.length, target: 34963 });
json.accessors.push({ bufferView: json.bufferViews.length - 1, byteOffset: 0, componentType: I.a.componentType, count: combined.length, type: 'SCALAR', max: [Math.max(...combined)], min: [Math.min(...combined)] });
prim.indices = json.accessors.length - 1;
json.buffers[0].byteLength = newBin.length;
json.asset.extras = { ...(json.asset.extras ?? {}), patchedBodyHoles: report };

let jsonBytes = Buffer.from(JSON.stringify(json));
jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad(jsonBytes.length), 0x20)]);
const out = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + newBin.length);
out.write('glTF', 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
out.writeUInt32LE(jsonBytes.length, 12); out.writeUInt32LE(0x4E4F534A, 16); jsonBytes.copy(out, 20);
out.writeUInt32LE(newBin.length, 20 + jsonBytes.length); out.writeUInt32LE(0x004E4942, 24 + jsonBytes.length); newBin.copy(out, 28 + jsonBytes.length);
writeFileSync(dst, out);
console.log(`patch-body-holes: ${src} -> ${dst}: closed ${report.length} loop(s) with ${newTris.length} triangles: ${report.join('; ')}`);

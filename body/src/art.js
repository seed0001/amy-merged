import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';
import { changeBackground, checkScene } from './avatar-background.js';

// Her studio: pieces she makes from nothing and keeps working on. A piece is a list of parts, each a
// scene layer (avatar-background.js checkScene: lathe for the wheel, mesh for raw triangles, tube,
// box, sphere, ... with a lit material or her own GLSL). She adds a part, changes one field of one
// part, moves a run of triangles, throws a pot on the wheel by profile, paints, looks, and keeps going.
// Every save keeps the version before it, so a bad stroke can be undone. "show" puts the piece on a
// pedestal in a gallery scene behind her; "place" drops it into whatever scene is up.

const DIR = path.join(DATA_DIR, 'art');
const MAX_PARTS = 40, MAX_VERSIONS = 30;
const file = (id) => path.join(DIR, `${id}.json`);
const valid = (id) => /^[a-f0-9-]{36}$/.test(String(id ?? ''));

function load(id) {
  if (!valid(id) || !existsSync(file(id))) throw new Error('No piece with that id. Use list to see them.');
  return JSON.parse(readFileSync(file(id), 'utf8'));
}
function save(piece) {
  mkdirSync(DIR, { recursive: true });
  piece.updated = Date.now();
  writeFileSync(`${file(piece.id)}.tmp`, JSON.stringify(piece));
  renameSync(`${file(piece.id)}.tmp`, file(piece.id));
  return piece;
}
// Checks the parts as the scene engine will see them, so a bad part is refused with the engine's words.
function checkParts(parts) {
  if (parts.length > MAX_PARTS) throw new Error(`A piece holds at most ${MAX_PARTS} parts.`);
  return checkScene({ layers: parts }).layers.map((l, i) => ({ ...parts[i], name: l.name, geometry: l.geometry }));
}
function keep(piece) {
  piece.versions = [...(piece.versions ?? []), { at: Date.now(), parts: piece.parts }].slice(-MAX_VERSIONS);
}
const summary = (p) => ({ id: p.id, name: p.name, parts: p.parts.length, medium: p.medium, updated: p.updated, note: p.note ?? '' });
const describePart = (part, i) => {
  const shape = part.geometry === 'lathe' ? `profile of ${part.profile.length} points, ${part.profile.at(-1)[1].toFixed(2)} tall` : part.geometry === 'mesh' ? `${part.positions.length / 3} vertices${part.indices ? `, ${part.indices.length / 3} triangles` : `, ${part.positions.length / 9} triangles`}` : part.geometry === 'tube' ? `path of ${part.path.length} points` : `size ${JSON.stringify(part.size ?? [1, 1, 1])}`;
  const look = part.material ? `${part.material.color ?? '#cccccc'}, roughness ${part.material.roughness ?? 0.6}${part.material.metalness ? `, metal ${part.material.metalness}` : ''}${part.material.emissive && part.material.emissive !== '#000000' ? `, glows ${part.material.emissive}` : ''}` : 'her own shader';
  return `${i + 1}. ${part.name} (${part.geometry}: ${shape}; ${look}) at ${JSON.stringify(part.position ?? [0, 0, 0])}`;
};

export function listPieces() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => { try { return summary(JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))); } catch { return null; } }).filter(Boolean).sort((a, b) => b.updated - a.updated);
}
export const readPiece = (id) => load(id);

export function newPiece({ name, medium = 'sculpture', note = '', parts = [] }) {
  const piece = { id: randomUUID(), name: String(name ?? 'untitled').slice(0, 80), medium: String(medium).slice(0, 40), note: String(note).slice(0, 2000), parts: checkParts(parts), versions: [], created: Date.now() };
  activity('art', { piece: piece.name, action: 'new', parts: piece.parts.length });
  return save(piece);
}

// One part by name or number (1-based).
function find(piece, which) {
  const n = Number(which);
  if (Number.isInteger(n) && n >= 1 && n <= piece.parts.length) return n - 1;
  const i = piece.parts.findIndex((p) => p.name?.toLowerCase() === String(which ?? '').toLowerCase());
  if (i < 0) throw new Error(`No part called "${which}". Parts: ${piece.parts.map((p, j) => `${j + 1}. ${p.name}`).join(', ') || 'none yet'}.`);
  return i;
}

export function addPart(id, part) {
  const piece = load(id);
  keep(piece);
  piece.parts = checkParts([...piece.parts, { name: `part ${piece.parts.length + 1}`, ...part }]);
  activity('art', { piece: piece.name, action: 'add_part', part: piece.parts.at(-1).name });
  return save(piece);
}
// A partial change: only the fields given are replaced (position, material.color, profile, ...).
export function setPart(id, which, patch) {
  const piece = load(id);
  const i = find(piece, which);
  keep(piece);
  const was = piece.parts[i];
  const next = { ...was, ...patch, ...(patch.material && was.material ? { material: { ...was.material, ...patch.material } } : {}) };
  piece.parts = checkParts(piece.parts.map((p, j) => (j === i ? next : p)));
  activity('art', { piece: piece.name, action: 'set_part', part: piece.parts[i].name, fields: Object.keys(patch) });
  return save(piece);
}
export function removePart(id, which) {
  const piece = load(id);
  const i = find(piece, which);
  keep(piece);
  const [gone] = piece.parts.splice(i, 1);
  activity('art', { piece: piece.name, action: 'remove_part', part: gone.name });
  return save(piece);
}
// Move a run of vertices of a raw mesh part: indices from..to (1-based, inclusive) by a delta, or set them.
export function shapeMesh(id, which, { from, to, move = null, set = null }) {
  const piece = load(id);
  const i = find(piece, which);
  const part = piece.parts[i];
  if (part.geometry !== 'mesh') throw new Error(`${part.name} is a ${part.geometry}, not a raw mesh. Use set_part to change it.`);
  const count = part.positions.length / 3;
  const a = Math.max(1, Number(from) || 1), b = Math.min(count, Number(to) || a);
  if (a > b) throw new Error(`from (${a}) is past to (${b}); the part has ${count} vertices.`);
  keep(piece);
  const positions = [...part.positions];
  for (let v = a - 1; v < b; v++) {
    if (Array.isArray(set) && set.length === 3) { positions[v * 3] = set[0]; positions[v * 3 + 1] = set[1]; positions[v * 3 + 2] = set[2]; }
    if (Array.isArray(move) && move.length === 3) { positions[v * 3] += move[0]; positions[v * 3 + 1] += move[1]; positions[v * 3 + 2] += move[2]; }
  }
  piece.parts = checkParts(piece.parts.map((p, j) => (j === i ? { ...p, positions } : p)));
  activity('art', { piece: piece.name, action: 'shape_mesh', part: part.name, vertices: `${a}-${b}` });
  return save(piece);
}
// The wheel: a pot is its profile. Pull a point outward or push it in; raise or lower the rim; or hand the whole profile.
export function throwPot(id, which, { profile = null, point = null, radius = null, height = null }) {
  const piece = load(id);
  const i = find(piece, which);
  const part = piece.parts[i];
  if (part.geometry !== 'lathe') throw new Error(`${part.name} is a ${part.geometry}, not on the wheel. Add a lathe part for pottery.`);
  keep(piece);
  let next = profile ? profile : part.profile.map((pt) => [...pt]);
  if (!profile && point != null) {
    const k = Number(point) - 1;
    if (!next[k]) throw new Error(`The profile has ${next.length} points (1 is the base, ${next.length} the rim).`);
    if (radius != null) next[k][0] = Number(radius);
    if (height != null) next[k][1] = Number(height);
  }
  piece.parts = checkParts(piece.parts.map((p, j) => (j === i ? { ...p, profile: next } : p)));
  activity('art', { piece: piece.name, action: 'wheel', part: part.name, points: next.length });
  return save(piece);
}
export function undoPiece(id) {
  const piece = load(id);
  const last = (piece.versions ?? []).pop();
  if (!last) throw new Error('Nothing to undo on this piece.');
  piece.parts = last.parts;
  activity('art', { piece: piece.name, action: 'undo' });
  return save(piece);
}
export function notePiece(id, note) { const piece = load(id); piece.note = String(note ?? '').slice(0, 2000); return save(piece); }
export function deletePiece(id) { const piece = load(id); rmSync(file(id), { force: true }); activity('art', { piece: piece.name, action: 'delete' }); return piece.name; }

// The gallery: the piece on a pedestal, turning slowly, under soft light, as the scene behind her.
export function galleryScene(piece, { spin = 0.25, backdrop = '#1a1c24', floor = '#2a2d36' } = {}) {
  const parts = piece.parts.map((p) => ({ ...p, position: [(p.position?.[0] ?? 0), (p.position?.[1] ?? 0) + 1.1, (p.position?.[2] ?? 0) - 6], spin: p.spin ?? [0, spin, 0], castShadow: true }));
  return {
    name: `Gallery: ${piece.name}`,
    sky: { gradient: [backdrop, '#0b0c11'] },
    fog: { color: '#0b0c11', near: 10, far: 60 },
    lights: [
      { type: 'hemisphere', color: '#dfe6ff', ground: '#2a2420', intensity: 0.9 },
      { type: 'sun', position: [3, 6, -2], color: '#fff1dc', intensity: 2.4 },
      { type: 'point', position: [-4, 3, -4], color: '#9fb8ff', intensity: 18 },
    ],
    layers: [
      { name: 'floor', geometry: 'terrain', size: [40, 40], segments: [1, 1], position: [0, 0, -8], material: { color: floor, roughness: 0.85 }, receiveShadow: true },
      { name: 'pedestal', geometry: 'cylinder', size: [1.4, 1.6, 1.0], segments: [48, 1], position: [0, 0.5, -6], material: { color: '#3b3f4b', roughness: 0.4, metalness: 0.1 } },
      ...parts,
    ],
    camera: { height: 1.8, fov: 42, sway: 0.08, parallax: 0.6, look: [0, 1.9, -6] },
  };
}
export async function showPiece(id, options = {}) {
  const piece = load(id);
  const state = await changeBackground({ action: 'scene', spec: JSON.stringify(galleryScene(piece, options)) });
  activity('art', { piece: piece.name, action: 'show', background: state.value });
  return { piece: summary(piece), background: state };
}
// Into the scene that's up now (or a saved one): the piece's parts become layers at the offset given.
export async function placePiece(id, { into = null, at = [0, 0, -8], spin = 0 } = {}) {
  const piece = load(id);
  const current = into ? await changeBackground({ action: 'read', value: into }) : await changeBackground({ action: 'status' });
  const base = current.spec ?? (current.type === 'scene' ? (await changeBackground({ action: 'read', value: current.value })).spec : null);
  if (!base) throw new Error('No scene is up to place it in. Make a scene first, or use show for the gallery.');
  const parts = piece.parts.map((p) => ({ ...p, name: `${piece.name}: ${p.name}`, position: [(p.position?.[0] ?? 0) + at[0], (p.position?.[1] ?? 0) + at[1], (p.position?.[2] ?? 0) + at[2]], spin: p.spin ?? [0, spin, 0] }));
  const layers = [...base.layers.filter((l) => !l.name.startsWith(`${piece.name}: `)), ...parts];
  const state = await changeBackground({ action: 'scene', spec: JSON.stringify({ ...base, name: base.name.replace(/ \+ .*$/, '') + ` + ${piece.name}`, layers }) });
  activity('art', { piece: piece.name, action: 'place', background: state.value });
  return { piece: summary(piece), background: state };
}

// What she sees of a piece: every part in words, so she can decide the next stroke.
export function describePiece(piece) {
  return [`"${piece.name}" (${piece.medium}), ${piece.parts.length} part(s), ${(piece.versions ?? []).length} earlier version(s) kept.${piece.note ? ` Note: ${piece.note}` : ''}`, ...piece.parts.map(describePart)].join('\n');
}

// The tool's front door.
export async function artAction(args) {
  const { action, id, name, medium, note, part, which, patch, from, to, move, set, profile, point, radius, height, into, at, spin, backdrop, floor } = args;
  switch (action) {
    case 'list': { const all = listPieces(); return all.length ? all.map((p) => `${p.name} [${p.id}] (${p.medium}, ${p.parts} parts, ${new Date(p.updated).toLocaleString()})${p.note ? `: ${p.note.slice(0, 80)}` : ''}`).join('\n') : 'No pieces yet. Start one with new.'; }
    case 'new': { const p = newPiece({ name, medium, note, parts: Array.isArray(part) ? part : part ? [part] : [] }); return `Started "${p.name}" [${p.id}].\n${describePiece(p)}`; }
    case 'read': return JSON.stringify(load(id));
    case 'describe': return describePiece(load(id));
    case 'add_part': { if (!part || typeof part !== 'object') throw new Error('add_part needs part: a layer object (geometry, size or profile or positions, material or shader, position).'); const p = addPart(id, part); return `Added ${p.parts.at(-1).name}.\n${describePiece(p)}`; }
    case 'set_part': { if (!patch || typeof patch !== 'object') throw new Error('set_part needs which (name or number) and patch: the fields to change.'); const p = setPart(id, which, patch); return `Changed ${p.parts[find(p, which)].name}.\n${describePiece(p)}`; }
    case 'remove_part': { const p = removePart(id, which); return `Removed it.\n${describePiece(p)}`; }
    case 'shape_mesh': { const p = shapeMesh(id, which, { from, to, move, set }); return `Shaped ${p.parts[find(p, which)].name}, vertices ${from}-${to ?? from}.`; }
    case 'wheel': { const p = throwPot(id, which, { profile, point, radius, height }); const prt = p.parts[find(p, which)]; return `On the wheel: ${prt.name} now has ${prt.profile.length} profile points, ${prt.profile.at(-1)[1].toFixed(2)} tall, rim radius ${prt.profile.at(-1)[0].toFixed(2)}.`; }
    case 'undo': { const p = undoPiece(id); return `Undid the last change.\n${describePiece(p)}`; }
    case 'note': { notePiece(id, note); return 'Noted.'; }
    case 'show': { const r = await showPiece(id, { spin, backdrop, floor }); return `"${r.piece.name}" is on the pedestal behind you (background ${r.background.value}). Check avatar_background status for the browser report before saying it shows.`; }
    case 'place': { const r = await placePiece(id, { into, at: Array.isArray(at) && at.length === 3 ? at : [0, 0, -8], spin }); return `"${r.piece.name}" is placed in the scene (background ${r.background.value}). Check avatar_background status.`; }
    case 'delete': return `Deleted "${deletePiece(id)}".`;
    default: throw new Error('Use list, new, read, describe, add_part, set_part, remove_part, shape_mesh, wheel, undo, note, show, place or delete.');
  }
}

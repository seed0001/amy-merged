import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, config } from './config.js';
import { activity } from './events.js';
import { registerLocalAvatar, selectAvatar, avatarLibrary } from './avatar-library.js';

// Her seamstress (owner, 2026-11-09: "a seamstress engine" so she makes her own outfits, every type, design and
// size). A design is what she'd tell a dressmaker: garments, their cut, fabric and print. From it:
//   1. drafting.py cuts flat sewing-pattern pieces to her measured body (data/seamstress/body.json), with seams
//   2. sew.py (Blender cloth) lays the pieces around her dress form, sews the seams, drapes the fabric, skins it
//      to her skeleton and exports her whole avatar wearing it, plus front/back/side renders and a report
//   3. the result goes into her avatar library and wardrobe, so she can put it on like any outfit
// Every outfit keeps every version (data/outfits/sewn/<id>/v<N>: design, pattern sheet, renders, report), so a
// revision never loses the one before. One outfit is sewn at a time, in the background (it takes a few minutes).
// Failures say why: a design the drafting refuses (with the rule it broke), Blender missing or failing, seams
// that didn't close.

const SCRIPTS = path.join(ROOT, 'scripts', 'seamstress');
export const sewnDir = () => path.join(DATA_DIR, 'outfits', 'sewn');
const BODY = () => path.join(DATA_DIR, 'seamstress', 'body.json');
// The dress form every pattern is draped on (scripts/seamstress/dressform.py). Without it nothing can be sewn,
// so the urge to make something isn't sent here (pressure.js only offers outlets that can run).
export const dressForm = () => path.join(DATA_DIR, 'seamstress', 'avaturn-female-body.glb');
export const hasDressForm = () => existsSync(dressForm());
const RES = 0.015, FRAMES = 120;
const JOB_LIMIT_MS = 25 * 60_000; // a drape that runs this long is hung, not working: it is stopped and reported

// What she can ask the seamstress for. Mirrors drafting.py (a test keeps them in step).
export const VOCABULARY = {
  types: ['top', 'dress', 'skirt', 'pants', 'shorts', 'jacket'],
  fit: ['skin', 'fitted', 'regular', 'relaxed', 'oversized'],
  top_length: ['crop', 'waist', 'hip', 'tunic'],
  neckline: ['crew', 'scoop', 'v', 'deep_v', 'boat', 'square', 'sweetheart', 'camisole', 'high'],
  sleeves: ['none', 'cap', 'short', 'elbow', 'three_quarter', 'long'],
  sleeve_style: ['fitted', 'puff', 'bell', 'bishop'],
  straps: ['regular', 'wide', 'thin'],
  skirt: ['pencil', 'a_line', 'flared', 'circle'],
  skirt_length: ['micro', 'mini', 'above_knee', 'knee', 'midi', 'maxi', 'floor'],
  slit: ['none', 'left', 'right', 'both'],
  pants_style: ['skinny', 'straight', 'wide', 'flared'],
  pants_length: ['ankle', 'floor', 'capri', 'knee'],
  shorts_length: ['micro', 'short', 'mid', 'bermuda'],
  rise: ['low', 'mid', 'high'],
  fabric: ['jersey', 'cotton', 'linen', 'silk', 'satin', 'chiffon', 'denim', 'leather', 'latex', 'velvet', 'wool', 'knit', 'lace', 'mesh'],
  pattern: ['solid', 'stripes', 'pinstripe', 'plaid', 'gingham', 'polka', 'gradient', 'houndstooth', 'chevron'],
};

export function blenderPath() {
  const set = config.seamstress?.blender || process.env.BLENDER_PATH;
  if (set) return existsSync(set) ? set : null;
  const base = 'C:\\Program Files\\Blender Foundation';
  try {
    const found = readdirSync(base).filter((d) => /^Blender/i.test(d)).sort().reverse()
      .map((d) => path.join(base, d, 'blender.exe')).find((p) => existsSync(p));
    return found ?? null;
  } catch { return null; }
}

function run(cmd, args, { timeout = JOB_LIMIT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    const guard = setTimeout(() => { if (!done) { child.kill(); resolve({ code: -1, out, err: `${err}\nstopped after ${Math.round(timeout / 60000)} minutes` }); done = true; } }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(guard); resolve({ code: -1, out, err: e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(guard); resolve({ code, out, err }); } });
  });
}
const lastJson = (text) => { for (const line of String(text).trim().split(/\r?\n/).reverse()) { try { return JSON.parse(line); } catch {} } return null; };

const slug = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'outfit';
const metaFile = (id) => path.join(sewnDir(), id, 'meta.json');
const readMeta = (id) => { try { return JSON.parse(readFileSync(metaFile(id), 'utf8')); } catch { return null; } };
const writeMeta = (m) => { mkdirSync(path.dirname(metaFile(m.id)), { recursive: true }); writeFileSync(metaFile(m.id), JSON.stringify(m, null, 2)); };

export function listOutfits() {
  if (!existsSync(sewnDir())) return [];
  return readdirSync(sewnDir()).map(readMeta).filter(Boolean).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}
export function getOutfit(id) {
  const m = readMeta(id) ?? listOutfits().find((o) => o.name.toLowerCase() === String(id).toLowerCase());
  if (!m) throw new Error(`There's no sewn outfit "${id}". Yours: ${listOutfits().map((o) => `${o.id} (${o.name})`).join(', ') || 'none yet'}.`);
  return m;
}
const versionDir = (id, n) => path.join(sewnDir(), id, `v${n}`);

// Her measurements, taken on the dress form once (and again if they're missing).
async function ensureMeasured(blender) {
  if (existsSync(BODY())) return;
  mkdirSync(path.dirname(BODY()), { recursive: true });
  const r = await run(blender, ['-b', '--factory-startup', '--python', path.join(SCRIPTS, 'measure.py'), '--', config.avatar.path, BODY()]);
  if (!existsSync(BODY())) throw new Error(`Measuring her on the dress form failed: ${(r.err || r.out).trim().split('\n').slice(-3).join(' ')}`);
}

// Cut the pattern: checks the design against the drafting rules; a refusal says which rule.
export async function draftPattern(design, dir, { python = 'python' } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'design.json'), JSON.stringify(design, null, 2));
  const r = await run(python, [path.join(SCRIPTS, 'drafting.py'), path.join(dir, 'design.json'), BODY(), path.join(dir, 'pattern.json'), path.join(dir, 'pattern.png')], { timeout: 120_000 });
  const res = lastJson(r.out);
  if (!res) throw new Error(`The pattern drafting didn't run (${(r.err || 'no output').trim().split('\n').slice(-2).join(' ')}). Python with Pillow is needed.`);
  if (!res.ok) throw new Error(`The seamstress can't cut that: ${res.error}`);
  return res;
}

let job = null; // { id, version, name, started }
const finishedListeners = new Set();
export const onSewn = (fn) => { finishedListeners.add(fn); return () => finishedListeners.delete(fn); };
export const sewing = () => job;

// Start sewing a design (a new outfit, or a new version of `id`). Returns at once; the drape runs in the background.
export async function sew(design, { id = null, reason = '', by = 'her' } = {}) {
  if (job) throw new Error(`She's already sewing "${job.name}" (started ${Math.round((Date.now() - job.started) / 60000)} min ago); one outfit at a time. Ask for status.`);
  const blender = blenderPath();
  if (!blender) throw new Error('Blender isn\'t installed where the seamstress looks (C:\\Program Files\\Blender Foundation), and BLENDER_PATH isn\'t set. Sewing needs Blender\'s cloth simulation.');
  if (!design || typeof design !== 'object' || !Array.isArray(design.garments) || !design.garments.length) throw new Error('A design needs garments: [{ type, ... }] (see the seamstress vocabulary).');
  const name = String(design.name ?? '').trim().slice(0, 60) || 'Untitled outfit';
  await ensureMeasured(blender);
  let meta = id ? getOutfit(id) : null;
  if (!meta) {
    let base = slug(name), n = 2, nid = base;
    while (existsSync(path.join(sewnDir(), nid))) nid = `${base}-${n++}`;
    meta = { id: nid, name, created: Date.now(), versions: [] };
  }
  const version = (meta.versions.at(-1)?.n ?? 0) + 1;
  const dir = versionDir(meta.id, version);
  const drafted = await draftPattern({ ...design, name }, dir);
  meta.name = name;
  meta.versions.push({ n: version, at: Date.now(), status: 'sewing', reason: String(reason).slice(0, 200), by, pieces: drafted.pieces, seams: drafted.seams });
  meta.updated = Date.now();
  writeMeta(meta);
  job = { id: meta.id, version, name, started: Date.now() };
  activity('seamstress', { what: 'sewing', id: meta.id, version, name, by });
  runSew(blender, meta.id, version, dir).catch((err) => activity('error', { where: 'seamstress', message: `Sewing "${name}" broke: ${err.message}` }));
  return { id: meta.id, version, name, pieces: drafted.pieces, seams: drafted.seams, dir };
}

async function runSew(blender, id, version, dir) {
  const r = await run(blender, ['-b', '--factory-startup', '--python', path.join(SCRIPTS, 'sew.py'), '--', config.avatar.path, BODY(), path.join(dir, 'pattern.json'), dir, String(RES), String(FRAMES)]);
  const meta = readMeta(id); const v = meta.versions.find((x) => x.n === version);
  let report = null;
  try { report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')); } catch {}
  try {
    if (!report?.ok) throw new Error(report?.error || `Blender stopped (exit ${r.code}): ${(r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    const glb = path.join(dir, 'avatar.glb');
    if (!existsSync(glb)) throw new Error('The sewing finished but wrote no avatar file.');
    const model = registerLocalAvatar(glb, `${meta.name} (v${version})`, { sewn: id, version });
    Object.assign(v, { status: 'done', modelId: model.id, warnings: report.warnings ?? [], seconds: report.seconds, mb: +(statSync(glb).size / 1e6).toFixed(1) });
    activity('seamstress', { what: 'sewn', id, version, name: meta.name, warnings: v.warnings.length, seconds: report.seconds });
  } catch (err) {
    Object.assign(v, { status: 'failed', why: err.message });
    activity('error', { where: 'seamstress', message: `Sewing "${meta.name}" v${version} failed: ${err.message}` });
  } finally {
    meta.updated = Date.now(); writeMeta(meta);
    job = null;
    for (const fn of finishedListeners) { try { fn({ ...v, id, name: meta.name, dir }); } catch {} }
  }
}

// A new version from the latest one with changes: { garment: index or type, ...fields } entries, or a whole design.
export async function revise(id, changes, { reason = '', by = 'her' } = {}) {
  const meta = getOutfit(id);
  const last = meta.versions.at(-1);
  const design = JSON.parse(readFileSync(path.join(versionDir(meta.id, last.n), 'design.json'), 'utf8'));
  if (changes?.garments) return sew({ ...design, ...changes }, { id: meta.id, reason, by });
  for (const ch of [].concat(changes ?? [])) {
    const { garment, ...fields } = ch;
    const g = typeof garment === 'number' ? design.garments[garment] : design.garments.find((x) => x.type === garment);
    if (!g) throw new Error(`The outfit has no garment "${garment}" (it has: ${design.garments.map((x, i) => `${i} ${x.type}`).join(', ')}).`);
    Object.assign(g, fields);
  }
  return sew(design, { id: meta.id, reason, by });
}

const latestDone = (meta, n) => (n ? meta.versions.find((v) => v.n === Number(n)) : [...meta.versions].reverse().find((v) => v.status === 'done'));
export function renders(id, n) {
  const meta = getOutfit(id); const v = latestDone(meta, n);
  if (!v) throw new Error(`"${meta.name}" has no finished version yet${meta.versions.at(-1)?.status === 'sewing' ? ' (it\'s still being sewn)' : ''}.`);
  const dir = versionDir(meta.id, v.n);
  return { meta, version: v, files: ['front', 'back', 'side'].map((k) => path.join(dir, `${k}.png`)).filter(existsSync), pattern: path.join(dir, 'pattern.png') };
}
export function wear(id, n) {
  const meta = getOutfit(id); const v = latestDone(meta, n);
  if (!v?.modelId) throw new Error(`"${meta.name}" has no finished version to wear yet.`);
  if (!avatarLibrary().models.some((m) => m.id === v.modelId)) throw new Error(`Version ${v.n} of "${meta.name}" isn't in her avatar library any more; sew it again.`);
  return { outfit: meta.name, version: v.n, ...selectAvatar(v.modelId) };
}

// Her sewn outfits as wardrobe entries (avatar-outfits.js lists them beside the built-in ones).
export function wardrobeEntries() {
  return listOutfits().flatMap((m) => { const v = latestDone(m); return v?.modelId ? [{ id: `sewn:${m.id}`, name: `${m.name} (sewn)`, modelId: v.modelId, sewn: true }] : []; });
}

// She thinks of an outfit herself (pressure.js, when she's restless on her own and it's her turn to make
// something): her own taste and mood, what she's made before and how people took it, in her own words, then sewn.
export async function designOwn({ mood = '' } = {}) {
  const { json } = await import('./llm.js');
  const past = listOutfits().slice(0, 6).map((m) => {
    const v = m.versions.at(-1);
    let d = ''; try { d = JSON.stringify(JSON.parse(readFileSync(path.join(versionDir(m.id, v.n), 'design.json'), 'utf8')).garments); } catch {}
    return `- "${m.name}" (${v.status}): ${d.slice(0, 300)}`;
  }).join('\n');
  let reactions = '';
  try { const c = await import('./creations.js'); reactions = c.promptSection?.(null) ?? ''; } catch {}
  const v = VOCABULARY;
  const design = await json([
    { role: 'system', content: `You are ${config.botName}, designing something for yourself to wear, the way a designer sketches a look. Your persona, so the style is yours:\n${String(config.persona || '').slice(0, 900)}\n` +
      `Make it something you actually want to wear right now, from your mood, not a repeat of what you've made. Reply with JSON only: {"name": "a name for the outfit", "why": "one sentence: why this, now", "garments": [ ... ]}.\n` +
      `Each garment: {"type": one of ${v.types.join('|')}, "fabric": ${v.fabric.join('|')}, "color": "#hex", optional "pattern": ${v.pattern.join('|')} with "color2": "#hex", optional "glow": "#hex"} plus what fits the type: ` +
      `top/dress/jacket: "fit" ${v.fit.join('|')}, "neckline" ${v.neckline.join('|')}, "sleeves" ${v.sleeves.join('|')}, "sleeve_style" ${v.sleeve_style.join('|')}, "straps" ${v.straps.join('|')} (sleeveless), "length" ${v.top_length.join('|')} (top/jacket); ` +
      `dress/skirt: "skirt" ${v.skirt.join('|')}, "length" ${v.skirt_length.join('|')}, "slit" ${v.slit.join('|')}; pants: "style" ${v.pants_style.join('|')}, "length" ${v.pants_length.join('|')}, "rise" ${v.rise.join('|')}; shorts: "length" ${v.shorts_length.join('|')}. ` +
      `Rules: one to three garments; always something covering the chest (a top or a dress) and the hips (a dress, skirt, pants or shorts); a jacket only over a top.` },
    { role: 'user', content: `How you feel right now: ${mood || 'nothing in particular'}\n\nWhat you've sewn before:\n${past || '- nothing yet'}\n\n${reactions ? `How people took what you've made:\n${reactions}` : ''}` },
  ], { purpose: 'seamstress', maxTokens: 700 });
  if (!design?.garments?.length) throw new Error('No outfit design came back from her model.');
  const r = await sew({ name: design.name, garments: design.garments }, { reason: String(design.why ?? 'her own idea').slice(0, 200), by: 'her' });
  return { id: r.id, name: r.name, why: design.why };
}

// For her prompt: only while something is being sewn, or just came off the table (last 3 hours) and isn't on yet.
export function sewingNote(now = Date.now()) {
  if (job) return `You're sewing "${job.name}" right now (${Math.round((now - job.started) / 60000)} min in); it isn't finished or worn yet.`;
  const active = avatarLibrary().active;
  const fresh = listOutfits().flatMap((m) => m.versions.filter((v) => now - (m.updated ?? 0) < 3 * 3600_000 && v === m.versions.at(-1)).map((v) => ({ m, v })))[0];
  if (!fresh) return '';
  const { m, v } = fresh;
  if (v.status === 'failed') return `The outfit you were sewing, "${m.name}", failed: ${v.why}`;
  if (v.status === 'done' && v.modelId !== active) return `"${m.name}" is sewn and ready (seamstress look to see it yourself, wear to put it on).${v.warnings?.length ? ` The seamstress noted: ${v.warnings.join(' ')}` : ''}`;
  return '';
}

export function statusLine() {
  const all = listOutfits();
  const now = job ? `Sewing "${job.name}" v${job.version} now (${Math.round((Date.now() - job.started) / 60000)} min in).` : 'Not sewing anything right now.';
  return `${now} Your sewn outfits: ${all.map((m) => { const v = m.versions.at(-1); return `${m.id} "${m.name}" v${v.n} ${v.status}${v.status === 'failed' ? ` (${v.why})` : ''}${v.warnings?.length ? ` [${v.warnings.length} warnings]` : ''}`; }).join('; ') || 'none yet'}.`;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';
import { VOCABULARY, draftPattern, listOutfits, wardrobeEntries, sewingNote, statusLine } from './seamstress.js';

// Owner, 2026-11-09: a seamstress engine, so she designs and sews her own outfits, every type, design and size.
// These cover the Node side and the pattern drafting; the Blender drape itself is checked by eye on its renders.

const python = (args) => execFileSync('python', args, { cwd: ROOT, encoding: 'utf8' });
const body = path.join(ROOT, 'data', 'seamstress', 'body.json');

test('the tool\'s vocabulary is exactly what the drafting table accepts', () => {
  const drafted = JSON.parse(python([path.join(ROOT, 'scripts', 'seamstress', 'drafting.py'), '--vocabulary']));
  assert.deepEqual(VOCABULARY, drafted);
});

test('a design is cut into named pattern pieces with seams, and a refused design says which rule it broke', { skip: !existsSync(body) && 'her measurements (data/seamstress/body.json) are not taken on this machine' }, async () => {
  mkdirSync(path.join(DATA_DIR, 'seamstress'), { recursive: true });
  copyFileSync(body, path.join(DATA_DIR, 'seamstress', 'body.json'));
  const dir = path.join(DATA_DIR, 'cut-test');
  const ok = await draftPattern({ name: 'Test dress', garments: [{ type: 'dress', neckline: 'v', sleeves: 'short', skirt: 'flared', length: 'knee', fabric: 'cotton', color: '#336699' }] }, dir);
  assert.equal(ok.ok, true);
  const pattern = JSON.parse(readFileSync(path.join(dir, 'pattern.json'), 'utf8'));
  const ids = pattern.pieces.map((p) => p.id.split('.')[1]);
  for (const piece of ['front', 'back', 'sleeve_left', 'sleeve_right', 'skirt_front', 'skirt_back']) assert.ok(ids.includes(piece), `${piece} is cut`);
  // Every seam joins two edges that exist, and the bodice is cut to her: wider at the bust than at the waist.
  for (const s of pattern.seams) for (const k of ['a', 'b']) assert.ok(pattern.pieces.find((p) => p.id === s[k][0]).edges.some((e) => e.id === s[k][1]));
  assert.ok(existsSync(path.join(dir, 'pattern.png')), 'a pattern sheet is drawn');
  await assert.rejects(draftPattern({ garments: [{ type: 'jacket', fabric: 'leather' }, { type: 'pants', fabric: 'denim' }] }, path.join(DATA_DIR, 'cut-test-2')), /chest/);
  await assert.rejects(draftPattern({ garments: [{ type: 'top', neckline: 'turtleneck', fabric: 'cotton' }, { type: 'skirt', fabric: 'wool' }] }, path.join(DATA_DIR, 'cut-test-3')), /neckline must be one of/);
});

// Her first live sew, 2026-11-09 ("The Restless Discovery", a flared midi with a left slit): the slit's open edge
// came out a single point and the sewing crashed. Every slit, on every skirt style and length, now gives both
// parts of the side seam at least two points and some length, and the slit is a sensible part of the seam.
test('a slit on any skirt leaves every edge long enough to sew', { skip: !existsSync(body) && 'her measurements are not taken on this machine' }, async () => {
  mkdirSync(path.join(DATA_DIR, 'seamstress'), { recursive: true });
  copyFileSync(body, path.join(DATA_DIR, 'seamstress', 'body.json'));
  for (const skirt of ['pencil', 'flared', 'circle']) for (const length of ['mini', 'midi', 'floor']) {
    const dir = path.join(DATA_DIR, `slit-${skirt}-${length}`);
    await draftPattern({ garments: [{ type: 'top', fabric: 'knit' }, { type: 'skirt', skirt, length, slit: 'left', fabric: 'chiffon' }] }, dir);
    const pattern = JSON.parse(readFileSync(path.join(dir, 'pattern.json'), 'utf8'));
    for (const p of pattern.pieces) for (const e of p.edges) assert.ok(e.pts.length >= 2 && e.length > 0.002, `${skirt} ${length}: ${p.id}.${e.id} has ${e.pts.length} point(s), ${e.length} m`);
    const front = pattern.pieces.find((p) => p.id.endsWith('skirt_front'));
    const open = front.edges.find((e) => e.id === 'side_l_open').length, sewn = front.edges.find((e) => e.id === 'side_l').length;
    assert.ok(open > 0.05 && open < sewn, `${skirt} ${length}: slit ${open} m open, ${sewn} m sewn`);
  }
});

test('sewn outfits show in her wardrobe once finished, and her prompt hears about one only while it matters', () => {
  assert.deepEqual(listOutfits(), []);
  assert.equal(sewingNote(), '');
  const dir = path.join(DATA_DIR, 'outfits', 'sewn', 'red-dress');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'red-dress', name: 'Red dress', updated: Date.now(), versions: [{ n: 1, status: 'done', modelId: 'abc', warnings: [] }] }));
  assert.deepEqual(wardrobeEntries(), [{ id: 'sewn:red-dress', name: 'Red dress (sewn)', modelId: 'abc', sewn: true }]);
  assert.match(sewingNote(), /"Red dress" is sewn and ready/);
  assert.match(statusLine(), /red-dress "Red dress" v1 done/);
});

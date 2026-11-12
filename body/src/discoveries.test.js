import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiscoveries } from './discoveries.js';

const tools = () => ['generate_music', 'generate_self_image', 'avatar_outfit', 'guide', 'doctor'];
const describe = (t) => ({ generate_music: 'Write and generate a full song with vocals. Takes a minute.', generate_self_image: 'Make a picture of yourself.', avatar_outfit: 'Wear or recolor clothing on your 3D avatar.' })[t] ?? '';

test('abilities start untried; the first success is a discovery and lowers the need', () => {
  let now = 1000;
  const discovered = [];
  const d = createDiscoveries({ file: path.join(mkdtempSync(path.join(tmpdir(), 'disc-')), 'd.json'), tools, describe, now: () => now, onDiscovered: (t) => discovered.push(t) });
  assert.deepEqual(d.untried(), ['generate_music', 'generate_self_image', 'avatar_outfit']); // plumbing excluded
  assert.equal(d.need(), 1);
  assert.equal(d.tried('generate_music'), true);
  assert.equal(d.tried('generate_music'), false); // only the first time
  assert.equal(d.tried('guide'), false); // plumbing never counts
  assert.deepEqual(discovered, ['generate_music']);
  assert.deepEqual(d.recent(), ['generate_music']);
  now += 31 * 60_000;
  assert.deepEqual(d.recent(), []);
  assert.equal(d.need(), 1, 'two of three still untried: the need stays full');
  d.tried('generate_self_image');
  assert.ok(d.need() < 1 && d.need() > 0, 'one of three left: the need falls');
});

test('the discovery want picks an untried ability not shown before, with what it does', () => {
  const d = createDiscoveries({ file: path.join(mkdtempSync(path.join(tmpdir(), 'disc-')), 'd.json'), tools, describe });
  const seen = new Set();
  for (let i = 0; i < 3; i++) { const p = d.pick(); assert.ok(p.text.length > 3); seen.add(p.tool); }
  assert.equal(seen.size, 3, 'three picks, three different abilities');
  assert.ok(d.pick(), 'once all are shown it still picks from the untried');
  for (const t of tools()) d.tried(t);
  assert.equal(d.pick(), null);
  assert.equal(d.need(), 0);
});

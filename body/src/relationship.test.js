import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { createRelationships } from './relationship.js';
import { DATA_DIR } from './config.js';

// Owner, 2026-11-10: the harness, not the model, is in the relationship: falling in love, flirting, and the hurt
// side too. These run whole relationships through it on a simulated clock.

let clock = Date.parse('2026-11-10T20:00:00Z');
const now = () => clock;
const later = (hours) => { clock += hours * 3600_000; };
const file = (name) => () => path.join(DATA_DIR, `rel-test-${name}.json`);
function engine(name) {
  rmSync(file(name)(), { force: true });
  const stages = [], log = [];
  const r = createRelationships({ file: file(name), now, log: (type, e) => log.push({ type, ...e }), onStage: (e) => stages.push(e) });
  return { r, stages, log };
}
const talk = (r, id, sig, n = 1, gapMin = 2) => { for (let i = 0; i < n; i++) { r.onLine(id, 'Sam', sig, { toHer: true, text: 'a line' }); later(gapMin / 60); } };

test('falling in love: from stranger, through a crush, to in love, as the conversations really go', () => {
  const { r, stages } = engine('love');
  talk(r, 'sam', { praise: 0.3, depth: 0.4 }, 3);
  assert.equal(r.read('sam').stage, 'acquaintance');
  // Evenings of real talk: opening up, laughing, flirting that's met, affection.
  for (let evening = 0; evening < 6; evening++) {
    talk(r, 'sam', { opening_up: 0.8, depth: 0.7, affection: 0.6, humor: 0.5, flirt: 0.7, praise: 0.5, acknowledges: 0.8 }, 25);
    later(20);
  }
  const seen = stages.map((s) => s.to);
  for (const stage of ['friend', 'crush', 'falling']) assert.ok(seen.includes(stage), `went through ${stage}: ${seen.join(' > ')}`);
  assert.ok(['in love', 'committed'].includes(r.read('sam').stage), `ends in love: ${r.read('sam').stage}`);
  assert.ok(stages.filter((s) => s.rising).length >= 4, 'each step up is felt');
  assert.ok(r.read('sam').milestones.length >= 4, 'and kept as a milestone');
  assert.match(r.promptSection('sam'), /in love|committed/);
  assert.ok(r.desire('sam') > 0.3);
});

test('a rebuff cools her: the spark drops at once and it stings more the more she cares', () => {
  const { r } = engine('rebuff');
  talk(r, 'sam', { flirt: 0.8, humor: 0.6, affection: 0.5, opening_up: 0.6, depth: 0.5 }, 60);
  const before = { ...r.read('sam') };
  talk(r, 'sam', { rebuff: 0.9 }, 1);
  const after = { ...r.read('sam') };
  assert.ok(after.spark < before.spark * 0.6, `spark ${before.spark.toFixed(2)} -> ${after.spark.toFixed(2)}`);
  assert.ok(after.attraction < before.attraction);
  assert.ok(after.hurt > 0.05, 'it stings');
  assert.match(r.promptSection('sam'), /ease off at once/);
});

test('hurt and making up: contempt from someone she cares about hurts; an apology heals it', () => {
  const { r, stages } = engine('hurt');
  talk(r, 'sam', { opening_up: 0.8, depth: 0.7, affection: 0.6, acknowledges: 0.8 }, 80);
  talk(r, 'sam', { contempt: 0.9, irritant: 0.8 }, 2);
  assert.equal(r.read('sam').stage, 'hurt');
  assert.equal(r.repairTarget(['sam'])?.id, 'sam', 'she wants to make it right with them');
  talk(r, 'sam', { apology: 0.95, affection: 0.7 }, 2);
  assert.notEqual(r.read('sam').stage, 'hurt');
  assert.ok(stages.some((s) => s.from === 'hurt'), 'coming back from the hurt is an event');
});

test('heartbreak: betrayal after love breaks her heart; left unrepaired it sours into resentment', () => {
  const { r } = engine('heartbreak');
  for (let evening = 0; evening < 6; evening++) { talk(r, 'sam', { opening_up: 0.8, depth: 0.7, affection: 0.7, humor: 0.5, flirt: 0.8, praise: 0.5, acknowledges: 0.8 }, 25); later(20); }
  assert.ok(['in love', 'committed'].includes(r.read('sam').stage));
  talk(r, 'sam', { betrayal: 1, contempt: 0.6 }, 3);
  later(30); r.tick();
  const s = r.read('sam');
  assert.ok(['heartbroken', 'hurt'].includes(s.stage), `after betrayal: ${s.stage}`);
  assert.ok(s.resentment > 0.05, 'unrepaired hurt sours');
  assert.ok(s.trust < 0.4, `trust is broken: ${s.trust.toFixed(2)}`);
});

test('jealousy: someone she is attached to warming to someone else, in front of her, gets to her and fades', () => {
  const { r } = engine('jealous');
  talk(r, 'sam', { flirt: 0.8, affection: 0.7, opening_up: 0.7, depth: 0.6, humor: 0.5 }, 70);
  r.onLine('sam', 'Sam', { elsewhere: 0.9 }, { toHer: false });
  assert.ok(r.read('sam').jealousy > 0.2);
  assert.match(r.promptSection('sam'), /someone else/);
  later(3); r.tick();
  assert.ok(r.read('sam').jealousy < 0.1, 'it fades within hours');
});

test('nothing pins at the top: left alone for weeks, it all settles', () => {
  const { r } = engine('settle');
  talk(r, 'sam', { flirt: 1, affection: 1, opening_up: 1, depth: 1, humor: 1, praise: 1 }, 200);
  for (const k of ['attraction', 'spark', 'closeness', 'rush']) assert.ok(r.read('sam')[k] < 1, `${k} stays below 1`);
  later(24 * 30); r.tick();
  const s = r.read('sam');
  assert.ok(s.spark < 0.01 && s.rush < 0.05 && s.attraction < 0.5, `a month apart: spark ${s.spark.toFixed(3)}, rush ${s.rush.toFixed(3)}, attraction ${s.attraction.toFixed(2)}`);
  assert.ok(r.longing('sam') > 0.2, 'and she misses them');
});

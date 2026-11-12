import test from 'node:test';
import assert from 'node:assert/strict';
import { createBody, KNOWN_MOVES } from './body.js';
import { GESTURES } from './emotion.js';

function rig({ moods = {}, tired = 0, watching = true, sleeping = false } = {}) {
  const clock = { t: 1_000_000 }, sent = [];
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const b = createBody({ moods: () => moods, tired: () => tired, watching: () => watching, sleeping: () => sleeping,
    emit: (items) => sent.push(items), random, now: () => clock.t });
  // Ten pressure ticks of a minute each.
  const run = (minutes) => { const all = []; for (let i = 0; i < minutes; i++) { all.push(...b.plan(60_000).map((x) => ({ ...x, abs: clock.t + x.at }))); clock.t += 60_000; } return all; };
  return { b, sent, run };
}

test('each pressure tick plans her next minute: a few moves, never on top of each other', () => {
  const { run } = rig({ moods: { boredom: 0.3, restlessness: 0.3 } });
  const moves = run(10);
  assert.ok(moves.length >= 8 && moves.length <= 60, `moves in 10 min: ${moves.length}`);
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i].abs >= moves[i - 1].abs, 'in order');
  assert.ok(moves.every((m) => m.at >= 0 && m.at < 60_000), 'each plan covers only its own minute');
});

test('nobody watching, or asleep: no plan at all', () => {
  for (const r of [rig({ watching: false }), rig({ sleeping: true })]) assert.equal(r.run(10).length, 0);
});

test('her mood picks the moves and how long they last', () => {
  const count = (moves, names) => moves.filter((p) => names.includes(p.name)).length;
  const restless = rig({ moods: { restlessness: 1 } }).run(20), uneasy = rig({ moods: { unease: 1 } }).run(20), calm = rig({ moods: { restlessness: 0 } }).run(30);
  assert.ok(count(restless, ['settle', 'shoulder_roll']) > count(uneasy, ['settle', 'shoulder_roll']), 'restless shifts and rolls her shoulders more');
  assert.ok(count(uneasy, ['lip_press', 'deep_breath']) > count(restless, ['lip_press', 'deep_breath']), 'uneasy presses her lips and breathes more');
  const longest = (moves) => Math.max(...moves.filter((p) => p.name === 'settle').map((p) => p.ms));
  assert.ok(longest(restless) > longest(calm), 'a stronger mood plays the move longer');
});

test('a sequence she names plays its moves back to back, now; every move can be tagged', () => {
  const { b, sent } = rig();
  const items = b.perform('settle_in', 0.5);
  assert.deepEqual(items.map((i) => i.name), ['deep_breath', 'shoulder_roll', 'neck_stretch']);
  assert.ok(items.every((i) => i.force), 'played even mid-sentence: she asked for it');
  assert.ok(items[1].at > items[0].at && items[2].at > items[1].at);
  assert.equal(sent.length, 1);
  for (const name of KNOWN_MOVES) assert.ok(GESTURES.includes(name), `${name} can be named in a [[do: ...]] tag`);
});

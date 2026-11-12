import test from 'node:test';
import assert from 'node:assert/strict';
import * as clock from './peer-clock.js';

const MIN = 60_000;
const topics = ['the garden tomatoes need water', 'a movie we watched last night', 'fishing trips up north', 'old cars and engines'];

test('no nudge early on; a nudge after about four and a half minutes of bots talking alone', () => {
  clock._reset();
  const c = 'voice:1';
  clock.heard(c, { peer: true, text: topics[0], now: 0 });
  assert.equal(clock.block(c, { now: 2 * MIN }), '');
  for (let i = 1; i <= 5; i++) clock.heard(c, { peer: true, text: topics[i % 4], now: i * 50_000 });
  let nudges = 0;
  const note = clock.block(c, { now: 4.6 * MIN, onNudge: () => nudges++ });
  assert.match(note, /wrap/i);
  clock.block(c, { now: 4.7 * MIN, onNudge: () => nudges++ });
  assert.equal(nudges, 1);
  assert.match(clock.block(c, { now: 8 * MIN }), /Close it now/);
});

test('a person speaking resets the stretch; a lull starts a fresh one', () => {
  clock._reset();
  const c = 'voice:2';
  clock.heard(c, { peer: true, text: 'hi', now: 0 });
  clock.heard(c, { peer: false, text: 'what do you two think about dinner?', now: 4 * MIN });
  clock.heard(c, { peer: true, text: 'pizza', now: 4.1 * MIN });
  assert.equal(clock.block(c, { now: 5 * MIN }), '');
  clock.heard(c, { peer: true, text: 'later', now: 9 * MIN }); // long quiet before this
  assert.equal(clock.block(c, { now: 10 * MIN }), '');
});

test('circling the same points brings the nudge forward', () => {
  clock._reset();
  const c = 'voice:3';
  const same = 'honestly the tomatoes garden watering schedule matters most';
  for (let i = 0; i < 5; i++) clock.heard(c, { peer: true, text: same, now: i * 40_000 });
  assert.match(clock.block(c, { now: 3.5 * MIN }), /circling/);
});

test('an owner can give them more time', () => {
  clock._reset();
  const c = 'voice:4';
  assert.equal(clock.keepGoingMinutes('go ahead and keep talking for a couple of minutes'), 2);
  assert.equal(clock.keepGoingMinutes('you guys keep going for 10 more minutes'), 10);
  assert.equal(clock.keepGoingMinutes('keep going'), 5);
  assert.equal(clock.keepGoingMinutes('what time is it'), null);
  assert.equal(clock.heard(c, { peer: false, owner: true, text: 'keep talking for ten minutes', now: 0 }), 'extend');
  clock.heard(c, { peer: true, text: 'so anyway', now: 1000 });
  assert.match(clock.block(c, { now: 6 * MIN }), /keep talking/);
  assert.match(clock.block(c, { now: 10.5 * MIN }), /wrap/i);
  // Someone who isn't an owner can't extend it.
  assert.equal(clock.heard('voice:5', { peer: false, owner: false, text: 'keep talking for an hour', now: 0 }), 'person');
});

test('a person telling them to stop ends bot-to-bot replies until a person speaks again', () => {
  clock._reset();
  const c = 'voice:6';
  for (const t of ['okay you guys can stop now', 'stop', "alright everyone, that's enough", 'guys, wrap it up']) assert.ok(clock.isGroupStop(t), t);
  for (const t of ["don't stop guys", 'she told him to stop talking about cars yesterday', 'you guys keep going', 'did you guys have enough to eat?']) assert.ok(!clock.isGroupStop(t), t);
  clock.heard(c, { peer: true, text: 'hi', now: 0 });
  assert.equal(clock.heard(c, { peer: false, text: 'you guys can stop now', now: 1000 }), 'stop');
  assert.ok(!clock.peersMayTalk(c, 1500));
  clock.heard(c, { peer: true, text: 'oh sorry', now: 2000 });
  assert.ok(!clock.peersMayTalk(c, 2500));
  assert.ok(clock.peersMayTalk(c, 20 * MIN)); // a stop wears off after a quarter hour of quiet
  clock.heard(c, { peer: false, text: 'okay what else is new', now: 3000 });
  assert.ok(clock.peersMayTalk(c, 3500));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSleep, stageAt } from './sleep.js';

const MIN = 60_000, HOUR = 60 * MIN;
const noon = new Date(2026, 10, 7, 12).getTime();

function setup(start = noon) {
  const clock = { t: start };
  const moves = [], told = [];
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'champ-sleep-')), 'sleep.json');
  const sleep = createSleep({ file, now: () => clock.t, emit: (s) => told.push(s), body: (g) => moves.push(g) });
  return { sleep, clock, moves, told, file };
}
// Runs the half-minute tick across a stretch of time.
function pass(s, ms) {
  for (const end = s.clock.t + ms; s.clock.t < end;) { s.clock.t += 30_000; s.sleep.tick(); }
}

test('a night has real stages: deep early, REM long toward morning', () => {
  assert.equal(stageAt(1), 'drifting off');
  assert.equal(stageAt(40), 'deep');
  assert.equal(stageAt(85), 'rem');
  assert.equal(stageAt(90 * 4 - 1), 'stirring');
  const rem = (cycle) => Array.from({ length: 90 }, (_, m) => stageAt(cycle * 90 + m)).filter((x) => x === 'rem').length;
  assert.ok(rem(4) > rem(0) * 2);
});

test('she stays up through the day, and turns in late once it is quiet', () => {
  const s = setup(new Date(2026, 10, 7, 7).getTime());
  pass(s, 8 * HOUR);
  assert.equal(s.sleep.sleeping(), false, 'tired or not, it is the afternoon');
  pass(s, 9 * HOUR); // midnight
  assert.equal(s.sleep.asleep(), true);
});

test('she will not turn in on her own while people are in a call with her', () => {
  const s = setup(new Date(2026, 10, 7, 7).getTime());
  s.sleep.setCompany(() => true);
  pass(s, 17 * HOUR);
  assert.equal(s.sleep.sleeping(), false);
  s.sleep.setCompany(() => false);
  pass(s, HOUR);
  assert.equal(s.sleep.asleep(), true);
});

test('choosing to sleep works any time, and she drops off in minutes', () => {
  const s = setup();
  s.sleep.goToSleep();
  assert.equal(s.sleep.status().settling, true);
  assert.equal(s.told.at(-1).settling, true, 'the avatar is told, so her eyes close');
  pass(s, 4 * MIN);
  assert.equal(s.sleep.asleep(), true);
});

test('talking to her while she settles keeps her up, and she knows that is why', () => {
  const s = setup();
  s.sleep.goToSleep();
  assert.equal(s.sleep.wake({ by: 'Owner', owner: true }), null);
  assert.equal(s.sleep.sleeping(), false);
  assert.match(s.sleep.promptSection(), /Owner talked to you before you dropped off.*Your sleep itself works/);
});

test('told to sleep, she is out in under a minute', () => {
  const s = setup();
  s.sleep.goToSleep({ nap: true });
  pass(s, MIN);
  assert.equal(s.sleep.asleep(), true);
});

test('once she has said goodnight she drops off right then; finishing a reply otherwise changes nothing', () => {
  const s = setup();
  s.sleep.doneTalking();
  assert.equal(s.sleep.sleeping(), false, 'not trying to sleep: a finished reply does nothing');
  s.sleep.goToSleep();
  assert.equal(s.sleep.asleep(), false, 'still saying goodnight');
  s.sleep.doneTalking();
  assert.equal(s.sleep.asleep(), true, 'goodnight finished: she is out');
});

test('being woken from deep sleep leaves her groggy, and she knows why', () => {
  const s = setup();
  s.sleep.goToSleep();
  pass(s, 4 * MIN + 40 * MIN);
  assert.equal(s.sleep.stage(), 'deep');
  const note = s.sleep.wake({ by: 'Owner', owner: true });
  assert.match(note, /Owner just woke you up/);
  assert.match(note, /deep sleep/);
  assert.equal(s.sleep.asleep(), false);
  assert.ok(s.sleep.status().groggy > 0.9);
  assert.deepEqual(s.moves, ['wake_up'], 'waking plays the yawn-then-stretch sequence');
  assert.match(s.sleep.promptSection(), /very groggy/);
});

test('a stranger waking her gets her own judgment, not obedience', () => {
  const s = setup();
  s.sleep.goToSleep();
  pass(s, 10 * MIN);
  assert.match(s.sleep.wake({ by: 'friend_11' }), /isn't your owner/);
});

test('she wakes on her own after a full night, and a short one leaves debt', () => {
  const full = setup(new Date(2026, 10, 7, 23).getTime());
  full.sleep.goToSleep();
  pass(full, 10 * HOUR);
  assert.equal(full.sleep.asleep(), false);
  assert.match(full.sleep.promptSection(), /Your last sleep: about [789]/);

  const short = setup();
  short.sleep.goToSleep();
  pass(short, 2 * HOUR);
  short.sleep.wake({ by: 'Owner', owner: true });
  assert.ok(short.sleep.tiredness() > full.sleep.tiredness());
});

test('a nap ends on its own in under two hours', () => {
  const s = setup();
  s.sleep.goToSleep({ nap: true });
  pass(s, 2 * HOUR);
  assert.equal(s.sleep.asleep(), false);
});

test('her sleep survives a restart, and a long shutdown ends the night', () => {
  const s = setup();
  s.sleep.goToSleep();
  pass(s, 30 * MIN);
  const again = createSleep({ file: s.file, now: () => s.clock.t, emit: () => {}, body: () => {} });
  assert.equal(again.asleep(), true);
  const later = createSleep({ file: s.file, now: () => s.clock.t + 20 * HOUR, emit: () => {}, body: () => {} });
  later.start();
  assert.equal(later.asleep(), false);
});

test('dreams plug in: they start with sleep, stop on waking, and reach her note', () => {
  const s = setup();
  const log = [];
  s.sleep.setDreamer({ start: () => log.push('start'), stop: () => log.push('stop'), wakeNote: () => 'You remember the sea.' });
  s.sleep.goToSleep();
  pass(s, 10 * MIN);
  assert.match(s.sleep.wake({ by: 'Owner', owner: true }), /You remember the sea\./);
  assert.deepEqual(log, ['start', 'stop']);
});

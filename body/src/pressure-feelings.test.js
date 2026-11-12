import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as pressure from './pressure.js';

// Ported from Amy-Voice: feelings settle exponentially toward their targets, a speak-up waits out its
// cooldown, and a DM nobody answers makes her hold back from that person.

test('a feeling holds its level with no clock; only what happens moves it', () => {
  pressure.startPressure();
  const now = Date.now();
  pressure.state.last_message = now; // social hunger has no target while people are talking
  pressure.cfg.flows = []; // the flows move energy on their own; this checks the clock rule alone
  pressure.state.buckets.social_hunger = 0.7;
  pressure.state.feel_tick = now - 60 * 60_000; // an hour since it last settled
  pressure.tick('test');
  assert.ok(Math.abs(pressure.state.buckets.social_hunger - 0.7) < 0.02, `social hunger ${pressure.state.buckets.social_hunger}, expected 0.7`);
});

test('a saved null thrill is repaired and new thrill decays without poisoning the total', () => {
  const file = pressure.snapshot().config.replace(/pressure-config\.json$/, 'pressure-state.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.buckets.thrill = null;
  writeFileSync(file, JSON.stringify(saved));
  pressure.startPressure();
  assert.equal(pressure.state.buckets.thrill, 0);
  pressure.state.buckets.thrill = 1;
  pressure.state.feel_tick = Date.now() - 25 * 60_000;
  pressure.tick('test');
  assert.ok(Math.abs(pressure.state.buckets.thrill - 1) < 0.01);
  assert.ok(Number.isFinite(pressure.snapshot().total));
});

test('after a speak-up that nobody picks up, she can speak up again straight away', () => {
  pressure.startPressure();
  const owner = { id: 'u-owner', name: 'Owner' };
  let spoke = 0;
  pressure.setActor({
    audience: () => ({ ids: new Set([owner.id]) }),
    act: () => { spoke++; },
    room: () => ({ people: [owner], quiet: [], talkingLately: false, sinceAddressedMs: 0 }),
  });
  pressure.setWonderer({ need: () => 0, wonder: async () => null, forRoom: (ids) => (ids.has(owner.id) ? { id: 2, text: 'What did you do today?', scope: 'person', aboutId: owner.id, aboutName: 'Owner' } : null) });
  pressure.state.uptake = null;
  pressure.state.last_speakup = Date.now(); // she just spoke up
  pressure.state.ignored_streak = 0;
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.buckets.energy = 1;
  pressure.state.buckets.asking = 1;
  let fired = null;
  for (let i = 0; i < 10 && !fired; i++) {
    pressure.state.last_tick = Date.now();
    pressure.state.buckets.asking = 1;
    pressure.state.buckets.energy = 1;
    fired = pressure.tick('test');
  }
  assert.ok(fired, 'no cooldown: she speaks up when she wants');
  assert.equal(spoke, 1);
});

test('a DM nobody answers in time is noted: she is irritated, and the person\'s bond drops', () => {
  pressure.startPressure();
  const id = 'u-dm-test';
  pressure.state.loneliness[id] = { name: 'Dana', value: 0, tier: 'friend', bond: 0.5 };
  pressure.state.dm_wait = { id, at: Date.now() - 800 * 60_000 };
  const before = pressure.state.buckets.irritation;
  pressure.tick('test');
  assert.equal(pressure.state.dm_wait, null, 'the wait is over');
  assert.ok(pressure.state.buckets.irritation > before, 'irritation rises');
  assert.ok(pressure.state.loneliness[id].bond < 0.5, 'bond drops a little');
});

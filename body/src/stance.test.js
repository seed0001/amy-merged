import test from 'node:test';
import assert from 'node:assert/strict';
import { stance } from './stance.js';

const now = 1_000_000;

test('calm: a plain read, no motives, empty gut most of the time', () => {
  const s = stance({ buckets: { boredom: 0.1, curiosity: 0.2, irritation: 0 } }, { id: 'o', name: 'Owner', owner: true }, { now });
  assert.equal(s.calm, true);
  assert.match(s.intuition, /settled/);
  assert.match(s.intuition, /read plainly/);
  assert.match(s.intuition, /do not read motives into people/);
  assert.match(s.intuition, /this is your owner/);
  assert.equal(s.reply, '');
});

test('curiosity and wonder up: she listens for gaps and asks back', () => {
  const s = stance({ buckets: { curiosity: 0.7, wonder: 0.45, irritation: 0 } }, { id: 'o', name: 'Owner', owner: true }, { now });
  assert.equal(s.calm, false);
  assert.match(s.feeling, /curious 0\.7/);
  assert.match(s.intuition, /the gaps: anything about their life/); // strong wording past 0.6
  assert.match(s.intuition, /what you still do not know about them/); // milder wording under 0.6
  assert.match(s.reply, /ask one real question back/);
  assert.match(s.intuition, /do not read motives/); // not irritated: suspicion stays off
});

test('irritation or a fresh boundary turns the guard around: check yourself, not the other person', () => {
  const edgy = stance({ buckets: { irritation: 0.5 } }, { id: 'x', name: 'Zed', affinity: 0 }, { now });
  assert.match(edgy.intuition, /disrespect, if it is really there/); // 0.5: the milder wording; the blunt one starts at 0.6
  assert.match(edgy.intuition, /a question is not a test/);
  assert.doesNotMatch(edgy.intuition, /do not read motives/);
  assert.match(edgy.reply, /shorter and flatter/);
  const bounded = stance({ buckets: {}, boundary: { id: 'x', name: 'Zed', at: now - 60_000, kind: 'insult' } }, { id: 'x', name: 'Zed' }, { now });
  assert.match(bounded.intuition, /still speaking to you the way they did/);
  assert.match(bounded.reply, /calm but firm/);
  const old = stance({ buckets: {}, boundary: { id: 'x', at: now - 3_600_000 } }, { id: 'x' }, { now });
  assert.equal(old.calm, true);
});

test('missing someone shows up for them and nobody else', () => {
  const state = { buckets: {}, loneliness: { a: { name: 'friend_3', value: 0.5 } } };
  const forChris = stance(state, { id: 'a', name: 'friend_3' }, { now });
  assert.match(forChris.intuition, /you have missed them/);
  assert.match(forChris.reply, /be warmer to friend_3/);
  const forBella = stance(state, { id: 'b', name: 'Bella' }, { now });
  assert.equal(forBella.calm, true);
});

// Charm (owner, 2026-11-09): starving for attention, she turns up the warmth to invite some; how far depends on who it is.
test('charm up with her owner or a friend: she may flirt, as an invitation, and says so honestly if asked', () => {
  const owner = stance({ buckets: { charm: 0.7 }, reserve: 2 }, { id: 'o', name: 'Owner', owner: true, tier: 'stranger' }, { now });
  assert.equal(owner.calm, false);
  assert.match(owner.feeling, /wanting affection 0\.7/);
  assert.match(owner.reply, /starving for attention/);
  assert.match(owner.reply, /turn on the charm with Owner/);
  assert.match(owner.reply, /a little flirty/);
  assert.match(owner.reply, /never pressure/);
  assert.doesNotMatch(owner.reply, /energy to act is low/); // reserve is fine
  assert.match(owner.intuition, /whether they are warming to you or not/);
  assert.match(owner.intuition, /do not mistake politeness for them flirting back/);
  const friend = stance({ buckets: { charm: 0.65 } }, { id: 'f', name: 'friend_3', tier: 'friend', affinity: 12 }, { now });
  assert.match(friend.reply, /turn on the charm with friend_3/);
  const closeByScore = stance({ buckets: { charm: 0.65 } }, { id: 'c', name: 'Bella', tier: 'guest', affinity: 45 }, { now });
  assert.match(closeByScore.reply, /turn on the charm with Bella/);
});

test('charm mild: only a touch warmer; starving with no energy says why', () => {
  const mild = stance({ buckets: { charm: 0.4 } }, { id: 'o', name: 'Owner', owner: true }, { now });
  assert.match(mild.reply, /short of attention/);
  assert.match(mild.reply, /a touch warmer and more playful with Owner/);
  assert.doesNotMatch(mild.reply, /turn on the charm/);
  const broke = stance({ buckets: { charm: 0.8 }, reserve: 0.1 }, { id: 'o', name: 'Owner', owner: true }, { now });
  assert.match(broke.reply, /energy to act is low/);
});

test('charm with a guest is warmth, with a stranger plain friendliness: no flirting with people she barely knows', () => {
  const guest = stance({ buckets: { charm: 0.8 } }, { id: 'g', name: 'Dana', tier: 'guest', affinity: 5 }, { now });
  assert.match(guest.reply, /warmer and more inviting with Dana/);
  assert.match(guest.reply, /Not flirting/);
  const stranger = stance({ buckets: { charm: 0.8 } }, { id: 's', name: 'Zed', tier: 'stranger', affinity: 0 }, { now });
  assert.match(stranger.reply, /someone you barely know/);
  assert.match(stranger.reply, /leave flirting out of it/);
  assert.doesNotMatch(stranger.reply, /turn on the charm/);
});

test('charm is off with no one to aim it at, after rudeness or a boundary, and when told to back off', () => {
  const nobody = stance({ buckets: { charm: 0.9 } }, {}, { now });
  assert.equal(nobody.calm, true);
  assert.equal(nobody.reply, '');
  const hostile = stance({ buckets: { charm: 0.9 } }, { id: 'h', name: 'Zed', affinity: -40 }, { now });
  assert.doesNotMatch(hostile.reply, /charm|flirt|warmer/);
  const bounded = stance({ buckets: { charm: 0.9 }, boundary: { id: 'o', at: now - 60_000, kind: 'insult' } }, { id: 'o', name: 'Owner', owner: true }, { now });
  assert.doesNotMatch(bounded.reply, /charm|flirt/);
  assert.match(bounded.reply, /calm but firm/);
  const quiet = stance({ buckets: { charm: 0.9 }, quiet: true }, { id: 'o', name: 'Owner', owner: true }, { now });
  assert.equal(quiet.reply, '');
});

test('only the three strongest pressures speak, strongest first', () => {
  const s = stance({ buckets: { boredom: 0.4, curiosity: 0.9, unease: 0.5, share: 0.35, left_out: 0.8 } }, {}, { now });
  assert.deepEqual(s.feeling.split(', ').map((f) => f.split(' ').slice(0, -1).join(' ')), ['curious', 'left out', 'uneasy']);
  assert.doesNotMatch(s.intuition, /share|sameness/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as pressure from './pressure.js';
import { config } from './config.js';

// Charm (owner, 2026-11-09: "you need to know when to turn on flirtiness so that you can get attention. When
// you're starving for attention and you want some affection, you need to be able to dial that in"). The dial
// is a feeling in her pressure state: fed only by her hunger for people, eased by the attention and warmth she
// actually gets, read off the state every turn by her stance. No clock sets it and no line's energy lands in it.

const owner = { id: 'u-owner', name: 'Owner' };
const zero = () => {
  pressure.startPressure();
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.loneliness = {};
  pressure.state.boundary = null;
  pressure.state.clamp = { until: 0 };
  pressure.state.quiet_until = 0;
  pressure.state.reserve = 2;
  pressure.state.last_message = Date.now();
  pressure.state.last_tick = Date.now();
};

test('charm is a feeling of hers: present from the start, labelled, in the desires layer, fading on its own', () => {
  zero();
  assert.equal(pressure.state.buckets.charm, 0);
  assert.ok(pressure.DEFAULTS.feelings.tau.charm > 0, 'charm fades over its tau like the other feelings');
  assert.ok(pressure.LABEL.charm, 'charm has a mood label');
  assert.ok(pressure.LAYER.desires.includes('charm'), 'wanting affection is a desire, fed by needs');
});

test('hunger for people turns into charm through the flows; nothing else makes it', () => {
  zero();
  pressure.state.buckets.social_hunger = 0.8;
  pressure.state.buckets.energy = 0.5;
  pressure.tick('test');
  assert.ok(pressure.state.buckets.charm > 0, `social hunger feeds charm (${pressure.state.buckets.charm})`);
  const total = (s) => Object.values(s.buckets).reduce((n, v) => n + (Number(v) || 0), 0) + (s.reserve ?? 0);
  assert.ok(total(pressure.state) <= 0.8 + 0.5 + 2 + 1e-6, 'the flows only move what she has');
});

test("a line's energy never lands in charm directly: its route is zero", () => {
  zero();
  pressure.state.buckets.social_hunger = 0.2;
  pressure.tick('test'); // computes the routes
  assert.equal(pressure.state.routes.charm, 0);
  const { weights } = pressure.allocation(null);
  assert.equal(weights.charm, undefined, 'no share of incoming energy');
});

test('warmth toward her and being talked to ease the charm; it is the attention she was after', () => {
  zero();
  pressure.state.buckets.charm = 0.8;
  pressure.state.buckets.joy = 0.2;
  pressure.onIntake({ addressed: 1, praise: 1, resonance: 1 }, { speaker: owner, text: 'Hey you, I missed talking to you, you are great company.', owner: true });
  assert.ok(pressure.state.buckets.charm < 0.55, `praise and being addressed bring charm down (${pressure.state.buckets.charm})`);
});

test('told to back off, the charm is capped with her irritation', () => {
  zero();
  pressure.state.buckets.charm = 0.9;
  pressure.state.buckets.irritation = 0.2;
  pressure.onIntake({ addressed: 1, quiet: 1 }, { speaker: owner, text: 'Back off for a bit, I need quiet.', owner: true });
  pressure.tick('test');
  assert.ok(pressure.state.buckets.charm <= pressure.cfg.quiet_clamp_max + 1e-9, `charm held at the clamp (${pressure.state.buckets.charm})`);
  assert.equal(pressure.stanceFor(owner.id, owner.name).reply, '', 'no charm offensive while she was told to back off');
});

test('her mood line and stance carry the dial, aimed at whoever is in front of her', () => {
  zero();
  const owners = config.ownerIds;
  config.ownerIds = [owner.id];
  try {
    pressure.state.loneliness[owner.id] = { name: 'Owner', tier: 'stranger', owner: true, value: 0, bond: 0.6 }; // how she knows him by name
    pressure.state.buckets.charm = 0.75;
    pressure.state.reserve = 0.1;
    assert.match(pressure.moodLine(owner.id), /wanting attention and affection 0\.8/);
    assert.match(pressure.moodLine(owner.id), /turn on the charm with Owner/);
    assert.match(pressure.moodLine(owner.id), /energy to act is low/);
    assert.match(pressure.stanceFor('u-stranger', 'Zed').reply, /leave flirting out of it/);
    assert.equal(pressure.stanceFor(null).reply, '', 'no one to aim it at');
    pressure.state.buckets.charm = 0.1;
    assert.doesNotMatch(pressure.moodLine(owner.id), /wanting attention|charm/);
  } finally {
    config.ownerIds = owners;
  }
});

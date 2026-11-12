import test from 'node:test';
import assert from 'node:assert/strict';
import * as pressure from './pressure.js';

// Her intake read (intake.js) reaches the buckets and feelings through onIntake, by meaning: these are
// the signals a line can carry and what each does to her. Word lists are gone from pressure.js.
// Owner, 2026-11-09: a line's energy is only what resonates with her, so these lines carry the resonance her
// intake gives a line said straight to her (intake.js always reports it).
const owner = { id: 'u-owner', name: 'Owner' };
const reset = () => { pressure.startPressure(); for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0; pressure.state.quiet_until = 0; pressure.state.clamp = { until: 0 }; pressure.state.openQuestions = []; pressure.state.uptake = null; pressure.state.boundary = null; };

test('praise warms her; contempt or yelling stings and sets a boundary', () => {
  reset();
  pressure.onIntake({ addressed: 1, praise: 0.9, resonance: 1 }, { speaker: owner, owner: true, text: 'that was sharp, I love how you handled it' });
  assert.ok(pressure.state.buckets.joy > 0.15, `joy ${pressure.state.buckets.joy}`);
  assert.ok(pressure.state.buckets.thrill > 0);
  assert.equal(pressure.state.boundary, null);
  pressure.onIntake({ addressed: 1, contempt: 0.9, resonance: 1 }, { speaker: owner, owner: true, text: "you're just a dumb program" });
  assert.ok(pressure.state.buckets.irritation > 0.2, `irritation ${pressure.state.buckets.irritation}`);
  assert.equal(pressure.state.boundary.kind, 'contempt');
  assert.equal(pressure.state.boundary.name, 'Owner');
});

test('an irritant raises irritation; a request for quiet from the owner clamps her and sets quiet time', () => {
  reset();
  pressure.onIntake({ addressed: 1, irritant: 0.8, resonance: 1 }, { speaker: owner, text: 'are you even listening to me' });
  assert.ok(pressure.state.buckets.irritation > 0.1);
  const before = Date.now();
  pressure.onIntake({ addressed: 1, quiet: 0.9 }, { speaker: owner, owner: true, text: 'give it a rest for a bit' });
  assert.ok(pressure.state.quiet_until > before, 'quiet time set for the owner');
  assert.ok(pressure.state.clamp.until > before, 'irritation and loneliness clamped');
});

test('an open question becomes something to look into; a joke and new ground cut boredom; a monologue not aimed at her leaves her out', () => {
  reset();
  pressure.state.buckets.boredom = 0.5;
  pressure.onIntake({ open_question: 0.9 }, { speaker: owner, conversation: 'voice:1', text: 'I wonder how the Hubble mirror was ground so precisely' });
  assert.equal(pressure.state.openQuestions.length, 1);
  assert.match(pressure.state.openQuestions[0].text, /Hubble/);
  assert.ok(pressure.state.buckets.curiosity > 0);
  pressure.onIntake({ humor: 0.9, novelty: 0.8 }, { speaker: owner, text: 'anyway, my dog just tried to eat a lemon' });
  assert.ok(pressure.state.buckets.boredom < 0.5);
  assert.ok(pressure.state.buckets.joy > 0);
  const leftOut = pressure.state.buckets.left_out;
  pressure.onIntake({ addressed: 0, monologue: 1 }, { speaker: owner, addressed: false, text: '...and then the third thing about mirrors is...' });
  assert.ok(pressure.state.buckets.left_out > leftOut);
});

test('a line that picks up what she said on her own counts as acknowledged', () => {
  reset();
  pressure.state.uptake = { at: Date.now(), text: 'I was thinking about the deck', want: 'share', words: ['thinking', 'deck'], lines: 0 };
  pressure.onIntake({ acknowledges: 0.9 }, { speaker: owner, text: 'yeah, go on' });
  assert.equal(pressure.state.uptake, null);
  assert.equal(pressure.state.ignored_streak, 0);
});

test('between ticks her state flows: feelings settle on real time and buckets lean on each other every second', () => {
  reset();
  pressure.state.buckets.irritation = 0.8;
  pressure.state.buckets.joy = 0.8;
  pressure.state.buckets.restlessness = 0.1;
  const t0 = Date.now();
  pressure.flow(t0);
  for (let s = 1; s <= 30; s++) pressure.flow(t0 + s * 1000);
  assert.ok(pressure.state.buckets.restlessness > 0.1, `irritation and thrill lean on restlessness: ${pressure.state.buckets.restlessness}`);
  assert.ok(pressure.state.buckets.irritation < 0.8, `joy takes the edge off irritation: ${pressure.state.buckets.irritation}`);
});

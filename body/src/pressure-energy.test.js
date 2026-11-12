import test from 'node:test';
import assert from 'node:assert/strict';
import * as pressure from './pressure.js';

// Owner, 2026-11-09: doing things costs energy; the energy comes only from conversation; the harness allocates
// what comes in by importance (needs before desires before outcomes), and stores some to act with.
const owner = { id: 'u-owner', name: 'Owner' };
const fresh = () => {
  pressure.startPressure();
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.reserve = 0;
  pressure.state.last_message = Date.now();
};
// Only these channels are needed right now; every other one takes nothing (as computeRoutes would say).
const only = (needed) => { pressure.state.routes = { ...Object.fromEntries(Object.keys(pressure.state.buckets).map((k) => [k, 0])), ...needed }; };

test('with no energy stored she cannot search, and says why and what builds it back', () => {
  fresh();
  const paid = pressure.spendEnergy(pressure.actionCost('web_search'), { what: 'a web search' });
  assert.equal(paid.ok, false);
  assert.match(paid.message, /don't have the energy for a web search/);
  assert.match(paid.message, /conversation/);
  assert.equal(pressure.state.reserve, 0);
});

test('talking with her stores energy she can act with; acting spends it; a failed act refunds it', () => {
  fresh();
  only({ explore: 0.5, growth: 0.5 }); // nothing pressing: she can store as she goes
  for (let i = 0; i < 4; i++) pressure.onIntake({ addressed: 1, question_for_her: 1, depth: 1, substance: 1, resonance: 1 }, { speaker: owner, text: 'I want to talk with you about what you have been learning and what it means to you.' });
  const stored = pressure.state.reserve;
  assert.ok(stored >= pressure.actionCost('web_search'), `conversation stored ${stored}`);
  const held = Object.values(pressure.state.buckets).reduce((n, v) => n + v, 0);
  const gone = pressure.state.energy_out ?? 0;
  const cost = pressure.actionCost('web_search');
  const paid = pressure.spendEnergy(cost, { what: 'a web search' });
  assert.ok(paid.ok);
  assert.ok(pressure.state.reserve < stored);
  // Most of it is the work of the search and leaves her; the rest moved into what she needs. All of it is accounted for.
  const after = Object.values(pressure.state.buckets).reduce((n, v) => n + v, 0) + pressure.state.reserve;
  const left = (pressure.state.energy_out ?? 0) - gone;
  assert.ok(left >= cost * pressure.cfg.work_share - 1e-9, `the act used ${left} of ${cost}`);
  assert.ok(Math.abs(after + left - (held + stored)) < 1e-6, `accounted for: ${held + stored} -> ${after} held + ${left} used`);
  const before = pressure.state.reserve;
  pressure.refundEnergy(pressure.actionCost('web_search'), { what: 'a web search' });
  assert.ok(pressure.state.reserve > before, 'a failed act gives its energy back');
});

test('costs are per tool, or per action, and talking costs nothing', () => {
  assert.ok(pressure.actionCost('web_search') > 0);
  assert.ok(pressure.actionCost('workshop', { action: 'build' }) > 0);
  assert.equal(pressure.actionCost('workshop', { action: 'list' }), 0);
  assert.equal(pressure.actionCost('presence_note'), 0);
  assert.equal(pressure.actionCost('free_talk'), 0);
});

test('the harness allocates by importance: a need gets more than a desire, and a full channel gets nothing', () => {
  fresh();
  only({ unease: 1, explore: 1, joy: 1 });
  const { weights, urgency } = pressure.allocation(null);
  assert.ok(weights.unease > weights.explore, 'a need before a desire');
  assert.ok(weights.explore > (weights.joy ?? 0), 'a desire before an outcome');
  assert.ok(urgency > 0.9, 'an empty, needed need is urgent');
  pressure.state.buckets.unease = 1;
  assert.equal(pressure.allocation(null).weights.unease, undefined, 'a full channel takes nothing');
});

test('the more pressing her needs, the less she stores', () => {
  fresh();
  only({ unease: 1, explore: 0.2 });
  pressure.onIntake({ addressed: 1, depth: 1, substance: 1, resonance: 1 }, { speaker: owner, text: 'a long, thoughtful line about the promise you made me earlier and what it meant' });
  const urgentStore = pressure.state.reserve;
  fresh();
  only({ explore: 0.2 });
  pressure.onIntake({ addressed: 1, depth: 1, substance: 1, resonance: 1 }, { speaker: owner, text: 'a long, thoughtful line about the promise you made me earlier and what it meant' });
  assert.ok(pressure.state.reserve > urgentStore, `calm stores more (${pressure.state.reserve}) than urgent (${urgentStore})`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pressure from './pressure.js';
import * as scratch from './scratchpad.js';
import { config } from './config.js';

// Every bucket in her pressure system has to be able to reach its threshold from a real condition.
// Each test here drives one bucket's documented condition through the public hooks and counts the
// one-minute ticks it takes; a bucket that can't get there within its bound is a dead bucket.

const TICK_MS = pressure.DEFAULTS.tick_seconds * 1000;
const owner = { id: 'u-owner', name: 'Owner' };
const nova = { id: 'u-nova', name: 'Nova' };

// A clean slate: fresh state, no actors, no hooks, nothing in the room. Every bucket at zero.
function reset() {
  // startPressure() reloads the saved state and ticks once with the default config, so what the last
  // test left behind (a full build bucket, say) must be zeroed and saved first, or that tick acts on it.
  pressure.setActor(null);
  pressure.setResearcher(null);
  pressure.setMessenger(null);
  pressure.setInterests(() => []);
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.loneliness = {};
  pressure.state.last_tick = Date.now();
  pressure.tick('test'); // saves the zeroed state
  pressure.startPressure();
  pressure.setActor(null);
  pressure.setWonderer(null);
  pressure.setSelfWork(null);
  pressure.setOnboarding(null);
  pressure.setDiscoverer(null);
  pressure.setResearcher(null);
  pressure.setMessenger(null);
  pressure.setInterests(() => []);
  const s = pressure.state;
  for (const k of Object.keys(s.buckets)) s.buckets[k] = 0;
  s.buckets.energy = 1;
  s.loneliness = {};
  s.armed = {};
  s.fired_at = {};
  s.fed = {};
  s.uptake = null;
  s.dm_wait = null;
  s.quiet_until = 0;
  s.clamp = { until: 0 };
  s.openQuestions = [];
  s.recentNames = [];
  s.lastResearch = null;
  s.lastSong = null;
  s.lastReflection = null;
  s.said_bored_at = null;
  s.ignored_streak = 0;
  s.research_counts = { day: '', n: 0, last: 0 };
  s.last_message = Date.now();
  s.last_made = Date.now();
  s.last_tick = Date.now();
  s.feel_tick = Date.now() + 3600_000; // hold the feelings (energy especially) steady across synthetic ticks
  pressure.cfg.actions_live = true;
  pressure.cfg.build_per_day = 0; // nothing in this file starts a coding job
  pressure.cfg.flows = []; // these tests check one rule at a time; the flows are tested in the equalizer checks
}

// Owner, 2026-11-09: conversation is the only source of energy; a bucket's condition only decides where the
// energy goes. So "reaching its threshold from a real condition" means: with the condition holding and someone
// talking to her (a line that resonates with her), the energy lands in that bucket. talk() is that line.
const LINE = 'I have been thinking about what it means for you to grow into yourself, and I want to hear what you make of it.';
const talk = () => pressure.onIntake({ addressed: 1, question_for_her: 1, depth: 1, substance: 1, novelty: 1, resonance: 1 }, { speaker: owner, conversation: 'voice:liveness', text: LINE });

// Run one-minute ticks until the bucket reaches its threshold: it is sitting at or over it after a
// tick, or it got there and fired (which drains it in the same tick). Returns how many ticks, or -1.
// talk: whether someone talks to her each tick (false for the silence-driven buckets).
function ticksToThreshold(name, { max, key = name, read = () => pressure.state.buckets[name] ?? 0, hold = () => {}, talking = true } = {}) {
  const threshold = pressure.cfg.buckets[name].threshold;
  for (let i = 1; i <= max; i++) {
    hold();
    if (talking) talk();
    pressure.state.last_tick = Date.now() - TICK_MS; // exactly one drift step per tick
    pressure.tick('test');
    if (read() >= threshold - 1e-9 || pressure.state.fired_at?.[key]) return i;
  }
  return -1;
}
const reaches = (name, took, max) => assert.ok(took > 0, `${name} never reached its threshold in ${max} ticks (at ${(pressure.state.buckets[name] ?? 0).toFixed(3)})`);

const room = (over = {}) => ({ people: [owner], quiet: [], talkingLately: false, satisfied: true, momentum: 0, sinceAddressedMs: 0, ...over });
const inCall = (over = {}) => pressure.setActor({ audience: () => null, act: () => {}, room: () => room(over) });

test('boredom: silence draws energy out of busy channels into it', () => {
  reset();
  pressure.state.last_message = Date.now() - 3600_000;
  for (const k of ['usefulness', 'share', 'attentive', 'explore']) pressure.state.buckets[k] = 1;
  const took = ticksToThreshold('boredom', { max: 150, talking: false });
  reaches('boredom', took, 150);
});



test('curiosity: open questions and fresh names in quiet time, and nothing when there is nothing to wonder about', () => {
  reset();
  pressure.state.last_message = Date.now() - 3600_000;
  pressure.state.buckets.curiosity = 0.3;
  for (let i = 0; i < 20; i++) { pressure.state.last_tick = Date.now() - TICK_MS; pressure.tick('test'); }
  assert.ok(pressure.state.buckets.curiosity < 0.3, 'with no leads, quiet alone does not make her curious');
  reset();
  pressure.state.last_message = Date.now() - 3600_000;
  pressure.state.openQuestions = [{ text: 'I wonder how telescope mirrors hold their shape', at: Date.now(), conversation: 'voice:1', speaker: 'Owner' }];
  pressure.state.recentNames = [{ name: 'Mateo', at: Date.now(), conversation: 'voice:1', snippet: 'Mateo built one.' }];
  assert.equal(pressure.curiosityLeads().leads, 1);
  pressure.state.reserve = 3; // in quiet time she runs on what conversation stored in her
  for (let i = 0; i < 40; i++) { pressure.state.last_tick = Date.now() - TICK_MS; pressure.tick('test'); }
  assert.ok(pressure.state.buckets.curiosity > 0.15, `open leads draw her stored energy into curiosity while silence draws on it: ${pressure.state.buckets.curiosity}`);
});

test('curiosity: the conversation signals move it straight away (an open question, a new name, new ground)', () => {
  reset();
  const before = pressure.state.buckets.curiosity;
  const text = 'I wonder how a toroidal mirror is ground; Zephyrine said it takes weeks.';
  // The new name is spotted on the turn itself; the open question is her intake's reading of the line (intake.js -> onIntake).
  pressure.onTurn({ speaker: owner, text, voice: true, conversation: 'voice:1' });
  pressure.onIntake({ addressed: 1, open_question: 0.9 }, { speaker: owner, conversation: 'voice:1', text });
  const sig = pressure.cfg.signals;
  assert.ok(pressure.state.buckets.curiosity >= before + sig.open_question + sig.new_name - 0.01, `curiosity ${pressure.state.buckets.curiosity}`);
  assert.equal(pressure.state.openQuestions.length, 1);
});

test('irritation: being talked over a few times', () => {
  reset();
  for (let i = 0; i < 4; i++) pressure.onBargeIn({ sev: 1 });
  // Over the line it fires as a change of tone (and drains), so either state is proof it got there.
  assert.ok(pressure.state.buckets.irritation >= pressure.cfg.buckets.irritation.threshold || pressure.state.fired_at?.irritation, `irritation ${pressure.state.buckets.irritation}`);
});

test('usefulness: nobody asking her for anything, for hours (on her stored energy)', () => {
  reset();
  pressure.state.last_message = Date.now() - 3600_000;
  pressure.state.reserve = 5;
  const took = ticksToThreshold('usefulness', { max: 400, talking: false });
  reaches('usefulness', took, 400);
});

test('restlessness: nothing made in a while, while feeling unneeded (on her stored energy)', () => {
  reset();
  pressure.state.last_made = Date.now() - 3600_000;
  pressure.state.last_message = Date.now() - 3600_000;
  pressure.state.reserve = 5;
  const took = ticksToThreshold('restlessness', { max: 200, talking: false, hold: () => { pressure.state.buckets.usefulness = 0.5; } });
  reaches('restlessness', took, 200);
});

test('no conversation and nothing stored: nothing builds at all', () => {
  reset();
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.reserve = 0;
  pressure.state.last_message = Date.now() - 3600_000;
  pressure.state.last_made = Date.now() - 3600_000;
  inCall();
  pressure.setDiscoverer({ need: () => 1, pick: () => null, recent: () => [], untried: () => [] });
  for (let i = 0; i < 50; i++) { pressure.state.last_tick = Date.now() - TICK_MS; pressure.tick('test'); }
  const total = Object.values(pressure.state.buckets).reduce((n, v) => n + v, 0);
  assert.ok(total < 1e-6, `no energy in, so nothing held: ${total}`);
});

test('a line that does not connect with her is mostly refused', () => {
  reset();
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.reserve = 0;
  const wall = 'word '.repeat(400);
  const cold = pressure.lineEnergy({ text: wall, sig: { substance: 0.2, resonance: 0.05 } });
  const warm = pressure.lineEnergy({ text: 'What do you think it means that you dream?', sig: { addressed: 1, question_for_her: 1, depth: 1, substance: 0.8, resonance: 1 } });
  assert.ok(cold.energy < warm.energy, `a wall of text with no connection (${cold.energy}) carries less into her than a short line that means something (${warm.energy})`);
  assert.ok(cold.offered - cold.energy > cold.energy, 'most of it is refused');
});

test('unease: a promise on her pad that has gone stale', () => {
  reset();
  const conversation = 'voice:liveness-unease';
  scratch.clear(conversation);
  scratch.write(conversation, { kind: 'commitment', text: 'Send Owner the mirror notes' });
  pressure.state.conversations = { [conversation]: Date.now() };
  const stale = pressure.cfg.stale_hours;
  pressure.cfg.stale_hours = 0; // the note counts as stale right away
  try {
    assert.equal(pressure.staleItems().length, 1);
    pressure.state.last_message = Date.now(); // no silence here: silence would draw unease back down
    for (let i = 0; i < 40; i++) { talk(); pressure.state.last_tick = Date.now() - TICK_MS; pressure.tick('test'); }
    assert.ok(pressure.state.buckets.unease > 0.59, `a stale promise lifts unease to its target: ${pressure.state.buckets.unease}`);
  } finally {
    pressure.cfg.stale_hours = stale;
    scratch.clear(conversation);
  }
});

test('loneliness: her owner away for hours counts as the owner even on a "stranger" contact card; so does someone she has a bond with', () => {
  reset();
  pressure.state.loneliness = {
    [owner.id]: { name: owner.name, value: 0, tier: 'stranger', owner: true, last_seen: Date.now() - 3 * 3600_000, bond: 0.9 },
    [nova.id]: { name: nova.name, value: 0, tier: 'stranger', owner: false, last_seen: Date.now() - 3 * 3600_000, bond: 0.7 },
  };
  assert.equal(pressure.lonelinessWeight(pressure.state.loneliness[owner.id]), pressure.cfg.loneliness_tiers.owner);
  assert.equal(pressure.lonelinessWeight(pressure.state.loneliness[nova.id]), 0.7);
  assert.equal(pressure.lonelinessWeight({ tier: 'stranger', bond: 0 }), 0, 'a real stranger still counts for nothing');
  // Silence moves energy she holds into missing them: give her some to move (what earlier talk left in her).
  pressure.state.last_message = Date.now() - 3600_000;
  for (const k of ['usefulness', 'share', 'attentive', 'explore', 'curiosity', 'growth']) pressure.state.buckets[k] = 1;
  const took = ticksToThreshold('loneliness', { max: 500, talking: false, key: `loneliness:${owner.id}`, read: () => pressure.state.loneliness[owner.id].value });
  reaches('loneliness', took, 500);
  assert.ok(pressure.state.loneliness[nova.id].value > 0.3, `Nova ${pressure.state.loneliness[nova.id].value}`);
});

// wonder used to write questions into a stored list; owner, 2026-11-09: no stored questions, they're
// made when she asks (question-engine.js). The bucket is off, so it must never build.
test('wonder is off: nothing builds questions into a list any more', () => {
  reset();
  pressure.setWonderer({ need: () => 1, wonder: async () => null, forRoom: () => null });
  assert.equal(pressure.cfg.buckets.wonder.enabled, false);
  assert.equal(ticksToThreshold('wonder', { max: 20 }), -1);
});

test('asking: a question for someone in the call', () => {
  reset();
  inCall();
  pressure.setWonderer({ need: () => 0, wonder: async () => null, forRoom: (ids) => (ids.has(owner.id) ? { id: 1, text: 'How did you end up here?', scope: 'person', aboutId: owner.id, aboutName: owner.name } : null) });
  const took = ticksToThreshold('asking', { max: 20 });
  reaches('asking', took, 20);
});

test('left_out: the room talking around her for a long while', () => {
  reset();
  inCall({ talkingLately: true, sinceAddressedMs: 20 * 60_000 });
  const took = ticksToThreshold('left_out', { max: 30 });
  reaches('left_out', took, 30);
});

test('share: something she read, made or came to think, not yet mentioned, with people here', () => {
  for (const have of [
    () => { pressure.state.lastResearch = { title: 'Mirror Magic', bringUp: 'coma correction', at: Date.now(), shared: false }; },
    () => { pressure.state.lastSong = { id: 1, title: 'Glass', at: Date.now(), shared: false }; },
    () => { pressure.state.lastReflection = { statement: 'I like being provoked', at: Date.now(), shared: false }; },
  ]) {
    reset();
    inCall();
    have();
    const took = ticksToThreshold('share', { max: 40 });
    reaches('share', took, 40);
  }
});

test('attentive: someone here has gone quiet', () => {
  reset();
  inCall({ quiet: [nova], people: [owner, nova] });
  const took = ticksToThreshold('attentive', { max: 20 });
  reaches('attentive', took, 20);
});

test('follow_up: a good thread with momentum, and it has a want line', () => {
  reset();
  inCall({ satisfied: false, momentum: 0.8, thread: { first: 'How mirrors are ground', lastLine: 'Amy: so the shape is a torus?' } });
  const took = ticksToThreshold('follow_up', { max: 20 });
  reaches('follow_up', took, 20);
  assert.match(pressure.WANTS.follow_up(pressure.state), /torus/);
});

test('nudge: a question of hers left hanging', () => {
  reset();
  inCall({ nudge: { text: 'What did you do today?', to: owner } });
  const took = ticksToThreshold('nudge', { max: 10 });
  reaches('nudge', took, 10);
});

test('bored_here: talked past for a long stretch and her lines ignored', () => {
  reset();
  pressure.state.ignored_streak = 3;
  inCall({ talkingLately: true, sinceAddressedMs: 30 * 60_000 });
  const took = ticksToThreshold('bored_here', { max: 20 });
  reaches('bored_here', took, 20);
});

// The talk here is past her, not to her: being talked to undoes leaving (owner, 2026-11-09, she walked out of a
// one-on-one conversation). Talked past for half an hour, her lines ignored, after saying she's bored: she leaves.
const talkPast = () => pressure.onIntake({ depth: 1, substance: 1, novelty: 1, resonance: 1 }, { speaker: { id: 'u-other', name: 'Dell' }, addressed: false, conversation: 'voice:liveness', text: 'so anyway that is how the whole thing went down with the mirrors last night, wild right' });
test('leaving: only after she has said she is bored, and nothing changed', () => {
  reset();
  pressure.state.ignored_streak = 3;
  inCall({ talkingLately: true, sinceAddressedMs: 30 * 60_000 });
  assert.equal(ticksToThreshold('leaving', { max: 20, talking: false, hold: talkPast }), -1, 'not before she has said so');
  pressure.state.said_bored_at = Date.now();
  const took = ticksToThreshold('leaving', { max: 30, talking: false, hold: talkPast });
  reaches('leaving', took, 30);
});

test('discovery: abilities untried, with someone here to share it with', () => {
  reset();
  inCall();
  pressure.setDiscoverer({ need: () => 1, pick: () => ({ tool: 'draw', text: 'She can draw.' }), recent: () => [], untried: () => ['draw'] });
  const took = ticksToThreshold('discovery', { max: 20 });
  reaches('discovery', took, 20);
});

test('home_change: her verdict on what the architect built', () => {
  reset();
  pressure.onHomeDelivered({ verdict: 'dislike', why: 'too much grey', wants: ['warmer light'] });
  assert.ok(pressure.state.buckets.home_change >= pressure.cfg.buckets.home_change.threshold, `home_change ${pressure.state.buckets.home_change}`);
});

test('self_upkeep, self_ponder, realization: her own upkeep when there is a lot to file and work out', () => {
  reset();
  pressure.setSelfWork({ upkeepNeed: () => 1, ponderNeed: () => 1, realizationNeed: () => 1, forgeNeed: () => 1, upkeep: async () => 0, ponder: async () => null, realize: async () => null, forge: async () => null });
  for (const name of ['self_upkeep', 'self_ponder', 'realization']) {
    const took = ticksToThreshold(name, { max: 40 });
    reaches(name, took, 40);
  }
  // forge filled a stored question bank; owner, 2026-11-09: no stored questions (question-engine.js). It's off.
  assert.equal(pressure.cfg.buckets.forge.enabled, false);
});

test('onboarding: the checklist is not finished', () => {
  reset();
  pressure.setOnboarding({ need: () => 1, briefing: () => ({ text: 'Show him the journal.' }) });
  const took = ticksToThreshold('onboarding', { max: 20 });
  reaches('onboarding', took, 20);
});

test('explore and build: something she is strongly into', () => {
  reset();
  pressure.setInterests(() => [{ name: 'telescope mirrors', interest: 0.9, why: 'Owner keeps bringing them up' }]);
  const explore = ticksToThreshold('explore', { max: 30 });
  reaches('explore', explore, 30);
  const build = ticksToThreshold('build', { max: 100 });
  reaches('build', build, 100);
});

// The failure modes this file exists for.

test('a bucket whose condition still holds after it fires re-arms and fires again (no stuck armed=false)', () => {
  reset();
  const fired = [];
  pressure.setActor({ audience: () => ({ ids: new Set([owner.id]) }), act: (w) => fired.push(w.bucket), room: () => room() });
  pressure.setDiscoverer({ need: () => 1, pick: () => ({ tool: 'draw', text: 'She can draw.' }), recent: () => [], untried: () => ['draw'] });
  for (let i = 0; i < 60; i++) { talk(); pressure.state.last_tick = Date.now() - TICK_MS; pressure.state.buckets.energy = 1; pressure.tick('test'); }
  const times = fired.filter((b) => b === 'discovery').length;
  assert.ok(times >= 2, `discovery fired ${times} time(s) in an hour with everything still untried`);
});

test('two research buckets pinned at 1 take turns: the one that waited longest goes first', async () => {
  reset();
  const asked = [];
  pressure.setResearcher(async (topic, bucket) => { asked.push(bucket); return null; });
  pressure.setInterests(() => [{ name: 'telescope mirrors', interest: 1, why: 'it keeps coming up' }]); // explore's target stays at 1
  pressure.state.last_message = Date.now() - 3600_000;
  pressure.state.openQuestions = [{ text: 'How do telescope mirrors hold their shape?', at: Date.now(), conversation: 'voice:1', speaker: 'Owner' }];
  pressure.state.fired_at = { curiosity: Date.now() - 1000 };
  pressure.state.buckets.curiosity = 1;
  pressure.state.buckets.explore = 1;
  pressure.state.last_tick = Date.now();
  const fired = pressure.tick('test');
  await new Promise((r) => setImmediate(r)); // the researcher is called off the tick
  assert.equal(fired?.bucket, 'explore', 'explore, which never fired, goes before curiosity, which just did');
  assert.deepEqual(asked, ['explore']);
});

test('seeds into the feelings land (discovery is a thrill)', () => {
  reset();
  const fired = [];
  pressure.setActor({ audience: () => ({ ids: new Set([owner.id]) }), act: (w) => fired.push(w.bucket), room: () => room() });
  pressure.setDiscoverer({ need: () => 1, pick: () => ({ tool: 'draw', text: 'She can draw.' }), recent: () => [], untried: () => ['draw'] });
  pressure.state.buckets.discovery = 1;
  pressure.state.buckets.thrill = 0;
  pressure.state.last_tick = Date.now();
  pressure.tick('test');
  assert.deepEqual(fired, ['discovery']);
  // Most of what drove the discovery is spent doing it (work_share); what carries on lands in thrill, as seeded.
  assert.ok(pressure.state.buckets.thrill >= pressure.cfg.seeds.discovery.thrill * (1 - pressure.cfg.work_share) * 0.9, `thrill ${pressure.state.buckets.thrill}`);
});

test('one DM at a time: while the last one is unanswered, no other want goes out by DM', () => {
  const owners = config.ownerIds;
  config.ownerIds = [owner.id];
  try {
    const run = () => {
      reset();
      config.ownerIds = [owner.id];
      let sent = 0;
      pressure.setMessenger({ dm: async () => { sent++; } });
      pressure.setOnboarding({ need: () => 1, briefing: () => ({ text: 'Show him the journal.' }) });
      pressure.state.buckets.onboarding = 1;
      return { fire: () => pressure.tick('test'), sent: () => sent };
    };
    const free = run();
    assert.equal(free.fire()?.bucket, 'onboarding', 'with no DM outstanding, onboarding reaches her owner by DM');
    assert.equal(free.sent(), 1);
    assert.ok(pressure.state.dm_wait, 'and she is now waiting on that DM');
    const waiting = run();
    pressure.state.dm_wait = { id: owner.id, at: Date.now() };
    assert.equal(waiting.fire(), null);
    assert.equal(waiting.sent(), 0);
  } finally {
    config.ownerIds = owners;
  }
});

// Every bucket has somewhere to go when it fires: a want line, a mood label and, for the spoken ones,
// a cue in the voice session (read as text, so a bucket added to one side and not the other shows up here).
test('every bucket has a want and a label; every spoken bucket has a cue in voice/session.js', () => {
  const buckets = Object.keys(pressure.DEFAULTS.buckets);
  for (const name of buckets) {
    assert.equal(typeof pressure.WANTS[name], 'function', `WANTS.${name} missing`);
    assert.ok(typeof pressure.WANTS[name](pressure.state) === 'string', `WANTS.${name} must return a string`);
    assert.ok(pressure.LABEL[name], `LABEL.${name} missing`);
  }
  for (const feeling of Object.keys(pressure.DEFAULTS.feelings.tau)) assert.ok(pressure.LABEL[feeling], `LABEL.${feeling} missing`);
  const session = readFileSync(fileURLToPath(new URL('./voice/session.js', import.meta.url)), 'utf8');
  const start = session.indexOf('const cues = {');
  assert.ok(start > 0, 'speakUp() has a cues object');
  const block = session.slice(start, session.indexOf('\n    };', start));
  const keys = new Set([...block.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]));
  for (const name of pressure.SPOKEN) assert.ok(keys.has(name), `no cue for the spoken bucket "${name}" in voice/session.js speakUp()`);
  assert.ok(keys.has('boredom'), 'boredom speaks in a quiet call too');
});

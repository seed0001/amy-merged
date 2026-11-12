import test from 'node:test';
import assert from 'node:assert/strict';
import * as pressure from './pressure.js';
import { createIntake } from './intake.js';

// Owner, 2026-11-11: "when he speaks up after a certain amount of quiet time, it feels like a timer. Like a schedule, and
// it should not be that way. He should be able to read the situation of the quietness… not just that it's quiet, what
// happened before, what the future goals are… so that he can really judge when to say something in the quiet field
// instead of just every 2 minutes." That morning his silence want fired at 08:58, 09:00, 09:04, 09:07, 09:15, 09:18 and
// 09:21, whatever was going on, including right after "we're going to the gas station real quick" and "Alright."

const owner = { id: 'u-owner', name: 'Owner' };
const READS = ['left_hanging', 'tension', 'settled', 'occupied', 'purpose'];

function fresh() {
  pressure.startPressure();
  pressure.cfg.flows = [];
  pressure.state.feel_tick = Date.now() + 60_000;
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.buckets.energy = 1;
  pressure.state.reserve = 3;
  pressure.state.last_message = Date.now();
  pressure.state.lastResearch = null; pressure.state.lastPiece = null; pressure.state.lastSong = null; pressure.state.lastReflection = null;
  pressure.state.roomThread = null;
  // He only speaks into a quiet with something new to bring (owner, 2026-11-11: no laps of the same topics), so each
  // quiet here has one: a fresh finding, and nothing raised yet. These tests are about when he speaks, not what.
  pressure.state.raised = [];
  pressure.state.lastResearch = { title: 'How telescope mirrors hold their shape', at: Date.now() };
  pressure.setDirector(null);
}
// A line said in the call, as her intake read it.
const said = (sig, toHer = false) => pressure.onIntake({ addressed: toHer ? 1 : 0, ...sig }, { speaker: owner, conversation: 'voice:room', addressed: toHer, text: 'a line' });

// The call goes quiet: how many 15-second ticks until he speaks up (or null within the limit).
function quietFor(limitTicks = 60) {
  const spoken = [];
  let quietMs = 0;
  pressure.setActor({
    audience: ({ lullMs = 120_000 } = {}) => (quietMs >= lullMs ? { ids: new Set([owner.id]) } : null),
    act: (want) => spoken.push(want),
    room: () => ({ people: [owner], quiet: [], talkingLately: true, quietMs, quietTogether: false, sinceAddressedMs: quietMs, away: new Set() }),
  });
  for (let i = 1; i <= limitTicks; i++) {
    quietMs = i * 15_000;
    pressure.state.last_tick = Date.now();
    pressure.state.buckets.energy = 1;
    const f = pressure.tick('timer');
    if (f?.bucket === 'silence') return { ticks: i, seconds: quietMs / 1000, fired: f, spoken };
  }
  return { ticks: null, seconds: null, fired: null, spoken };
}

test('an ordinary quiet: he speaks up after a natural pause', () => {
  fresh();
  const r = quietFor();
  assert.ok(r.ticks, 'he speaks up');
  assert.ok(r.seconds <= 90, `within a minute and a half (${r.seconds}s)`);
});

test('something left hanging: he picks it up sooner than in an ordinary quiet', () => {
  fresh();
  const plain = quietFor().seconds;
  fresh();
  said({ left_open: 0.9, substance: 0.7, depth: 0.6 });
  const r = quietFor();
  assert.ok(r.seconds < plain, `left hanging ${r.seconds}s < ordinary ${plain}s`);
  assert.ok(r.fired.silence.read.reasons.some((x) => /left hanging/.test(x)), 'and he knows that is why');
});

test('the talk came to rest, or they are busy with something else: he lets the quiet run much longer, and still speaks in the end', () => {
  fresh();
  const plain = quietFor().seconds;
  // "Yeah, we're going to the gas station real quick." then "Alright."
  fresh();
  said({ busy_elsewhere: 0.9 });
  said({ winding_down: 0.9 });
  const busy = quietFor(80);
  assert.ok(busy.ticks, 'never mute: in a long enough quiet he still speaks (Nov 10: half an hour of silence while Owner waited)');
  assert.ok(busy.seconds >= plain * 3, `at rest and busy ${busy.seconds}s, at least three times an ordinary ${plain}s`);
  assert.ok(busy.fired.silence.read.reasons.some((x) => /rest|busy/.test(x)), 'and he keeps it light');
});

test('what he said into the quiet got no pickup: the next quiet he waits longer, not on the same schedule', () => {
  fresh();
  const first = quietFor().seconds;
  // Nobody picked it up (the uptake window closed with nothing).
  for (let i = 0; i < 2; i++) pressure.state.uptake = null;
  const settledBefore = pressure.state.buckets.settled ?? 0;
  pressure.state.buckets.silence = 0; pressure.state.armed.silence = true;
  const impulses = pressure.cfg.feelings.impulses;
  assert.ok(impulses.ignored.settled > 0 && impulses.unanswered.settled > 0, 'going unanswered settles the room');
  // Apply what an unanswered speak-up does, through the same event the uptake check fires.
  pressure.state.buckets.energy = 1;
  for (const [k, v] of Object.entries(impulses.ignored)) if (READS.includes(k) && v > 0) pressure.state.buckets[k] = Math.min(1, (pressure.state.buckets[k] ?? 0) + v);
  assert.ok((pressure.state.buckets.settled ?? 0) > settledBefore);
  // The first topic is spent; the next quiet has something new of its own (else he wouldn't speak at all).
  pressure.state.lastResearch = { title: 'Why bridges hum in the wind', at: Date.now() + 1 };
  const second = quietFor(80).seconds;
  assert.ok(second > first, `after going unanswered ${second}s > first time ${first}s`);
});

test('something heavy was said: the quiet after it means something, and he is told to be gentle with it', () => {
  fresh();
  said({ opening_up: 0.9, substance: 0.8, depth: 0.8 });
  const r = quietFor();
  assert.ok(r.ticks);
  assert.ok((pressure.state.buckets.tension ?? 0) > 0 || r.fired.silence.read.reasons.some((x) => /heavy/.test(x)));
  assert.ok(r.fired.silence.read.reasons.some((x) => /heavy|gentle/.test(x)), r.fired.silence.read.reasons.join(' | '));
});

test('where he is heading with someone here gives him something to bring: he speaks sooner, toward it', () => {
  fresh();
  const plain = quietFor().seconds;
  fresh();
  pressure.setDirector({ read: (id) => (id === owner.id ? { aim: 'I want to find out what has been weighing on him', progress: 0 } : null), need: () => 0, onLine: () => {}, onStage: () => {}, reflect: async () => ({}) });
  const r = quietFor();
  assert.ok(r.seconds <= plain, `with an aim ${r.seconds}s <= without ${plain}s`);
  assert.ok((pressure.state.buckets.purpose ?? 0) > 0, 'his purpose read rose');
  pressure.setDirector(null);
});

test('reading the room never costs him the urge to speak: a tired him in a long quiet still gets there', () => {
  fresh();
  pressure.state.lastResearch = { title: 'How telescope mirrors hold their shape', at: Date.now() };
  let quietMs = 0;
  pressure.setActor({
    audience: ({ lullMs = 120_000 } = {}) => (quietMs >= lullMs ? { ids: new Set([owner.id]) } : null),
    act: () => {},
    room: () => ({ people: [owner], quiet: [], talkingLately: true, quietMs, quietTogether: false, sinceAddressedMs: 0, away: new Set() }),
  });
  let fired = null;
  for (let i = 1; i <= 60 && !fired; i++) {
    quietMs = i * 15_000;
    pressure.state.last_tick = Date.now();
    for (const k of Object.keys(pressure.state.buckets)) if (k !== 'silence' && !READS.includes(k)) pressure.state.buckets[k] = 0;
    pressure.state.buckets.energy = 0;
    const f = pressure.tick('timer');
    if (f?.bucket === 'silence') fired = f;
  }
  assert.ok(fired, 'he spoke up');
});

test('lines the room says to each other in a call are read, so he can read the quiet that follows them', async () => {
  const heard = [];
  const intake = createIntake({ read: async () => ({ busy_elsewhere: 0.9 }), about: async () => '', onSignals: (sig, ctx) => heard.push([sig, ctx]), onOverheard: () => {}, listening: () => false, name: () => 'James' });
  assert.equal(intake.hear({ conversation: 'voice:room', speaker: { id: 'g', name: 'Glitch' }, text: 'we are going to the gas station', addressed: false }), true, 'a call line is read even when it is not to him');
  assert.equal(intake.hear({ conversation: 'text:chan', speaker: { id: 'g', name: 'Glitch' }, text: 'some chat', addressed: false }), false, 'overheard text chat stays as it was');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(heard[0][0].busy_elsewhere, 0.9, 'the new signal comes through');
});

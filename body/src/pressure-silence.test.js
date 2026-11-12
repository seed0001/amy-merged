import test from 'node:test';
import assert from 'node:assert/strict';
import * as pressure from './pressure.js';

// Owner, 2026-11-11: "if there's silence it starts to build up a certain amount of pressure in the system, and it urges
// him to speak up… it's got to lead somewhere… he can narrate what he's working on or thinking about." The quiet in a
// call is its own want: it builds from the silence, out of energy already in him, and fires as him speaking up.

const owner = { id: 'u-owner', name: 'Owner' };

function quietCall({ quietMs, quietTogether = false, people = [owner], energy = 1 }, ticks = 12) {
  pressure.startPressure();
  pressure.cfg.flows = []; // keep the network from moving it around; this is about the silence step and the gate
  pressure.state.feel_tick = Date.now() + 60_000;
  const spoken = [];
  pressure.setActor({
    audience: ({ lullMs = 120_000 } = {}) => (people.length && !quietTogether && quietMs >= lullMs ? { ids: new Set(people.map((p) => p.id)) } : null),
    act: (want) => spoken.push(want),
    room: () => ({ people, quiet: [], talkingLately: quietMs < 300_000, quietMs, quietTogether, sinceAddressedMs: 0, away: new Set() }),
  });
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.reserve = 2; // energy he has stored: silence moves it, never makes it
  pressure.state.lastResearch = { title: 'How telescope mirrors hold their shape', bringUp: 'active supports', at: Date.now() };
  pressure.state.lastPiece = { title: 'Low Light', instrument: 'piano', at: Date.now() };
  pressure.state.roomThread = null;
  pressure.state.raised = []; // nothing brought up yet in this call
  pressure.state.last_message = Date.now(); // the minutes-long silence step stays out of it
  let fired = null;
  const levels = [];
  for (let i = 0; i < ticks && !fired; i++) {
    pressure.state.last_tick = Date.now();
    for (const k of Object.keys(pressure.state.buckets)) if (k !== 'silence') pressure.state.buckets[k] = 0;
    pressure.state.buckets.energy = energy;
    fired = pressure.tick('timer');
    levels.push(pressure.state.buckets.silence ?? 0);
  }
  return { fired, spoken, levels };
}

test('a quiet call builds the silence want and he speaks up with something of his own to take the talk somewhere', () => {
  const before = 2;
  const { fired, spoken, levels } = quietCall({ quietMs: 80_000 });
  assert.ok(fired, `it fired (silence went ${levels.map((v) => v.toFixed(2)).join(' → ')})`);
  assert.equal(fired.bucket, 'silence');
  assert.equal(fired.doing, 'speak');
  assert.equal(spoken.length, 1);
  assert.equal(fired.silence.seconds, 80);
  // One new thing, chosen for him (not a menu to pick the same favourite from every time), and logged as raised.
  assert.equal(fired.silence.material.length, 1);
  assert.match(fired.silence.material[0], /telescope mirrors/, 'what he read lately');
  assert.equal(pressure.raisedLately().at(-1).key, fired.silence.topic.key);
  assert.ok(pressure.state.reserve < before, 'the energy came out of his store: silence moves energy, it never makes it');
});

// Owner, 2026-11-11: "he's talking every few minutes and he's grabbing at straws… he keeps circling the same stuff
// without realizing he's circling it… I can't start with the same thing unless we are deep in it." That afternoon he
// reopened grants, audio gear and "gatekeeper vs brainstormer" six times in 20 minutes.
test('what he raises into a quiet is spent: the next quiet brings the next new thing, never the same one again', () => {
  const first = quietCall({ quietMs: 80_000 }).fired;
  assert.match(first.silence.topic.text, /telescope/);
  // Same call, the next quiet: the telescope is spent; the piece he played is next, and he's told what he already raised.
  let quietMs = 80_000; const spoken = [];
  pressure.setActor({ audience: () => ({ ids: new Set([owner.id]) }), act: (w) => spoken.push(w), room: () => ({ people: [owner], quiet: [], talkingLately: true, quietMs, quietTogether: false, sinceAddressedMs: 0, away: new Set() }) });
  pressure.state.buckets.silence = 0.9; pressure.state.armed.silence = true; pressure.state.uptake = null;
  const second = pressure.tick('timer');
  assert.equal(second?.bucket, 'silence');
  assert.match(second.silence.topic.text, /Low Light/);
  assert.ok(second.silence.already.some((a) => /telescope/.test(a)), 'told what he already brought up');
});

test('nothing new to bring: he doesn\'t speak into the quiet; the pressure goes into working toward his goals instead', () => {
  pressure.startPressure();
  pressure.cfg.flows = [];
  pressure.state.feel_tick = Date.now() + 60_000;
  const spoken = [];
  pressure.setActor({ audience: () => ({ ids: new Set([owner.id]) }), act: (w) => spoken.push(w), room: () => ({ people: [owner], quiet: [], talkingLately: true, quietMs: 90_000, quietTogether: false, sinceAddressedMs: 0, away: new Set() }) });
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.reserve = 2;
  pressure.state.lastResearch = { title: 'How telescope mirrors hold their shape', at: Date.now() };
  pressure.state.lastPiece = null; pressure.state.lastSong = null; pressure.state.lastReflection = null; pressure.state.roomThread = null;
  pressure.state.raised = [{ key: `read:${pressure.state.lastResearch.at}`, text: 'what you read up on lately', at: Date.now(), outcome: 'ignored' }];
  pressure.state.last_message = Date.now();
  for (let i = 0; i < 12; i++) {
    pressure.state.last_tick = Date.now();
    pressure.state.buckets.energy = 1;
    const f = pressure.tick('timer');
    assert.notEqual(f?.bucket, 'silence', 'no lap of a spent topic');
  }
  assert.equal(spoken.length, 0);
  assert.ok((pressure.state.buckets.silence ?? 0) < 0.05, 'the quiet did not build an urge to talk');
  assert.ok(pressure.state.reserve < 2, 'its energy went somewhere: into his goal work (curiosity), not into chatter');
});

test('tired, he still speaks up in a quiet call: tiredness slows the silence want, it never blocks it', () => {
  // Owner, 2026-11-11: nine minutes of quiet after a restart and nothing said. Her energy was 0.04, and tiredness
  // scaled the pinned silence want to 0.42 against its 0.55 line, so it could never fire.
  const rested = quietCall({ quietMs: 90_000, energy: 1 }, 1).levels[0];
  const { fired, spoken, levels } = quietCall({ quietMs: 90_000, energy: 0 }, 30);
  assert.ok(fired, `it fired while tired (silence went ${levels.map((v) => v.toFixed(2)).join(' → ')})`);
  assert.equal(fired.bucket, 'silence');
  assert.equal(spoken.length, 1);
  assert.ok(levels[0] < rested, `it built more slowly tired (${levels[0].toFixed(3)}) than rested (${rested.toFixed(3)})`);
});

test('it climbs faster the longer the quiet: a short pause builds less than a long one', () => {
  // One tick each (a long quiet can fire within a few and drain): how much one tick of each quiet builds.
  const short = quietCall({ quietMs: 30_000 }, 1).levels[0];
  const long = quietCall({ quietMs: 90_000 }, 1).levels[0];
  assert.ok(long > short && short > 0, `30s ${short.toFixed(3)} < 90s ${long.toFixed(3)}`);
});

test('talking, quiet time together, or nobody to talk to: no silence builds and nothing is said', () => {
  for (const [why, room] of [['people are talking', { quietMs: 5_000 }], ['quiet time together', { quietMs: 120_000, quietTogether: true }], ['nobody in the call', { quietMs: 120_000, people: [] }]]) {
    const { fired, spoken, levels } = quietCall(room);
    assert.equal(levels.at(-1), 0, `${why}: no silence pressure`);
    assert.equal(fired?.bucket === 'silence', false, `${why}: it doesn't fire`);
    assert.equal(spoken.length, 0, why);
  }
});

test("a line's energy never goes into the silence want; only the quiet does", () => {
  pressure.startPressure();
  pressure.setActor({ audience: () => null, act: () => {}, room: () => ({ people: [owner], quiet: [], talkingLately: true, quietMs: 0, sinceAddressedMs: 0, away: new Set() }) });
  pressure.state.buckets.silence = 0;
  for (let i = 0; i < 5; i++) pressure.onIntake({ depth: 1, substance: 1, resonance: 1 }, { speaker: owner, addressed: true, conversation: 'voice:room', text: 'so what have you been up to today, anything good?' });
  assert.equal(pressure.state.buckets.silence ?? 0, 0);
});

// Nov 10: James marked Owner "away" when he said "Thank you" and "let me have a look", then sat silent for half an
// hour while Owner, lying in bed on the call, waited for him. Said-so and muted people can still hear: the silence
// want speaks to anyone who can hear the call. Only someone deafened can't.
test('marked away by their words or on mute, they can still hear: the quiet still builds and he speaks; deafened, he doesn\'t', () => {
  // Said-so and muted are no longer away states at all (away.js, bot.js); this still holds if anything marks them.
  for (const [how, speaks] of [['said so', true], ['muted', true], ['deafened', false]]) {
    pressure.startPressure();
    pressure.cfg.flows = [];
    pressure.state.feel_tick = Date.now() + 60_000;
    const spoken = [];
    const deaf = how === 'deafened';
    pressure.setActor({
      audience: ({ lullMs = 120_000, hearing = false } = {}) => (hearing && !deaf && 80_000 >= lullMs ? { ids: new Set([owner.id]) } : null),
      act: (want) => spoken.push(want),
      room: () => ({ people: [owner], quiet: [], talkingLately: true, quietMs: 80_000, sinceAddressedMs: 0, away: new Set([owner.id]), deaf: new Set(deaf ? [owner.id] : []) }),
    });
    for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
    pressure.state.reserve = 2; pressure.state.last_message = Date.now();
    let fired = null;
    for (let i = 0; i < 12 && !fired; i++) {
      pressure.state.last_tick = Date.now();
      for (const k of Object.keys(pressure.state.buckets)) if (k !== 'silence') pressure.state.buckets[k] = 0;
      pressure.state.buckets.energy = 1;
      fired = pressure.tick('timer');
    }
    assert.equal(fired?.bucket === 'silence', speaks, `${how}: ${speaks ? 'speaks up' : 'stays quiet'}`);
    assert.equal(spoken.length, speaks ? 1 : 0, how);
  }
});

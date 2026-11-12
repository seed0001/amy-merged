import test from 'node:test';
import assert from 'node:assert/strict';
import * as pressure from './pressure.js';

// Owner, 2026-11-10: he creates to feel better, and that has to come from the pressure system. Restless and on
// his own, the urge goes to an outlet that can actually run; finishing something relieves the want that drove it,
// from the act itself; a failed try still counts as a turn, so one broken outlet can't starve the other.

const settle = () => new Promise((r) => setTimeout(r, 30));

// Fire the restlessness want once, with everything else quiet; returns what it chose to do.
function fireRestless() {
  for (let i = 0; i < 20; i++) {
    pressure.state.last_tick = Date.now();
    for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = k === 'restlessness' ? 1 : 0;
    pressure.state.buckets.energy = 1;
    pressure.state.reserve = 3; // enough stored energy for any outlet
    const f = pressure.tick('test');
    if (f?.bucket === 'restlessness') return f;
  }
  return null;
}

function setup({ sewFree = true, sew = async () => { throw new Error('The dress form body is missing'); }, write = async () => ({ kind: 'wrote', song: { id: 's1', title: 'Grinding Gears' } }) } = {}) {
  pressure.startPressure();
  pressure.cfg.flows = [];
  pressure.cfg.actions_live = true;
  pressure.state.last_tried = {};
  pressure.state.last_sewn = 0;
  pressure.state.lastSong = null;
  const calls = { sew: 0, song: 0 };
  pressure.setSeamstress({ free: () => sewFree, make: async (...a) => { calls.sew++; return sew(...a); } });
  pressure.setSongwriter(async (...a) => { calls.song++; return write(...a); });
  pressure.setSongGate(() => true);
  return calls;
}

test('with no dress form to sew on, the urge to make goes to writing a song, never to sewing', async () => {
  const calls = setup({ sewFree: false });
  const fired = fireRestless();
  assert.equal(fired?.doing, 'songwrite');
  await settle();
  assert.equal(calls.sew, 0, 'sewing is never tried when it cannot run');
  assert.equal(calls.song, 1);
});

test('finishing a song relieves the want that drove it, into joy and growth, without waiting for anyone', async () => {
  setup({ sewFree: false });
  const fired = fireRestless();
  assert.equal(fired?.doing, 'songwrite');
  const before = { restlessness: pressure.state.buckets.restlessness, joy: pressure.state.buckets.joy ?? 0, growth: pressure.state.buckets.growth ?? 0 };
  await settle();
  assert.ok(pressure.state.buckets.restlessness < before.restlessness, `restlessness relieved: ${before.restlessness} -> ${pressure.state.buckets.restlessness}`);
  assert.ok((pressure.state.buckets.joy ?? 0) + (pressure.state.buckets.growth ?? 0) > before.joy + before.growth, 'it went into joy and growth');
});

test('a failed sew still counts as a turn: the next urge goes to the song', async () => {
  const calls = setup({ sewFree: true });
  pressure.state.lastSong = { id: 'old', title: 'Old', at: Date.now() }; // a song more recently than any sewing
  assert.equal(fireRestless()?.doing, 'sew');
  await settle();
  assert.equal(calls.sew, 1);
  assert.equal(fireRestless()?.doing, 'songwrite', 'the failed sew took its turn; the song gets the next one');
  await settle();
  assert.equal(calls.song, 1);
});

test('playing her instrument takes its turn with the other outlets, and finishing a piece relieves the want', async () => {
  const calls = setup({ sewFree: false });
  let played = 0;
  pressure.setInstrument({ free: () => true, inCall: () => false, play: async () => { played++; return { file: 'x.wav', title: 'Low Light', instrument: 'piano', words: 'A minor, settled' }; } });
  pressure.state.lastPiece = null;
  const first = fireRestless()?.doing;
  await settle();
  const second = fireRestless()?.doing;
  await settle();
  assert.deepEqual([first, second].sort(), ['play', 'songwrite'], 'the song and the instrument take turns');
  assert.equal(played, 1);
  assert.equal(calls.song, 1);
  assert.equal(pressure.state.lastPiece?.title, 'Low Light');
  pressure.setInstrument(null);
});

// Owner, 2026-11-11: "Nobody fucking asked him to play music in the middle of our fucking conversation… I never asked
// him to play the song." At 10:32, restless in a call while Owner and Ultra were talking, his urge picked his guitar and
// it played into the call for two minutes. His own urge never plays into a call, mid-talk or in a lull: it's private.
test('in a call, a piece he makes because he is restless is never played out loud, mid-talk or in a lull', async () => {
  for (const [why, lull, aloud] of [['people talking', false, false], ['the call has gone quiet', true, false]]) {
    setup({ sewFree: false, write: async () => { throw new Error('no songs in this test'); } });
    pressure.setSongGate(() => false);
    pressure.setSongwriter(null);
    const plays = [];
    pressure.setInstrument({ free: () => true, inCall: () => true, play: async (opts) => { plays.push(opts?.outLoud); return { file: 'x.wav', title: 'Harness Bloom', instrument: 'guitar', words: 'G major' }; } });
    // audience() is the lull: someone to play for, and the talk has stopped.
    pressure.setActor({ audience: () => (lull ? { ids: new Set(['u-owner']) } : null), act: () => {}, room: () => ({ people: [{ id: 'u-owner', name: 'Owner' }], quiet: [], talkingLately: true, quietMs: lull ? 130_000 : 2_000, sinceAddressedMs: 0, away: new Set() }) });
    pressure.state.lastPiece = null;
    const fired = fireRestless();
    await settle();
    assert.equal(fired?.doing, 'play', `${why}: he still makes something`);
    assert.equal(plays.length, 1, why);
    assert.equal(plays[0], aloud, `${why}: not played into the call`);
    pressure.setInstrument(null);
    pressure.setActor(null);
  }
});

test('what she plays moves her pressure: bright lifts joy, heavy turns her inward, a hit thrills, a sour note grates', () => {
  pressure.startPressure();
  const b = pressure.state.buckets;
  const at = (k) => b[k] ?? 0;
  for (const k of ['joy', 'reflection', 'thrill', 'irritation']) b[k] = 0.3;
  b.energy = 0.8;
  const j = at('joy'); pressure.onSound({ valence: 0.8, source: 'instrument' }); assert.ok(at('joy') > j, 'bright lifts joy');
  const r = at('reflection'); pressure.onSound({ valence: -0.8, source: 'instrument' }); assert.ok(at('reflection') > r, 'heavy turns him inward');
  const t = at('thrill'); pressure.onSound({ jolt: 0.7, source: 'instrument' }); assert.ok(at('thrill') > t, 'a phrase that hits thrills');
  const i = at('irritation'); pressure.onSound({ jolt: -0.7, source: 'instrument' }); assert.ok(at('irritation') > i, 'a sour one grates');
});

test('a song that never got saved relieves nothing', async () => {
  setup({ sewFree: false, write: async () => null });
  fireRestless();
  const before = { joy: pressure.state.buckets.joy ?? 0, growth: pressure.state.buckets.growth ?? 0 };
  await settle();
  // Only the usual drift between ticks, nowhere near a relief.
  assert.ok((pressure.state.buckets.joy ?? 0) - before.joy < 0.001, 'no joy from a song that was never saved');
  assert.ok((pressure.state.buckets.growth ?? 0) - before.growth < 0.001, 'no growth either');
});

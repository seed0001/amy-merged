import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoundSense } from './sound-sense.js';

const RATE16 = 16000, RATE48 = 48000;
function tone({ seconds, rate, freqs, amp = 0.3, bpm = 0 }) {
  const n = seconds * rate, out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t) / freqs.length;
    if (bpm) { const beat = (t * bpm / 60) % 1; v *= 0.25 + 0.75 * Math.exp(-beat * 8); }
    out[i] = Math.round(v * amp * 32767);
  }
  return Buffer.from(out.buffer);
}
function harness(over = {}) {
  const nudged = [], pushed = [], logged = [];
  const sense = createSoundSense({ nudge: (f) => nudged.push(f), push: (p) => pushed.push(p), log: (k, d) => logged.push({ k, ...d }), ...over });
  return { sense, nudged, pushed, logged };
}

test('a calm voice lands as a voice push with the speaker named, and short noises are ignored', () => {
  const { sense, nudged, pushed, logged } = harness();
  assert.equal(sense.voice(tone({ seconds: 0.4, rate: RATE48, freqs: [200] }), { conversation: 'c', speaker: 'Owner' }), null);
  const e = sense.voice(tone({ seconds: 3, rate: RATE48, freqs: [120, 180, 240], amp: 0.2 }), { conversation: 'c', speaker: 'Owner' });
  assert.ok(e);
  assert.equal(pushed[0].source, 'voice');
  assert.ok(pushed[0].calm > 0.4, `calm ${pushed[0].calm}`);
  assert.ok(nudged.length <= 1);
  assert.match(sense.promptLine('c'), /^Owner's voice just now sounded/);
  assert.equal(logged.filter((l) => l.k === 'sound').length, 1);
});

test('a track lands its first window at once and the rest as playback reaches them', async () => {
  const song = tone({ seconds: 45, rate: RATE16, freqs: [880, 1760, 3000], amp: 0.8, bpm: 150 });
  const timers = [];
  const resource = { playbackDuration: 0 };
  const { sense, pushed } = harness({ decode: async () => song, schedule: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; } });
  await sense.track('song.mp3', { conversation: 'c', resource });
  assert.equal(pushed.length, 1, 'window 0 lands immediately');
  assert.equal(pushed[0].source, 'music');
  assert.ok(pushed[0].energy > 0.5, `energy ${pushed[0].energy}`);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 500 && timers[0].ms <= 15000);
  timers.shift().fn(); // fires before playback reached 15 s: nothing lands, it waits again
  assert.equal(pushed.length, 1);
  resource.playbackDuration = 31_000; // the player has reached window 2
  timers.shift().fn();
  assert.equal(pushed.length, 3, 'windows 1 and 2 land once playback passed them');
  assert.equal(timers.length, 1, 'one more wait: for the song to end, when she looks back on it');
  resource.playbackDuration = 45_000;
  timers.shift().fn();
  assert.equal(timers.length, 0, 'the song is over: nothing left to wait for');
  assert.match(sense.promptLine('c'), /^The music playing is energetic/);
});

test('stop ends a track run; a new track replaces the old one', async () => {
  const song = tone({ seconds: 40, rate: RATE16, freqs: [220], amp: 0.3, bpm: 70 });
  const timers = [];
  let release;
  const { sense, pushed } = harness({ decode: () => new Promise((r) => { release = () => r(song); }), schedule: (fn, ms) => { timers.push({ fn, ms }); return {}; } });
  const first = sense.track('a.mp3', { conversation: 'c', resource: { playbackDuration: 0 } });
  sense.stop('c');
  release();
  await first;
  assert.equal(pushed.length, 0, 'a stopped run lands nothing');
  const second = sense.track('b.mp3', { conversation: 'c', resource: { playbackDuration: 0 } });
  release();
  await second;
  assert.equal(pushed.length, 1);
});

test('a station listens while playing and stops when it is not', async () => {
  const clip = tone({ seconds: 12, rate: RATE16, freqs: [110, 165], amp: 0.2, bpm: 60 });
  let on = true;
  const decoded = [];
  const timers = [];
  const { sense, pushed } = harness({ decode: async (url, opts) => { decoded.push({ url, ...opts }); return clip; }, schedule: (fn, ms) => { timers.push({ fn, ms }); return {}; } });
  await sense.station({ name: 'Drone Zone', url: 'https://example.test/drone' }, { conversation: 'c', playing: () => on });
  assert.deepEqual(decoded[0], { url: 'https://example.test/drone', seconds: 12 });
  assert.equal(pushed.length, 1);
  assert.equal(timers[0].ms, 90_000);
  on = false;
  await timers.shift().fn();
  assert.equal(decoded.length, 1, 'no listen once the station is off');
});

test('the prompt line goes stale after ten minutes, and a decode failure is logged, not thrown', async () => {
  let t = 1_000_000;
  const { sense, logged } = harness({ now: () => t });
  sense.voice(tone({ seconds: 2, rate: RATE48, freqs: [200, 300] }), { conversation: 'c', speaker: 'friend_3' });
  assert.ok(sense.promptLine('c'));
  t += 11 * 60_000;
  assert.equal(sense.promptLine('c'), '');
  const broken = createSoundSense({ decode: async () => { throw new Error('ffmpeg exploded'); }, log: (k, d) => logged.push({ k, ...d }), nudge() {}, push() {} });
  await broken.track('x.mp3', { conversation: 'c', resource: {} });
  assert.ok(logged.some((l) => l.k === 'error' && /ffmpeg exploded/.test(l.message)));
});

// Owner, 2026-11-10: music from any source in the call, and from the library, goes into what she feels and her pressure.
const chordRun = (chords, rate = 48000, each = 1.5) => {
  const parts = chords.map((c) => tone({ seconds: each, rate, freqs: c.map((m) => 440 * 2 ** ((m - 69) / 12)), amp: 0.3 }));
  return Buffer.concat(parts);
};

test('music from someone else in the call lands as music, from them, with its key in it', () => {
  const { sense, pushed, nudged } = harness();
  assert.equal(sense.music(tone({ seconds: 1, rate: RATE48, freqs: [440] }), { conversation: 'c', from: 'Jockie Music' }), null, 'a scrap is too little');
  const major = sense.music(chordRun([[48, 60, 64, 67], [53, 65, 69, 72], [55, 67, 71, 74], [48, 60, 64, 67]]), { conversation: 'c', from: 'Jockie Music' });
  assert.ok(major);
  assert.equal(pushed.at(-1).source, 'music');
  assert.ok(pushed.at(-1).valence > 0.2, `C major lifts: valence ${pushed.at(-1).valence}`);
  assert.match(sense.promptLine('c'), /^The music playing \(from Jockie Music\) is .*C major/);
  const minor = sense.music(chordRun([[45, 57, 60, 64], [50, 62, 65, 69], [52, 64, 68, 71], [45, 57, 60, 64]]), { conversation: 'c', from: 'Jockie Music' });
  assert.ok(minor);
  assert.ok(pushed.at(-1).valence < -0.2, `A minor weighs: valence ${pushed.at(-1).valence}`);
  assert.ok(nudged.length >= 1);
});

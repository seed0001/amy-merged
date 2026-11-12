import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, effect, describe } from './audio-sense.js';

const RATE = 48000;
// Synthetic sound: a set of tones, an optional pulse at a bpm, at an amplitude.
function tone({ seconds = 6, freqs = [220], amp = 0.3, bpm = 0, noise = 0 }) {
  const n = seconds * RATE, out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t) / freqs.length;
    if (bpm) { const beat = (t * bpm / 60) % 1; v *= 0.25 + 0.75 * Math.exp(-beat * 8); }
    if (noise) v += (Math.random() * 2 - 1) * noise;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * amp * 32767)));
  }
  return out;
}

test('a slow, soft, warm sound is calming', () => {
  const p = analyze(tone({ freqs: [110, 165, 220], amp: 0.2, bpm: 62 }), RATE);
  const e = effect(p);
  assert.ok(p.bands.bass + p.bands.lowMid > 0.6, 'low end dominates');
  assert.ok(e.pressure.calm > 0.5, `calm ${e.pressure.calm}`);
  assert.ok((e.feelings.calm ?? 0) > 0.15);
  assert.ok(!e.feelings.annoyed);
  assert.match(describe(p, e), /calming|melancholy/);
});

test('a fast, loud, bright sound is energetic', () => {
  const p = analyze(tone({ freqs: [880, 1760, 3000], amp: 0.8, bpm: 150 }), RATE);
  const e = effect(p);
  assert.ok(p.bpm >= 130 && p.bpm <= 170, `tempo read ${p.bpm}`);
  assert.ok(e.pressure.energy > 0.6, `energy ${e.pressure.energy}`);
  assert.ok((e.feelings.excited ?? 0) > 0.2);
  assert.equal(e.word, 'energetic');
});

test('loud harsh noise in the presence band grates', () => {
  const p = analyze(tone({ freqs: [3000, 4500, 5500], amp: 0.95, noise: 0.3 }), RATE);
  const e = effect(p);
  assert.ok(e.pressure.edge > 0.5, `edge ${e.pressure.edge}`);
  assert.ok((e.feelings.annoyed ?? 0) > 0.15);
});

test('a voice moves her less than music, and too little sound is nothing', () => {
  const pcm = tone({ freqs: [180, 400, 1200], amp: 0.3, seconds: 3 });
  const music = effect(analyze(pcm, RATE)), voice = effect(analyze(pcm, RATE), { voice: true });
  const sum = (f) => Object.values(f.feelings).reduce((a, b) => a + b, 0);
  assert.ok(sum(voice) <= sum(music));
  assert.equal(analyze(new Int16Array(1000), RATE), null);
  assert.equal(effect(null), null);
});

test('the key of music: major reads bright, minor heavy, and noise has no key at all', () => {
  const R = 48000;
  const run = (chords) => {
    const out = [];
    for (const c of chords) for (let i = 0; i < R * 1.5; i++) {
      let v = 0;
      for (const m of c) v += Math.sin(2 * Math.PI * 440 * 2 ** ((m - 69) / 12) * i / R);
      out.push(Math.round(v / c.length * 9000));
    }
    return Int16Array.from(out);
  };
  const major = analyze(run([[48, 60, 64, 67], [53, 65, 69, 72], [55, 67, 71, 74], [48, 60, 64, 67]]), R);
  assert.equal(`${major.key} ${major.mode}`, 'C major');
  assert.ok(effect(major).pressure.valence > 0.2);
  const minor = analyze(run([[45, 57, 60, 64], [50, 62, 65, 69], [52, 64, 68, 71], [45, 57, 60, 64]]), R);
  assert.equal(`${minor.key} ${minor.mode}`, 'A minor');
  assert.ok(effect(minor).pressure.valence < -0.2);
  const noise = analyze(Int16Array.from({ length: R * 4 }, () => Math.round((Math.random() * 2 - 1) * 6000)), R);
  assert.ok(noise.clarity < 0.15, `noise clarity ${noise.clarity}`);
  assert.ok(Math.abs(effect(noise).pressure.valence) < 0.15);
  assert.equal(effect(major, { voice: true }).pressure.valence, 0, 'a voice carries no key');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as orchestra from './orchestra.js';
import { arrange } from './sheet.js';
import { midiOf, partsOf, rangesFor, bandOf, renderTo } from './instrument.js';

// Owner, 2026-11-11: "I want the most high definition, most realistic music implementation he can do. And don't just
// limit him to those. Let him have a whole spectrum of instruments." He had a piano and two guitars, single-velocity
// mono recordings, pitch-shifted. Now: the whole General MIDI orchestra and a 16-layer concert grand through FluidSynth.

test('the whole spectrum: every General MIDI instrument, plain names, drum kits, and the concert grand', () => {
  assert.equal(orchestra.GM.length, 128);
  assert.equal(orchestra.instrument('piano').font, 'piano', 'piano is the Salamander grand');
  assert.equal(orchestra.instrument('guitar').program, 25, 'his old "guitar" is the steel-string acoustic');
  assert.equal(orchestra.instrument('nylon').program, 24);
  assert.equal(orchestra.instrument('cello').program, 42);
  assert.equal(orchestra.instrument('strings').name, 'string ensemble');
  assert.equal(orchestra.instrument('Alto Sax').program, 65);
  assert.equal(orchestra.instrument('upright bass').name, 'acoustic bass');
  const kit = orchestra.instrument('jazz kit');
  assert.ok(kit.drums && kit.bank === 128 && kit.program === 32);
  assert.ok(orchestra.instrument('violin').sustained && !orchestra.instrument('nylon').sustained);
  assert.throws(() => orchestra.instrument('kazoo-o-tron'), /no instrument called "kazoo-o-tron".*cello/);
});

// A tiny SMF reader, enough to check what the renderer will be handed.
function readMidi(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'MThd');
  const tpq = buf.readUInt16BE(12);
  let i = 22, tick = 0, status = 0; const out = [];
  const vlq = () => { let v = 0, b; do { b = buf[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  while (i < buf.length) {
    tick += vlq();
    let b = buf[i++];
    if (b === 0xff) { const type = buf[i++]; const len = vlq(); out.push({ tick, meta: type, data: [...buf.subarray(i, i + len)] }); i += len; continue; }
    if (b & 0x80) status = b; else i--;
    const kind = status & 0xf0, ch = status & 0x0f;
    const a = buf[i++], c = kind === 0xc0 || kind === 0xd0 ? undefined : buf[i++];
    out.push({ tick, kind, ch, a, c });
  }
  return { tpq, out };
}

test('a part becomes a real performance: bank and program, velocities from his dynamics, the pedal, a human touch, and room to ring out', () => {
  const timeline = [{ midi: 60, start: 0, beats: 1, vel: 0.4 }, { midi: 64, start: 1, beats: 1, vel: 0.9 }, { midi: 67, start: 2, beats: 2, vel: 0.7 }];
  const { tpq, out } = readMidi(orchestra.midiFile(timeline, { program: 42, tempo: 120, pedalBeats: 4 }));
  assert.ok(out.some((e) => e.meta === 0x51), 'tempo');
  assert.ok(out.some((e) => e.kind === 0xc0 && e.a === 42), 'program change to the cello');
  const ons = out.filter((e) => e.kind === 0x90 && e.c > 0);
  assert.deepEqual(ons.map((e) => e.a), [60, 64, 67]);
  assert.ok(ons[0].c < ons[1].c, 'soft then loud: the velocities carry his dynamics');
  assert.ok(out.some((e) => e.kind === 0xb0 && e.a === 64 && e.c === 127), 'sustain pedal down');
  const end = out.find((e) => e.meta === 0x2f).tick;
  assert.ok(end >= ons.at(-1).tick + 4 * tpq, 'the track ends a few beats after the last note, so the room rings out');
  const drums = readMidi(orchestra.midiFile([{ midi: 36, start: 0, beats: 1, vel: 0.8 }], { drums: true, program: 32 }));
  assert.ok(drums.out.every((e) => e.kind === undefined || e.ch === 9), 'drums on channel 10');
});

test('a band from his chords: his melody on the lead, the accompaniment on another player, plus bass, drums and a pad', () => {
  const sheet = { key: 'A minor', meter: 4, progression: 'i VI III VII', style: 'rock', melody: 'E5 D5 C5 B4 | C5:4 | E5:2 G5:2 | A5:4', instrument: 'alto sax' };
  const band = bandOf({ instrument: 'alto sax', band: { chords: 'clean electric guitar', bass: 'fingered bass', drums: 'power', pad: '' } });
  assert.deepEqual(band, { chords: 'clean electric guitar', bass: 'fingered bass', drums: 'power' }, 'empty parts left out');
  const a = arrange({ ...sheet, range: rangesFor({ instrument: 'alto sax', band }) }, { midiOf });
  assert.equal(a.voiced.length, 4);
  const parts = partsOf({ instrument: 'alto sax', band }, a);
  assert.deepEqual(parts.map((p) => p.instrument), ['alto sax', 'clean electric guitar', 'fingered bass', 'power kit']);
  assert.ok(parts[0].timeline.every((n) => n.role === 'melody'));
  assert.ok(parts[1].timeline.length && parts[1].timeline.every((n) => n.role === 'chords'));
  const bass = parts[2].timeline;
  assert.equal(bass[0].midi % 12, 9, 'the bass starts on the A of A minor');
  assert.ok(bass.every((n) => n.midi >= 28 && n.midi <= 43), 'in the bass range');
  const drums = parts[3].timeline;
  assert.ok(drums.some((n) => n.midi === 36) && drums.some((n) => n.midi === 38), 'kick and snare: a backbeat for rock');
  assert.equal(bandOf({ instrument: 'grand piano', band: { chords: 'grand piano' } }), null, 'the lead playing its own chords is no band');
});

test('without the orchestra installed it says what is missing, and the old piano and guitars still play', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  assert.equal(orchestra.ready().ok, false);
  assert.match(orchestra.ready().missing.join(' '), /FluidSynth.*MuseScore General.*Salamander/);
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'orch-')), 'x.wav');
  assert.throws(() => renderTo([{ instrument: 'cello', timeline: [{ midi: 48, start: 0, beats: 1, vel: 0.7 }] }], { file: out }), /orchestra isn't installed.*not cello.*Missing: FluidSynth/);
  // The old recordings: only if they're on this machine (the test env has no samples folder of its own).
  if (existsSync(path.join(process.cwd(), 'data', 'instruments', 'piano'))) {
    process.env.INSTRUMENT_SAMPLES = path.join(process.cwd(), 'data', 'instruments');
    const r = renderTo([{ instrument: 'piano', timeline: [{ midi: 60, start: 0, beats: 1, vel: 0.7 }] }], { file: out });
    assert.equal(r.hd, false);
    assert.ok(existsSync(out));
  }
});

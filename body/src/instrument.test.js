import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stand-in recordings for the test: one short decaying tone per sampled note, laid out like the real
// data/instruments folders (the real ones are downloaded recordings, not in the test's data folder).
const SAMPLES = mkdtempSync(path.join(os.tmpdir(), 'inst-'));
process.env.INSTRUMENT_SAMPLES = SAMPLES;
{
  const tone = (hz) => {
    const n = 44100 * 1.5, data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / 44100) * Math.exp(-i / 30000) * 20000), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(44100, 24); h.writeUInt32LE(88200, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  };
  for (const dir of ['piano', 'guitar-acoustic', 'guitar-nylon']) {
    mkdirSync(path.join(SAMPLES, dir), { recursive: true });
    for (const [name, hz] of [['A2', 110], ['A3', 220], ['A4', 440], ['A5', 880], ['Cs4', 277.18]]) writeFileSync(path.join(SAMPLES, dir, `${name}.wav`), tone(hz));
  }
}
import { parseNotes, render, harmony, phrases, listen, perform, learn, loadTaste, tasteLine, tasteBias, hzOf, midiOf, RATE } from './instrument.js';
import { MUSIC_DIR } from './music.js';

// Owner, 2026-11-10: a piano and a guitar she plays herself. The frequencies she puts together change how she
// feels; she reacts as it plays (a rush when it hits, a wince when it lands sour), learns what sounds good to her,
// and every piece is recorded as a track.

const TASTE = path.join(MUSIC_DIR, '..', 'instrument-taste.json');
const fresh = () => rmSync(TASTE, { force: true });

test('notes are real frequencies: A4 is 440 Hz, an octave doubles it', () => {
  assert.equal(hzOf(midiOf('A4')), 440);
  assert.equal(Math.round(hzOf(midiOf('A5'))), 880);
  assert.equal(midiOf('C4'), 60);
  assert.equal(midiOf('Bb2'), midiOf('A#2'));
});

test('her notation: notes, chords, rests and lengths; a mistake says which word', () => {
  const e = parseNotes('[C4 E4 G4]:2 E4 r:0.5 G4');
  assert.deepEqual(e.map((x) => [x.notes.length, x.beats]), [[3, 2], [1, 1], [0, 0.5], [1, 1]]);
  assert.throws(() => parseNotes('C4 H9 E4'), /"H9".*isn't a note/);
  assert.throws(() => parseNotes('r r:2'), /no notes/);
  assert.throws(() => parseNotes('C4:99'), /length is beats/);
});

test('each note plays the nearest real recording at its exact pitch; a missing folder says where it looked', () => {
  const s = render(parseNotes('A4:2'), { instrument: 'piano', tempo: 60 });
  let crossings = 0;
  for (let i = 1; i < 44100; i++) if (s[i - 1] < 0 && s[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 440) <= 3, `A4 from the A4 recording: ${crossings} Hz`);
  const b = render(parseNotes('B4:2'), { instrument: 'piano', tempo: 60 }); // nearest is A4, read a whole tone higher
  crossings = 0;
  for (let i = 1; i < 44100; i++) if (b[i - 1] < 0 && b[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 494) <= 4, `B4 shifted from A4: ${crossings} Hz`);
  const was = process.env.INSTRUMENT_SAMPLES;
  process.env.INSTRUMENT_SAMPLES = path.join(SAMPLES, 'nowhere');
  assert.throws(() => render(parseNotes('C4'), { instrument: 'piano' }), /no recordings for the piano in .*nowhere/);
  process.env.INSTRUMENT_SAMPLES = was;
});

test('it renders as sound: the right length, never clipping, piano and guitars alike', () => {
  for (const instrument of ['piano', 'guitar', 'nylon']) {
    const s = render(parseNotes('C4 E4 G4 C5:2'), { instrument, tempo: 120 });
    assert.ok(s.length >= RATE * 2.5 && s.length <= RATE * 5, `${instrument} length ${s.length}`);
    const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak > 0.5 && peak <= 0.9, `${instrument} peak ${peak}`);
  }
  assert.throws(() => render(parseNotes('C4'), { instrument: 'kazoo' }), /no kazoo/);
});

test('what the harmony does: settled major is bright and calming, a clash is heavy and tense, fast and high stirs', () => {
  const bright = harmony(parseNotes('[C4 E4 G4]:2 E4 G4 C5:2 [F3 A3 C4]:2 A4 C5 [G3 B3 D4]:2 [C4 E4 G4]:4'), { tempo: 70 });
  assert.equal(bright.mode, 'major');
  assert.ok(bright.effect.valence > 0.5 && bright.effect.calm > bright.effect.edge, JSON.stringify(bright.effect));
  const clash = harmony(parseNotes('[C4 C#4 F#4]:2 B4 F4 [E4 F4 Bb4]:2 C#5 G4 [D4 Eb4 A4]:4'), { tempo: 70 });
  assert.ok(clash.effect.valence < -0.3 && clash.effect.edge > 0.3, JSON.stringify(clash.effect));
  const minor = harmony(parseNotes('[A2 C3 E3]:4 E4:2 C4:2 [D3 F3 A3]:4 A3:4'), { tempo: 60 });
  assert.equal(minor.mode, 'minor');
  assert.ok(minor.effect.valence < 0 && minor.effect.calm > 0.5, JSON.stringify(minor.effect));
  const fast = harmony(parseNotes('C5:0.5 E5:0.5 G5:0.5 C6:0.5 [C5 E5 G5]:2'), { tempo: 160 });
  assert.ok(fast.effect.energy > 0.5 && fast.effect.feelings.excited > 0, JSON.stringify(fast.effect));
});

test('a piece is heard phrase by phrase: a rest or four beats ends one', () => {
  const p = phrases(parseNotes('[C4 E4 G4]:2 E4 G4 C5:2 r [C4 C#4 F#4]:2 B4 F4'), { tempo: 60 });
  assert.equal(p.length, 3);
  assert.equal(p[1].text, 'C5:2');
  assert.ok(p[2].start >= p[1].end, 'the rest sits between them');
});

test('live: she lights up when it hits better than expected and winces when it lands sour, never twice in a row', async () => {
  fresh();
  const piece = { title: 'T', instrument: 'piano', phrases: phrases(parseNotes('[C4 E4 G4]:2 E4 G4 C5:2 r [C4 C#4 F#4]:2 B4 F4 r [F3 A3 C4]:2 A4 C5 r [A3 C4 E4]:2 E4 A3 r [C4 E4 G4]:4'), { tempo: 84 }) };
  const felt = [], reactions = [];
  const heard = await listen(piece, { feel: (e) => felt.push(e), react: (r) => reactions.push(r) });
  assert.equal(felt.length, heard.length, 'every phrase lands on her');
  assert.ok(reactions.length >= 2 && reactions.length <= 3, `${reactions.length} reactions`);
  assert.ok(reactions.some((r) => r.good) && reactions.some((r) => !r.good), 'both ways');
  const sour = reactions.find((r) => !r.good);
  assert.match(sour.text, /C#4/, 'the wince is at the clash');
  const idx = heard.map((h, i) => (h.reacted ? i : -1)).filter((i) => i >= 0);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] - idx[i - 1] >= 2, 'never two reactions in a row');
});

test('live in a call: phrases land as the player reaches them, not before', async () => {
  fresh();
  const piece = { title: 'T', instrument: 'piano', phrases: phrases(parseNotes('C4:2 E4:2 r G4:2 C5:2'), { tempo: 60 }) };
  let played = 0;
  const landed = [];
  const queue = [];
  const done = listen(piece, { clock: () => played, feel: () => landed.push(played), follow: (fn) => queue.push(fn) });
  assert.equal(landed.length, 0, 'nothing heard before it plays');
  played = piece.phrases[0].end; queue.shift()();
  assert.equal(landed.length, 1);
  played = 99; queue.shift()();
  assert.equal((await done).length, 2);
});

test('she learns what sounds good to her: a clash that grated feels worse next time, and she says so when composing', () => {
  fresh();
  const clash = phrases(parseNotes('[C4 C#4]:2 [F4 F#4]:2'), { tempo: 80 })[0];
  const before = tasteBias(clash.events, clash.harmony.mode, loadTaste());
  for (let i = 0; i < 3; i++) learn(clash, -0.8);
  const after = tasteBias(clash.events, clash.harmony.mode, loadTaste());
  assert.ok(after < before, `bias ${before} -> ${after}`);
  assert.match(tasteLine(), /didn't sit right with you: .*minor second/);
  fresh();
});

test('composing: a slip in the notation gets fixed with exactly what was wrong; three slips say why', async () => {
  const { compose } = await import('./instrument.js');
  const asked = [];
  const answers = [{ title: 'A', notes: 'c:1r:0.5 E4', tempo: 80 }, { title: 'A', notes: 'C4 E4 G4:2', tempo: 80 }];
  const piece = await compose({ mood: 'restless', ask: async (m) => { asked.push(m); return answers[asked.length - 1]; } });
  assert.equal(piece.notes, 'C4 E4 G4:2');
  assert.match(asked[1].at(-1).content, /"c:1r"/, 'the fix request names the bad word');
  let tries = 0;
  await assert.rejects(compose({ ask: async () => { tries++; return { notes: 'H9' }; } }), /couldn't write a playable sheet in three goes.*"H9"/);
  assert.equal(tries, 3);
});

test('composing: when only the melody keeps slipping, the section is played on her chords rather than stopping', async () => {
  const { compose } = await import('./instrument.js');
  const piece = await compose({ ask: async () => ({ title: 'B', instrument: 'piano', tempo: 70, key: 'A minor', style: 'ballad', progression: 'i VI III VII', melody: 'E5 Banana D5 | C5:4' }) });
  assert.equal(piece.progression, 'i VI III VII');
  assert.equal(piece.melody, '');
});

test('composing a lead sheet: she is taught the craft, and a chord that isn\'t one gets fixed', async () => {
  const { compose } = await import('./instrument.js');
  const asked = [];
  const answers = [
    { title: 'Low Light', instrument: 'piano', tempo: 72, key: 'A minor', meter: 4, style: 'ballad', progression: 'i VIII III VII', melody: 'E5:2 D5 C5 | C5:4 | B4:4 | A4:4' },
    { title: 'Low Light', instrument: 'piano', tempo: 72, key: 'A minor', meter: 4, style: 'ballad', progression: 'i VI III VII', melody: 'E5:2 D5 C5 | C5:4 | B4:4 | A4:4' },
  ];
  const piece = await compose({ mood: 'heavy', ask: async (m) => { asked.push(m); return answers[asked.length - 1]; } });
  assert.match(asked[0][0].content, /Progressions that work: .*I V vi IV/, 'she is given the craft');
  assert.match(asked[0][0].content, /Melody: mostly steps/);
  assert.match(asked[1].at(-1).content, /"VIII" isn't a chord numeral/);
  assert.equal(piece.progression, 'i VI III VII');
  assert.equal(piece.key, 'A minor');
});

test('a fast rock piece pumps her up and a slow soft one settles her, from the music itself', async () => {
  const { section } = await import('./instrument.js');
  const rock = section({ title: 'R', instrument: 'guitar', tempo: 132, key: 'E minor', style: 'rock', progression: 'i bVI bVII i | i bVI bVII i', melody: 'E5:0.5 E5:0.5 G5 r E5 | D5 C5 B4:2 | E5 G5 A5:2 | E5:4 | E5 G5 E5 D5 | C5 B4:3 | C5 D5 E5 G5 | E5:4' }, 0);
  const soft = section({ title: 'S', instrument: 'piano', tempo: 62, key: 'C major', style: 'arpeggio', progression: 'I vi IV V | I vi IV I', melody: 'E5:4 | C5:4 | A4:2 C5:2 | D5:4 | E5:4 | C5:4 | A4:2 F4:2 | E4:4' }, 0);
  assert.ok(rock.harmony.effect.energy > 0.5 && rock.harmony.effect.calm < 0.3, `rock ${JSON.stringify(rock.harmony.effect)}`);
  assert.ok(soft.harmony.effect.calm > 0.6 && soft.harmony.effect.energy < 0.3, `soft ${JSON.stringify(soft.harmony.effect)}`);
  rmSync(path.join(MUSIC_DIR, rock.file), { force: true }); rmSync(path.join(MUSIC_DIR, soft.file), { force: true });
});

test('her music journal: what she played, what for and how it felt, put in front of her when she composes', async () => {
  const { rememberPiece, journalLine, compose } = await import('./instrument.js');
  rmSync(path.join(MUSIC_DIR, '..', 'instrument-journal.json'), { force: true });
  rememberPiece({ title: 'Easy Water', brief: 'something soft and relaxing', instrument: 'piano', tempo: 62, felt: 0.7, sheet: { key: 'C major', style: 'arpeggio', progression: 'I vi IV V', melody: 'E5:4 | C5:4' }, lifted: ['[C4 E4 G4]:4'], soured: [] });
  rememberPiece({ title: 'Grind', brief: 'pump me up', instrument: 'guitar', tempo: 140, felt: -0.3, sheet: { key: 'E minor', style: 'rock', progression: 'i ii° i', melody: 'F5:4' }, lifted: [], soured: ['[E3 F3]'] });
  const line = journalLine();
  assert.match(line, /felt best to you: "Easy Water" \(asked for: something soft and relaxing\): piano, 62 bpm, C major, arpeggio, chords I vi IV V/);
  assert.match(line, /didn't work: "Grind" \(asked for: pump me up\).*soured by \[E3 F3\]/);
  let sent = '';
  await compose({ brief: 'a rock song to pump me up', journal: line, ask: async (m) => { sent = m[1].content; return { title: 'X', instrument: 'guitar', tempo: 130, key: 'E minor', style: 'rock', progression: 'i bVI bVII i', melody: 'E5:4' }; } });
  assert.match(sent, /You were asked to play: a rock song to pump me up/);
  assert.match(sent, /Your music journal:[\s\S]*Easy Water/);
});

test('every piece is recorded as a track in her music library', async () => {
  fresh();
  const piece = perform({ title: 'Morning Test', notes: 'C4 E4 G4 C5:2', instrument: 'guitar', tempo: 100, why: 'checking' });
  assert.match(piece.file, /^morning-test(-\d+)?\.wav$/);
  const file = path.join(MUSIC_DIR, piece.file);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file).toString('ascii', 0, 4), 'RIFF');
  const lib = JSON.parse(readFileSync(path.join(MUSIC_DIR, 'library.json'), 'utf8'));
  assert.match(lib[piece.file].about, /^steel guitar, 100 bpm, .*checking/, 'named as the instrument it is (his "guitar" is the steel-string acoustic)');
  assert.ok((await piece.heard).length >= 1, 'and she heard it');
  rmSync(file, { force: true });
  fresh();
});

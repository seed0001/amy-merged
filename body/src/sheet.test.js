import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKey, chordOf, arrange, RANGES, cleanMelody } from './sheet.js';
import { midiOf } from './instrument.js';

// Owner, 2026-11-10: she needs to know about beat, tempo, ranges, sheet music, to compose her own and have it sound good.

const pcs = (c) => c.tones.join(' ');

test('keys: major and minor, sharps and flats, written the ways people write them', () => {
  assert.deepEqual(parseKey('C major').scale, [0, 2, 4, 5, 7, 9, 11]);
  assert.equal(parseKey('A minor').mode, 'minor');
  assert.equal(parseKey('Am').name, 'A minor');
  assert.equal(parseKey('F# minor').tonic, 6);
  assert.equal(parseKey('Bb').name, 'Bb major');
  assert.throws(() => parseKey('H lydian'), /isn't a key/);
});

test('Roman numerals become the right chords in the key', () => {
  const C = parseKey('C major'), Am = parseKey('A minor');
  assert.equal(pcs(chordOf('I', C)), '0 4 7');           // C E G
  assert.equal(pcs(chordOf('vi', C)), '9 0 4');          // A C E
  assert.equal(pcs(chordOf('V7', C)), '7 11 2 5');       // G B D F
  assert.equal(pcs(chordOf('vii°', C)), '11 2 5');       // B D F
  assert.equal(pcs(chordOf('i', Am)), '9 0 4');          // A C E
  assert.equal(pcs(chordOf('VI', Am)), '5 9 0');         // F A C
  assert.equal(pcs(chordOf('V', Am)), '4 8 11');         // E G# B: the major V pulls home in minor
  assert.equal(pcs(chordOf('bVII', C)), '10 2 5');       // Bb D F
  assert.throws(() => chordOf('VIII', C), /isn't a chord numeral/);
});

test('a lead sheet becomes the chords voiced under her melody, every bar the right length', () => {
  const a = arrange({ key: 'A minor', meter: 4, style: 'ballad', progression: 'i VI III VII', melody: 'E5:2 D5 C5 | C5:2 B4:3 | G4 A4 | D5:4', instrument: 'piano' }, { midiOf });
  assert.equal(a.bars, 4);
  const melody = a.timeline.filter((n) => n.vel === 0.85);
  // Bar 2 written as 5 beats is fitted to 4; bar 3 written as 2 is stretched to 4.
  const bar = (b) => melody.filter((n) => n.start >= b * 4 && n.start < (b + 1) * 4).reduce((s, n) => s + n.beats, 0);
  for (let b = 0; b < 4; b++) assert.ok(Math.abs(bar(b) - 4) < 1e-9, `bar ${b + 1}: ${bar(b)} beats`);
  // The first chord (A minor) sounds under the first beat, in the piano's chord range, with the bass below it.
  const first = a.timeline.filter((n) => n.start < 1 && n.vel !== 0.85).map((n) => n.midi);
  assert.ok(first.some((m) => m % 12 === 9), 'A in the bass or the chord');
  assert.ok(a.timeline.filter((n) => n.vel !== 0.85).every((n) => n.midi >= RANGES.piano.bass[0] && n.midi <= RANGES.piano.chord[1] + 12));
  assert.ok(melody.every((n) => n.midi >= RANGES.piano.melody[0] && n.midi <= RANGES.piano.melody[1]), 'the melody sings in range');
});

test('a melody note outside the key moves to the nearest note of the scale, unless the chord holds it', () => {
  const a = arrange({ key: 'C major', progression: 'I V', melody: 'F#5:4 | B4:2 G#4:2', instrument: 'piano' }, { midiOf });
  const melody = a.timeline.filter((n) => n.vel === 0.85).map((n) => n.midi % 12);
  assert.equal(melody[0], 7, 'F# over C is out of key: it goes to G');
  assert.ok(!melody.includes(8), 'G# over G is out of key and not in the chord: it moves');
});

test('rock drives power chords in eighths; the blues shuffle swings', () => {
  const rock = arrange({ key: 'E minor', style: 'rock', progression: 'i bVI', melody: 'E5:4 | G5:4', instrument: 'guitar' }, { midiOf });
  const chordHits = new Set(rock.timeline.filter((n) => n.vel !== 0.85 && n.start < 4).map((n) => Math.round(n.start * 2) / 2));
  assert.equal(chordHits.size, 8, 'a hit on every eighth of the bar');
  const firstHit = rock.timeline.filter((n) => n.start < 0.1 && n.vel !== 0.85).map((n) => n.midi % 12);
  assert.ok(firstHit.includes(4) && firstHit.includes(11), 'E and B: a power chord, root and fifth');
  const blues = arrange({ key: 'C major', style: 'shuffle', progression: 'I7', melody: 'G5:4', instrument: 'piano' }, { midiOf });
  assert.ok(blues.timeline.some((n) => Math.abs((n.start % 1) - 2 / 3) < 1e-9), 'the off-beat comes late: swung');
});

test('guitar and piano each get their own range; a sheet with no chords says what to write', () => {
  const g = arrange({ key: 'G major', style: 'fingerpick', progression: 'I V vi IV', melody: 'B4 D5 G5 D5', instrument: 'guitar' }, { midiOf });
  assert.ok(g.timeline.every((n) => n.midi >= RANGES.guitar.bass[0] && n.midi <= RANGES.guitar.melody[1]));
  assert.throws(() => arrange({ key: 'C major', progression: '', melody: 'C5' }, { midiOf }), /no chord progression/);
  assert.throws(() => arrange({ key: 'C major', progression: 'I IV', style: 'polka' }, { midiOf }), /isn't a style/);
});

test('a melody jotted with labels and asides reads as the notes in it', () => {
  // What the local model actually wrote, in the shapes that stopped her pieces.
  assert.equal(cleanMelody('[Phrase 1] E5:2 D5 C5 | *(Variation of bar 1)* E5 : 2 D5. C5'), 'E5:2 D5 C5 | E5:2 D5 C5');
  assert.equal(cleanMelody('A4 : C5 (then rising | E♭5:2 F♯4'), 'A4 C5 | Eb5:2 F#4');
  const a = arrange({ key: 'A minor', progression: 'i VI', melody: '[Phrase 1] E5:2 D5 C5 | *(Variation)* A4:4' }, { midiOf });
  assert.equal(a.bars, 2);
  // A note with no octave is the one nearest the note before it.
  const b = arrange({ key: 'C major', progression: 'I', melody: 'E5 D C B4' }, { midiOf });
  assert.deepEqual(b.timeline.filter((n) => n.vel === 0.85).map((n) => n.midi), [76, 74, 72, 71]);
});

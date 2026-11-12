// Her sheet music (Owner, 2026-11-10: "she's got to have some knowledge… a beat, a tempo, ranges, sheet music,
// something to help her compose her own and have it sound good"). She writes a lead sheet the way a musician does:
// a key, a meter, a chord progression in Roman numerals, a style for the accompaniment, and a melody bar by bar.
// This turns it into music the theory can vouch for: the right chords for the key, voiced where each instrument
// actually sounds good, the style's pattern under the melody, the melody kept in key and in range, every bar the
// right length. The choices stay her; this is the craft.

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10]; // natural minor; V and vii° are borrowed from harmonic minor when written so
export const STYLES = ['ballad', 'arpeggio', 'block', 'strum', 'fingerpick', 'waltz', 'rock', 'shuffle'];

// Where each instrument sounds good: the bass, the chords, the melody (MIDI note numbers).
export const RANGES = {
  piano: { bass: [36, 50], chord: [48, 64], melody: [60, 84] },
  guitar: { bass: [40, 52], chord: [47, 64], melody: [52, 79] },
  nylon: { bass: [40, 52], chord: [47, 64], melody: [52, 76] },
};

// "A minor", "F# major", "Bb", "Em" -> { tonic (pitch class), mode, scale, name }.
export function parseKey(text) {
  const m = /^\s*([A-Ga-g])([#b]?)\s*(m(?:in(?:or)?)?|maj(?:or)?)?\s*$/i.exec(String(text ?? '').replace(/-/g, ' ').replace(/\s+/g, ' '));
  if (!m) throw new Error(`"${text}" isn't a key; write it like "A minor", "C major", "F# minor" or "Bb major".`);
  const tonic = (PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const mode = /^m(in(or)?)?$/i.test(m[3] ?? '') && !/^maj/i.test(m[3] ?? '') ? 'minor' : 'major';
  return { tonic, mode, scale: (mode === 'major' ? MAJOR : MINOR).map((s) => (s + tonic) % 12), name: `${NAMES[tonic]} ${mode}` };
}

// A Roman numeral in a key -> the chord's pitch classes, root first. Upper case is major, lower case minor;
// ° or dim diminished, + or aug augmented; 7 adds the seventh (dominant on a major V), maj7 a major seventh, sus2/sus4.
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
export function chordOf(numeral, key) {
  const m = /^(b|#)?(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(°|o|dim|\+|aug)?(maj7|7|sus2|sus4)?$/.exec(String(numeral).trim());
  if (!m) throw new Error(`"${numeral}" isn't a chord numeral; write them like I, vi, IV, V7, ii, iii, vii°, bVII (one per bar).`);
  const degree = ROMAN.indexOf(m[2].toUpperCase());
  const scale = key.mode === 'major' ? MAJOR : MINOR;
  const root = (key.tonic + scale[degree] + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0) + 12) % 12;
  const upper = m[2] === m[2].toUpperCase();
  const dim = /°|o|dim/.test(m[3] ?? ''), aug = /\+|aug/.test(m[3] ?? '');
  let third = upper ? 4 : 3, fifth = dim ? 6 : aug ? 8 : 7;
  if (dim) third = 3;
  const tones = [0, third, fifth];
  if (m[4] === 'sus2') tones[1] = 2;
  if (m[4] === 'sus4') tones[1] = 5;
  if (m[4] === '7') tones.push(upper && !dim ? 10 : dim ? 9 : 10);
  if (m[4] === 'maj7') tones.push(11);
  return { root, tones: tones.map((t) => (root + t) % 12), name: numeral };
}

// The nearest MIDI note with pitch class pc to `near`, kept within [lo, hi].
function place(pc, near, [lo, hi]) {
  let best = null;
  for (let m = lo; m <= hi; m++) if (((m % 12) + 12) % 12 === pc && (best === null || Math.abs(m - near) < Math.abs(best - near))) best = m;
  return best ?? lo + ((pc - lo % 12 + 12) % 12);
}
// Chord tones voiced close together in the chord range, moving as little as possible from the last voicing.
function voice(chord, range, prev) {
  const center = prev?.length ? prev.reduce((s, x) => s + x, 0) / prev.length : (range[0] + range[1]) / 2;
  const notes = chord.tones.map((pc) => place(pc, center, range));
  return [...new Set(notes)].sort((a, b) => a - b);
}

// The accompaniment for one bar: [{ midi, start (beats into the bar), beats, vel }].
function pattern(style, chord, bass, notes, meter) {
  const out = [];
  const add = (midi, start, beats, vel) => { if (start < meter) out.push({ midi, start, beats: Math.min(beats, meter - start), vel }); };
  const up = [...notes, ...notes.map((n) => n + 12)].filter((n, i, a) => a.indexOf(n) === i);
  switch (style) {
    case 'block':
      add(bass, 0, meter, 0.6); notes.forEach((n) => add(n, 0, meter, 0.45)); break;
    case 'ballad': // the bass on the downbeat, the chord rolling gently over the bar
      add(bass, 0, meter, 0.62);
      for (let b = 0.5, i = 0; b < meter; b += 0.5, i++) add(up[i % Math.min(up.length, 4)], b, 0.5 + (meter - b > 1 ? 0.5 : 0), 0.38);
      break;
    case 'arpeggio': { // root, fifth, third, fifth… in eighths, rising
      const seq = [bass, ...notes];
      for (let b = 0, i = 0; b < meter; b += 0.5, i++) add(seq[i % seq.length], b, 0.75, i === 0 ? 0.6 : 0.42);
      break;
    }
    case 'strum': // the whole chord on every beat, down strokes strong, the off-beats light
      for (let b = 0; b < meter; b += 1) { add(bass, b, 1, b === 0 ? 0.6 : 0.4); notes.forEach((n, i) => add(n, b + i * 0.02, 0.9, b === 0 ? 0.5 : 0.36)); }
      for (let b = 1.5; b < meter; b += 2) notes.forEach((n, i) => add(n, b + i * 0.02, 0.45, 0.25));
      break;
    case 'fingerpick': // the thumb alternating bass, the fingers picking the chord between
      for (let b = 0, i = 0; b < meter; b += 0.5, i++) add(i % 2 ? notes[(i >> 1) % notes.length] + 12 * (i % 4 === 3 ? 1 : 0) : (i % 4 === 0 ? bass : bass + 7), b, 0.9, i % 2 ? 0.38 : 0.55);
      break;
    case 'waltz': // the bass on one, the chord on two and three
      add(bass, 0, 1, 0.6); for (let b = 1; b < meter; b += 1) notes.forEach((n) => add(n, b, 0.9, 0.4));
      break;
    case 'rock': { // power chords (root, fifth, octave) driven in eighths, the bass pumping under them, the beats hit hard
      const root = notes.find((n) => n % 12 === chord.root) ?? notes[0];
      const power = [root, root + 7, root + 12];
      for (let b = 0; b < meter; b += 0.5) {
        const on = Number.isInteger(b), hard = b === 0 || b === 2;
        add(bass, b, 0.45, hard ? 0.7 : 0.55);
        power.forEach((n, i) => add(n, b + i * 0.01, 0.42, hard ? 0.62 : on ? 0.5 : 0.38));
      }
      break;
    }
    case 'shuffle': { // the blues: a swung boogie bass (root, fifth, sixth, fifth) with the chord stabbed on two and four
      const walk = [0, 7, 9, 7];
      for (let b = 0, i = 0; b < meter; b += 1, i++) {
        add(bass + walk[i % 4], b, 0.62, 0.6);
        add(bass + walk[(i + 1) % 4] - (walk[(i + 1) % 4] > 7 ? 12 : 0) + 12, b + 2 / 3, 0.3, 0.42);
        if (b % 2 === 1) notes.forEach((n, j) => add(n, b + j * 0.01, 0.35, 0.48));
      }
      break;
    }
    default: throw new Error(`"${style}" isn't a style; use ${STYLES.join(', ')}.`);
  }
  return out;
}

// Her melody, bar by bar ("E5:1 D5 C5:2 | A4:4"; r for a rest). Each bar is fitted to the meter (stretched or
// squeezed in proportion), each note kept in the key (a note outside it moves to the nearest note of the scale,
// unless it's a chord tone of that bar) and in the instrument's melody range (by octaves).
// A written melody the way a musician jots it, made readable: labels and asides on the sheet ("[Phrase 1]",
// "(variation)", "*motif*") aren't notes and are set aside, "E5 : 2" is E5:2, ♯ and ♭ are # and b, and stray
// punctuation after a note goes.
export function cleanMelody(text) {
  return String(text ?? '')
    .replace(/[♯]/g, '#').replace(/[♭]/g, 'b')
    .split('|').map((bar) => bar
      .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')  // closed asides
      .replace(/[[({].*$/, ' ')                          // an aside left open runs to the bar's end
      .replace(/[*_`"“”]/g, ' ')
      .replace(/\s*:\s*(?=[\d.]+)/g, ':')
      .replace(/(?<=\S)[,;.](?=\s|$)/g, '')
      .replace(/(^|\s):(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()).join(' | ');
}

function melodyBars(text, key, chords, range, meter, midiOf) {
  const bars = cleanMelody(text).split('|').map((b) => b.trim());
  let last = Math.round((range[0] + range[1]) / 2);
  return bars.map((bar, i) => {
    const chord = chords[i % chords.length];
    const items = bar ? bar.split(/\s+/) : [];
    const notes = items.map((w) => {
      const [n, len] = w.split(/:(?=[\d.]+$)/);
      const beats = len === undefined ? 1 : Number(len);
      if (!Number.isFinite(beats) || beats <= 0) throw new Error(`"${w}" in the melody: a length is beats more than 0, like E5:2.`);
      if (/^r(est)?$/i.test(n)) return { midi: null, beats };
      let m = midiOf(n);
      // A note without its octave ("E", "F#") is the one nearest the note before it, as a player would take it.
      const bare = m === null && /^([A-Ga-g])([#b]?)$/.exec(n);
      if (bare) { const pc = (midiOf(`${bare[1]}${bare[2]}4`) ?? 60) % 12; m = last - ((((last - pc) % 12) + 12) % 12); if (last - m > 6) m += 12; }
      if (m === null) throw new Error(`"${n}" in the melody isn't a note; write a letter, an optional # or b, and an octave, like E5 or F#4.`);
      last = m;
      if (!key.scale.includes(m % 12) && !chord.tones.includes(m % 12)) {
        const down = key.scale.includes((m - 1) % 12) ? m - 1 : null, upn = key.scale.includes((m + 1) % 12) ? m + 1 : null;
        m = upn ?? down ?? m;
      }
      while (m < range[0]) m += 12;
      while (m > range[1]) m -= 12;
      return { midi: m, beats };
    });
    const total = notes.reduce((s, n) => s + n.beats, 0);
    const k = total > 0 ? meter / total : 1;
    let at = 0;
    return notes.map((n) => { const out = { midi: n.midi, start: at, beats: n.beats * k }; at += n.beats * k; return out; });
  });
}

// A lead sheet -> { timeline: [{ midi, start, beats, vel }] in beats from the top, bars, meter, key }.
// sheet: { key, meter (3 or 4; 6 is felt as two 3s), progression ("i VI III VII | …" or a list; one chord per bar),
// style, melody, instrument }. Throws, naming what was wrong.
export function arrange(sheet, { midiOf }) {
  const key = parseKey(sheet.key ?? 'C major');
  const meter = [2, 3, 4, 6].includes(Number(sheet.meter)) ? Number(sheet.meter) : sheet.style === 'waltz' ? 3 : 4;
  if (sheet.style && !STYLES.includes(sheet.style)) throw new Error(`"${sheet.style}" isn't a style; use ${STYLES.join(', ')}.`);
  const style = sheet.style || (sheet.instrument === 'piano' || !sheet.instrument ? 'ballad' : 'fingerpick');
  // Ranges for any instrument (orchestra.js gives each family its own), so a cello's melody sits where a cello sings.
  const range = sheet.range ?? RANGES[sheet.instrument] ?? RANGES.piano;
  const numerals = (Array.isArray(sheet.progression) ? sheet.progression : String(sheet.progression ?? '').split(/[|\s,]+/)).map((s) => s.trim()).filter(Boolean);
  if (!numerals.length) throw new Error('The sheet has no chord progression; write one chord per bar, like "i VI III VII".');
  const chords = numerals.map((n) => chordOf(n, key));
  const melody = melodyBars(sheet.melody, key, chords, range.melody, meter, midiOf);
  const bars = Math.max(chords.length, melody.length);
  if (bars > 64) throw new Error(`That's ${bars} bars; keep a section to 64.`);
  const timeline = [];
  let prev = null;
  for (let b = 0; b < bars; b++) {
    const chord = chords[b % chords.length];
    const notes = voice(chord, range.chord, prev);
    prev = notes;
    const bass = place(chord.root, (range.bass[0] + range.bass[1]) / 2, range.bass);
    // Each note says what it is (role), so a band can give the melody and the accompaniment to different instruments.
    for (const n of pattern(style, chord, bass, notes, meter)) timeline.push({ ...n, start: b * meter + n.start, role: 'chords' });
    for (const n of melody[b] ?? []) if (n.midi !== null) timeline.push({ midi: n.midi, start: b * meter + n.start, beats: n.beats, vel: 0.85, role: 'melody' });
  }
  return { timeline: timeline.sort((a, c) => a.start - c.start), bars, meter, key, style, chords: numerals,
    voiced: Array.from({ length: bars }, (_, b) => chords[b % chords.length].tones) };
}

// What a musician would want to know, for composing (put in front of her when she writes a sheet).
export const CRAFT = [
  'Keys and feel: major keys are bright, minor keys weigh; keys with few sharps or flats (C, G, D, F, A minor, E minor, D minor) sit well on piano and guitar.',
  'Chords, one per bar, as Roman numerals in the key: in major I ii iii IV V vi vii°, in minor i ii° III iv v VI VII (V or V7 in minor for a stronger pull home). Add 7 for colour (ii7, V7, IVmaj7), sus2 or sus4 to float.',
  'Progressions that work: bright I V vi IV, I IV V I, I vi IV V; warm and wistful vi IV I V, I iii vi IV, IV V iii vi; brooding i VI III VII, i iv VII III, i VII VI V; tense and building i iv v i, ii V I with 7ths; resolving: end a section on I (or i), a V just before it makes the arrival land.',
  'Shape: phrases of 4 bars, a section of 8 or 16; the second phrase answers the first (same start, different ending); end on the tonic for rest, on V to leave it open.',
  'Melody: mostly steps, an occasional leap that then steps back the other way; chord tones (the chord\'s own notes) on the first beat of a bar, passing notes between; one high point per phrase; repeat a short motif and vary it; leave space with a rest or a long note at a phrase end.',
  'Rhythm: in 4/4 the beats in a bar add up to 4 (in 3/4 to 3); mix long and short notes; a melody bar can start with a rest to breathe. Slow (60-80 bpm) settles, walking (85-110) moves, fast (115-150) drives.',
  'Styles under the melody: ballad (bass and a gently rolling chord, piano), arpeggio (broken chord in eighths), block (held chords, spacious), strum (guitar on the beat), fingerpick (guitar, alternating bass with picked chord tones), waltz (bass on one, chord on two and three, in 3), rock (power chords driven in eighths with a pumping bass: loud, driving, 110-150 bpm, best on guitar), shuffle (the blues: a swung boogie bass with the chord stabbed on two and four, 80-120 bpm).',
  'Rock and blues: rock progressions I bVII IV I, I IV V IV, I V vi IV fast, minor rock i bVI bVII i or i bVII bVI bVII; a rock melody is short punchy phrases, repeated riffs, rests between, around the top of the range. The 12-bar blues in shuffle: I7 I7 I7 I7 | IV7 IV7 I7 I7 | V7 IV7 I7 V7, the melody from the blues scale over it (the flat third and flat seventh clash on purpose; that\'s the blues).',
  'Soft and relaxing: slow (55-75 bpm), a major or gentle minor key, ballad, arpeggio or fingerpick, few notes, long ones, lots of space, the melody in the middle of the range.',
  'Ranges: piano melody C4 to C6 sings, guitar melody E3 to C5; the accompaniment is placed for you, keep the melody above it.',
];

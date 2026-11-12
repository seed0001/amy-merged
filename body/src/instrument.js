import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { MUSIC_DIR } from './music.js';
import { config, selfHis } from './config.js';
import { arrange, CRAFT, STYLES } from './sheet.js';
import { activity } from './events.js';
import * as orchestra from './orchestra.js';

// Her instrument (Owner, 2026-11-10): a piano and guitars she plays herself. She puts notes together, each note
// is played from a real recording of that instrument (data/instruments), and every piece is recorded
// as a track in her music library, playable later like any song. What she plays reaches how she feels two ways:
//  - the harmony itself, read from the notes: consonant or clashing intervals, major or minor, high or low,
//    slow or fast. These are what move people's mood in music. harmony() returns it; play() lands it.
//  - the sound, when it plays out loud in a call: the track player runs it through her hearing like any song
//    (sound-sense.js), so the measured audio lands as it plays too.
// No model and no network here. The composing (what to play) is her: compose() asks the local model.

export const RATE = 44100;
export const INSTRUMENTS = ['piano', 'guitar', 'nylon']; // guitar: steel-string acoustic; nylon: classical guitar
const MAX_SECONDS = 120, MAX_EVENTS = 400;

// ---- notes ----

const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// "C4", "F#3", "Bb2" -> MIDI number; null if it isn't a note.
export function midiOf(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(name).trim());
  if (!m) return null;
  const n = (m[3] | 0) * 12 + 12 + NAMES[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return n >= 21 && n <= 108 ? n : null; // the piano's range, A0..C8
}
export const hzOf = (midi) => 440 * 2 ** ((midi - 69) / 12);

// Her notation, one event per word: a note "E4", a chord "[C4 E4 G4]", a rest "r", each with an optional
// length in beats after a colon ("G4:2", "[A3 C4 E4]:4", "r:0.5"; default 1 beat). Returns [{ notes, beats }]
// or throws saying which word it couldn't read.
export function parseNotes(text) {
  const words = String(text ?? '').match(/\[[^\]]*\](?::[\d.]+)?|[^\s\[\]]+/g) ?? [];
  const events = [];
  for (const word of words) {
    const [body, len] = word.split(/:(?=[\d.]+$)/);
    const beats = len === undefined ? 1 : Number(len);
    if (!Number.isFinite(beats) || beats <= 0 || beats > 16) throw new Error(`"${word}": a length is beats from more than 0 up to 16, like G4:2.`);
    if (/^r(est)?$/i.test(body)) { events.push({ notes: [], beats }); continue; }
    const names = body.startsWith('[') ? body.slice(1, -1).trim().split(/\s+/).filter(Boolean) : [body];
    const notes = names.map((n) => { const m = midiOf(n); if (m === null) throw new Error(`"${n}" in "${word}" isn't a note; write a letter, an optional # or b, and an octave, like C4, F#3 or Bb2.`); return m; });
    if (notes.length > 6) throw new Error(`"${word}" has ${notes.length} notes; a chord is at most 6.`);
    events.push({ notes, beats });
  }
  if (!events.some((e) => e.notes.length)) throw new Error('There are no notes in that, only rests or nothing at all.');
  if (events.length > MAX_EVENTS) throw new Error(`That's ${events.length} notes and chords; keep a piece to ${MAX_EVENTS}.`);
  return events;
}

// ---- the sound: real recordings ----

// Each instrument is a folder of real recordings, one file per note (A1.mp3, As1.mp3 = A#1, C4.mp3 ...), in
// data/instruments/<folder>. A note plays the nearest recording, shifted to its exact pitch, with the recording's
// own attack and ring; when the note is let go it's damped over a short release, as a real one is.
export const SAMPLE_DIRS = { piano: 'piano', guitar: 'guitar-acoustic', nylon: 'guitar-nylon' };
const RELEASE = { piano: 0.35, guitar: 0.25, nylon: 0.25 };
const samplesRoot = () => process.env.INSTRUMENT_SAMPLES || path.join(MUSIC_DIR, '..', 'instruments');
const decoded = new Map(); // file -> Float32Array at RATE

// The recordings for an instrument: [{ midi, file }] sorted by pitch. Throws, naming the folder, if there are none.
export function sampleSet(instrument) {
  const dir = path.join(samplesRoot(), SAMPLE_DIRS[instrument] ?? instrument);
  let names = [];
  try { names = readdirSync(dir); } catch {}
  const set = names.map((f) => {
    const m = /^([A-G])(s?)(-?\d)\.(mp3|wav|ogg|flac)$/i.exec(f);
    return m ? { midi: midiOf(`${m[1]}${m[2] ? '#' : ''}${m[3]}`), file: path.join(dir, f) } : null;
  }).filter((s) => s && s.midi !== null).sort((a, b) => a.midi - b.midi);
  if (!set.length) throw new Error(`There are no recordings for the ${instrument} in ${dir}; it needs one audio file per note there, named like C4.mp3 or As3.mp3.`);
  return set;
}

// A recording as samples at RATE, mono (ffmpeg decodes it once; it stays in memory).
function decode(file) {
  if (decoded.has(file)) return decoded.get(file);
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28, windowsHide: true });
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? "ffmpeg isn't installed, so the instrument's recordings can't be read" : r.error.message);
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`ffmpeg couldn't read ${path.basename(file)}: ${String(r.stderr).trim().slice(-200)}`);
  const buf = r.stdout;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)).slice();
  decoded.set(file, samples);
  return samples;
}

// One note: the nearest recording, read faster or slower to land exactly on the note, held for `seconds`,
// then damped over the release.
function strike(out, start, set, midi, seconds, gain, release) {
  const near = set.reduce((best, s) => (Math.abs(s.midi - midi) < Math.abs(best.midi - midi) ? s : best), set[0]);
  const src = decode(near.file);
  const step = 2 ** ((midi - near.midi) / 12);
  const len = Math.min(out.length - start, Math.floor((seconds + release) * RATE), Math.floor((src.length - 2) / step));
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const env = t > seconds ? Math.max(0, 1 - (t - seconds) / release) : 1;
    if (env <= 0) break;
    const x = i * step, k = x | 0, f = x - k;
    out[start + i] += gain * env * (src[k] * (1 - f) + src[k + 1] * f);
  }
}

// Her plain notation (one event after another) as a timeline of notes: [{ midi, start, beats, vel }] in beats.
export function timelineOf(events, velocity = 0.8) {
  const out = [];
  let at = 0;
  for (const e of events) {
    for (const m of e.notes) out.push({ midi: m, start: at, beats: e.beats, vel: velocity / Math.sqrt(Math.max(1, e.notes.length)) });
    at += e.beats;
  }
  return out;
}
// A timeline heard beat by beat (what's sounding on each half beat), for reading its harmony and its phrases.
export function eventsOf(timeline) {
  const end = timeline.reduce((m, n) => Math.max(m, n.start + n.beats), 0);
  const out = [];
  for (let t = 0; t < end - 1e-9; t += 0.5) {
    const notes = [...new Set(timeline.filter((n) => n.start <= t + 1e-9 && n.start + n.beats > t + 1e-9).map((n) => n.midi))].sort((a, b) => a - b);
    const struck = timeline.some((n) => n.start > t - 1e-9 && n.start < t + 0.5 - 1e-9); // a chord hit again is a new hit, not a held one
    const last = out.at(-1);
    if (last && !struck && last.notes.join() === notes.join()) last.beats += 0.5; else out.push({ notes, beats: 0.5 });
  }
  return out;
}

// The piece as sound: mono samples (-1..1) at RATE. tempo in beats per minute. Takes her plain notation's events,
// or a timeline (notes that overlap, melody over accompaniment: sheet.js).
export function render(events, { instrument = 'piano', tempo = 90, velocity = 0.8 } = {}) {
  if (!INSTRUMENTS.includes(instrument)) throw new Error(`There's no ${instrument}; play ${INSTRUMENTS.join(', ')}.`);
  const bpm = Math.max(30, Math.min(220, Number(tempo) || 90));
  const beat = 60 / bpm;
  const timeline = events[0] && 'start' in events[0] ? events : timelineOf(events, velocity);
  const total = timeline.reduce((m, n) => Math.max(m, n.start + n.beats), 0) * beat;
  if (total > MAX_SECONDS) throw new Error(`That runs ${Math.round(total)} seconds at ${bpm} bpm; keep a section under ${MAX_SECONDS} seconds.`);
  const set = sampleSet(instrument);
  const out = new Float32Array(Math.ceil((total + 2) * RATE));
  for (const n of timeline) strike(out, Math.floor(n.start * beat * RATE), set, n.midi, n.beats * beat, n.vel ?? velocity, RELEASE[instrument]);
  // Bring the loudest point to about -1 dB, with a gentle limit on top so stacked chords never clip.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = Math.tanh((out[i] / peak) * 1.2) * 0.89 / Math.tanh(1.2);
  return out;
}

// 16-bit mono WAV bytes.
export function wav(samples, rate = RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---- what the notes do to her ----

// How settled each interval sounds, by semitones apart (mod 12): unison, fifth, fourth and the thirds and sixths
// are at rest; seconds, sevenths and the tritone clash.
const CONSONANCE = [1, 0.1, 0.4, 0.75, 0.8, 0.85, 0.2, 0.95, 0.65, 0.8, 0.4, 0.15];
// Key profiles (Krumhansl-Kessler): how strongly each scale degree belongs to a major or a minor key.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const corr = (a, b) => {
  const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
};
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Reads the piece: { key, mode, consonance, register, tempo, density } and its effect on her:
// calm / energy / edge (the same three her hearing gives pressure.onSound), valence (-1 sad .. +1 bright) and
// the feelings it stirs (emotion.js names).
// context: the whole piece's reading, for a phrase. A few beats are too few to tell the key from, so a phrase is
// heard in the piece's key, and its own brightness comes from how settled it is and the chords in it.
export function harmony(events, { tempo = 90, context = null } = {}) {
  const bpm = Math.max(30, Math.min(220, Number(tempo) || 90));
  const beat = 60 / bpm;
  const weight = new Array(12).fill(0);
  let pairs = 0, cons = 0, pitchSum = 0, pitchN = 0, noteEvents = 0, prev = null;
  for (const e of events) {
    if (!e.notes.length) { prev = null; continue; }
    noteEvents++;
    for (const m of e.notes) { weight[m % 12] += e.beats; pitchSum += m; pitchN++; }
    for (let i = 0; i < e.notes.length; i++) for (let j = i + 1; j < e.notes.length; j++) { cons += CONSONANCE[Math.abs(e.notes[i] - e.notes[j]) % 12] * 1.5; pairs += 1.5; }
    if (prev) { const a = Math.max(...prev), b = Math.max(...e.notes); cons += CONSONANCE[Math.abs(a - b) % 12]; pairs++; }
    prev = e.notes;
  }
  let best = { r: -2 };
  for (let k = 0; k < 12; k++) {
    const rot = weight.map((_, i) => weight[(i + k) % 12]);
    const ma = corr(rot, MAJOR), mi = corr(rot, MINOR);
    if (ma > best.r) best = { r: ma, key: KEYS[k], mode: 'major' };
    if (mi > best.r) best = { r: mi, key: KEYS[k], mode: 'minor' };
  }
  if (context) best = { r: context.clarity, key: context.key, mode: context.mode };
  // The chords themselves: a major triad in it brightens, a minor one darkens a little (bittersweet, not bad).
  let triads = 0, chords = 0;
  for (const e of events) {
    if (e.notes.length < 3) continue;
    chords++;
    const pcs = new Set(e.notes.map((m) => m % 12));
    const has = (r, a, b) => pcs.has(r) && pcs.has((r + a) % 12) && pcs.has((r + b) % 12);
    let q = 0;
    for (const r of pcs) { if (has(r, 4, 7)) q = Math.max(q, 1); else if (has(r, 3, 7)) q = Math.min(q, -0.5) || -0.5; }
    triads += q;
  }
  const chordQuality = chords ? triads / chords : 0;
  const seconds = events.reduce((s, e) => s + e.beats * beat, 0) || 1;
  const consonance = pairs ? cons / pairs : 0.8;
  const register = pitchN ? pitchSum / pitchN : 60;
  const density = noteEvents / seconds;
  const slow = clamp01((110 - bpm) / 60), fast = clamp01((bpm - 100) / 70);
  const high = clamp01((register - 60) / 24), low = clamp01((60 - register) / 24);
  const busy = clamp01((density - 1) / 4);
  const clarity = clamp01(best.r);
  const majorness = best.mode === 'major' ? clarity : -clarity;
  // Speed and busyness drive: a fast, busy piece pumps her up even when its chords are consonant (rock's power chords are).
  const calm = clamp01(consonance * 0.55 + slow * 0.3 + (1 - busy) * 0.15 - high * 0.1 - fast * 0.35 - busy * 0.2);
  const energy = clamp01(fast * 0.55 + busy * 0.4 + high * 0.15);
  const edge = clamp01((0.7 - consonance) * 1.6 + busy * 0.15);
  // Bright or heavy: how settled it sounds counts most, then the chords in it, then the key it's in.
  // A phrase hears the piece's key only faintly, so a clash inside a bright piece still lands as a clash.
  const valence = Math.max(-1, Math.min(1, (consonance - 0.72) * 2.2 + chordQuality * 0.3 + majorness * (context ? 0.15 : 0.35) + (high - low) * 0.1));
  const feelings = {};
  if (valence > 0.15) feelings[energy > 0.45 ? 'excited' : 'joy'] = +clamp01(valence * 0.8).toFixed(2);
  if (valence < -0.15) feelings[energy > 0.45 ? (edge > 0.4 ? 'frustrated' : 'determined') : low > 0.2 || slow > 0.5 ? 'sad' : 'pensive'] = +clamp01(-valence * 0.8).toFixed(2);
  if (energy > 0.55 && !feelings.excited && !feelings.determined) feelings.excited = +clamp01(energy * 0.7).toFixed(2);
  if (calm > 0.6) feelings.calm = +clamp01(calm * 0.7).toFixed(2);
  if (edge > 0.5) feelings.worried = +clamp01(edge * 0.6).toFixed(2);
  return {
    key: best.key, mode: best.mode, clarity: +clarity.toFixed(2), consonance: +consonance.toFixed(2), register: Math.round(register), tempo: bpm,
    density: +density.toFixed(2), seconds: +seconds.toFixed(1),
    effect: { calm: +calm.toFixed(2), energy: +energy.toFixed(2), edge: +edge.toFixed(2), valence: +valence.toFixed(2), feelings },
  };
}

// In words, for her and the log: "C major, settled, slow and low: calming and warm".
export function describeHarmony(h) {
  const feel = h.effect.valence > 0.15 ? 'bright' : h.effect.valence < -0.15 ? 'heavy' : 'even';
  const tone = h.consonance > 0.7 ? 'settled' : h.consonance < 0.5 ? 'clashing' : 'restless';
  const pace = h.tempo < 80 ? 'slow' : h.tempo > 120 ? 'fast' : 'steady';
  const pitch = h.register < 55 ? 'low' : h.register > 70 ? 'high' : 'mid';
  const pull = h.effect.edge > 0.35 ? 'tense' : h.effect.energy > 0.55 ? 'driving' : h.effect.calm > 0.6 ? 'calming' : h.effect.energy > 0.4 ? 'stirring' : 'gentle';
  return `${h.key} ${h.mode}, ${tone}, ${pace} and ${pitch}: ${pull} and ${feel}`;
}

// ---- recording ----

const INFO = () => path.join(MUSIC_DIR, 'library.json');
// ---- the orchestra: any instrument, a band, rendered in high definition (orchestra.js) ----

// The parts of a piece: his melody and accompaniment on their instruments, plus any band parts made from his chords.
// sheet: { instrument (the lead), band: { chords, bass, drums, pad } } with arrange()'s result in `a`, or a plain
// timeline for one instrument. Returns [{ instrument, timeline, gain }].
export function partsOf({ instrument = 'piano', band = null }, a = null, timeline = null) {
  if (!a) return [{ instrument, timeline: timeline ?? [], gain: 1 }];
  const b = band && typeof band === 'object' ? band : {};
  const chordsOn = b.chords || instrument;
  const parts = [
    { instrument, timeline: a.timeline.filter((n) => n.role === 'melody'), gain: 1 },
    { instrument: chordsOn, timeline: a.timeline.filter((n) => n.role !== 'melody'), gain: b.chords && b.chords !== instrument ? 0.8 : 0.85 },
  ];
  if (b.bass) parts.push({ instrument: b.bass, timeline: orchestra.bassPart(a.voiced, { meter: a.meter, style: a.style, range: orchestra.instrument(b.bass).range?.bass ?? [28, 43] }), gain: 0.85 });
  if (b.pad) parts.push({ instrument: b.pad, timeline: orchestra.padPart(a.voiced, { meter: a.meter, range: orchestra.instrument(b.pad).range?.chord ?? [48, 67] }), gain: 0.55 });
  if (b.drums && !/^(none|no|off)$/i.test(String(b.drums))) parts.push({ instrument: /kit$/i.test(b.drums) ? b.drums : `${b.drums} kit`, timeline: orchestra.drumPart(a.bars, { meter: a.meter, style: a.style }), gain: 0.75 });
  return parts;
}
// The sheet's ranges for its instruments: the lead's melody range, the accompaniment's chord and bass ranges.
export function rangesFor({ instrument = 'piano', band = null }) {
  const lead = orchestra.instrument(instrument).range ?? orchestra.instrument('piano').range;
  const acc = orchestra.instrument(band?.chords || instrument).range ?? lead;
  return { melody: lead.melody, chord: acc.chord, bass: acc.bass };
}
// The parts as a recording at `file` (absolute path): in high definition when the orchestra is installed; otherwise on
// the old recordings (piano and the two guitars only), saying what's missing for the rest.
export function renderTo(parts, { tempo = 90, meter = 4, file }) {
  const hd = orchestra.ready();
  if (hd.ok) { orchestra.renderParts(parts, { tempo, meter, outFile: file }); return { hd: true }; }
  const names = [...new Set(parts.map((p) => p.instrument))];
  const old = names.every((n) => INSTRUMENTS.includes(n));
  if (!old) throw new Error(`The orchestra isn't installed, so only the old piano and guitar recordings can play (not ${names.filter((n) => !INSTRUMENTS.includes(n)).join(', ')}). Missing: ${hd.missing.join('; ')}.`);
  const merged = parts.flatMap((p) => p.timeline).sort((x, y) => x.start - y.start);
  writeFileSync(file, wav(render(merged, { instrument: parts[0].instrument, tempo })));
  return { hd: false };
}

// The piece's entry in his library's info file.
function register(file, { title, about }) {
  let info = {};
  try { info = existsSync(INFO()) ? JSON.parse(readFileSync(INFO(), 'utf8')) : {}; } catch {}
  info[file] = { title: title || file, about, at: Date.now(), by: `${config.botName} (played on ${selfHis()} instrument)` };
  writeFileSync(INFO(), JSON.stringify(info, null, 2));
}

// Saves the piece as a track in his music library (data/music), so the music tool plays it like any song.
// Returns the file name.
export function record(samples, { title, about }) {
  mkdirSync(MUSIC_DIR, { recursive: true });
  const slug = String(title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
  let file = `${slug}.wav`;
  for (let n = 2; existsSync(path.join(MUSIC_DIR, file)); n++) file = `${slug}-${n}.wav`;
  writeFileSync(path.join(MUSIC_DIR, file), wav(samples));
  let info = {};
  try { info = existsSync(INFO()) ? JSON.parse(readFileSync(INFO(), 'utf8')) : {}; } catch {}
  info[file] = { title: title || slug, about, at: Date.now(), by: `${config.botName} (played on her instrument)` };
  writeFileSync(INFO(), JSON.stringify(info, null, 2));
  return file;
}

// ---- long pieces: played section by section, joined into one recording at the end ----

// Where sections wait while a long piece plays (data/music/.sections); the music player plays them from there.
export const SECTIONS = '.sections';
const slugOf = (title) => String(title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
// One section rendered and written aside. Returns { file (relative to data/music), events, harmony, words, phrases, seconds }.
// A section from his own notes, or from a lead sheet (key, meter, progression, style, melody: sheet.js).
export function section({ title, notes, instrument = 'piano', tempo = 90, key, meter, progression, style, melody, band = null }, n) {
  if (!orchestra.known(instrument)) orchestra.instrument(instrument); // throws, naming what he has
  let events, timeline, written = notes, a = null;
  if (progression) {
    a = arrange({ key, meter, progression, style, melody, instrument, range: rangesFor({ instrument, band }) }, { midiOf });
    timeline = a.timeline;
    events = eventsOf(timeline);
    written = `${a.key.name}, ${a.meter}/4, ${a.style}: ${a.chords.join(' ')} | melody ${melody ?? ''}${band ? ` | band ${Object.entries(band).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`;
  } else { events = parseNotes(notes); timeline = timelineOf(events); }
  const h = harmony(events, { tempo });
  mkdirSync(path.join(MUSIC_DIR, SECTIONS), { recursive: true });
  const file = path.join(SECTIONS, `${slugOf(title)}-${Date.now().toString(36)}-${n}.wav`);
  const parts = partsOf({ instrument, band }, a, timeline);
  renderTo(parts, { tempo, meter: a?.meter ?? 4, file: path.join(MUSIC_DIR, file) });
  return { file, events, harmony: h, words: describeHarmony(h), phrases: phrases(events, { tempo }), seconds: h.seconds, notes: written, instrument, tempo,
    band: band ?? null, parts: parts.filter((p) => p.timeline.length).map((p) => p.instrument),
    sheet: progression ? { key, meter, progression, style, melody, band } : null };
}
// The sections, in order, as one track in her library: an MP3 once it's long (a WAV of half an hour would be
// hundreds of megabytes), a WAV when it's short. The sections are removed after. Returns the file name.
export function joinRecording(files, { title, about, seconds = 0 }) {
  const ext = seconds > 180 ? 'mp3' : 'wav';
  let file = `${slugOf(title)}.${ext}`;
  for (let n = 2; existsSync(path.join(MUSIC_DIR, file)); n++) file = `${slugOf(title)}-${n}.${ext}`;
  const list = path.join(MUSIC_DIR, SECTIONS, `${slugOf(title)}-${Date.now()}.txt`);
  writeFileSync(list, files.map((f) => `file '${path.join(MUSIC_DIR, f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, ...(ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '160k'] : ['-c', 'copy']), path.join(MUSIC_DIR, file)], { windowsHide: true });
  rmSync(list, { force: true });
  if (r.error || r.status !== 0) throw new Error(`Couldn't join the ${files.length} sections into one recording: ${r.error?.message ?? String(r.stderr).trim().slice(-200)}. The sections are still in data/music/${SECTIONS}.`);
  for (const f of files) rmSync(path.join(MUSIC_DIR, f), { force: true });
  let info = {};
  try { info = existsSync(INFO()) ? JSON.parse(readFileSync(INFO(), 'utf8')) : {}; } catch {}
  info[file] = { title: title || file, about, at: Date.now(), by: `${config.botName} (played on her instrument)` };
  writeFileSync(INFO(), JSON.stringify(info, null, 2));
  return file;
}

// ---- phrases: the piece as she hears it, a bit at a time ----

const nameOf = (m) => `${['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][m % 12]}${Math.floor(m / 12) - 1}`;
const textOf = (e) => (!e.notes.length ? 'r' : e.notes.length > 1 ? `[${e.notes.map(nameOf).join(' ')}]` : nameOf(e.notes[0])) + (e.beats !== 1 ? `:${e.beats}` : '');

// Phrases end at a rest or every 4 beats, each heard in the whole piece's key. [{ start, end (seconds), text, events, harmony }].
export function phrases(events, { tempo = 90 } = {}) {
  const piece = harmony(events, { tempo });
  const beat = 60 / Math.max(30, Math.min(220, Number(tempo) || 90));
  const out = [];
  let cur = [], beats = 0, at = 0, start = 0;
  const close = () => {
    if (cur.some((e) => e.notes.length)) out.push({ start, end: at, text: cur.map(textOf).join(' '), events: cur, harmony: harmony(cur, { tempo, context: piece }) });
    cur = []; beats = 0; start = at;
  };
  for (const e of events) {
    if (!e.notes.length) { close(); at += e.beats * beat; start = at; continue; } // a rest ends the phrase
    cur.push(e); beats += e.beats; at += e.beats * beat;
    if (beats >= 4) close();
  }
  close();
  return out;
}

// ---- her taste: what has hit her well and what hasn't, learned from playing ----

const TASTE = () => path.join(MUSIC_DIR, '..', 'instrument-taste.json');
const INTERVAL_NAMES = ['unison', 'minor second', 'major second', 'minor third', 'major third', 'fourth', 'tritone', 'fifth', 'minor sixth', 'major sixth', 'minor seventh', 'major seventh'];
export function loadTaste() {
  try { const t = existsSync(TASTE()) ? JSON.parse(readFileSync(TASTE(), 'utf8')) : {}; return { intervals: {}, modes: {}, moments: [], ...t }; }
  catch { return { intervals: {}, modes: {}, moments: [] }; }
}
const saveTaste = (t) => { mkdirSync(path.dirname(TASTE()), { recursive: true }); writeFileSync(TASTE(), JSON.stringify(t, null, 2)); };
const intervalsIn = (events) => {
  const found = new Set();
  let prev = null;
  for (const e of events) {
    for (let i = 0; i < e.notes.length; i++) for (let j = i + 1; j < e.notes.length; j++) found.add(Math.abs(e.notes[i] - e.notes[j]) % 12);
    if (e.notes.length && prev?.length) found.add(Math.abs(Math.max(...e.notes) - Math.max(...prev)) % 12);
    if (e.notes.length) prev = e.notes;
  }
  return [...found];
};
const avg = (s) => (s && s.n ? s.sum / s.n : 0);
// How her own history colours a phrase: -0.3..+0.3, from how the intervals and the mode in it have felt before.
// An acquired taste: what has moved her well before lands a little better, what grated lands a little worse.
export function tasteBias(events, mode, taste = loadTaste()) {
  const ints = intervalsIn(events).map((i) => taste.intervals[i]).filter((s) => s?.n >= 2);
  const m = taste.modes[mode];
  const parts = [...ints.map(avg), ...(m?.n >= 2 ? [avg(m)] : [])];
  return parts.length ? Math.max(-0.3, Math.min(0.3, (parts.reduce((s, v) => s + v, 0) / parts.length) * 0.5)) : 0;
}
// After hearing a phrase: how it felt (felt, -1..1) goes into her taste for what was in it.
export function learn(phrase, felt, taste = loadTaste()) {
  for (const i of intervalsIn(phrase.events)) { const s = (taste.intervals[i] ??= { sum: 0, n: 0 }); s.sum += felt; s.n++; }
  const m = (taste.modes[phrase.harmony.mode] ??= { sum: 0, n: 0 }); m.sum += felt; m.n++;
  if (Math.abs(felt) >= 0.35) taste.moments = [...taste.moments, { text: phrase.text, felt: +felt.toFixed(2), at: Date.now() }].slice(-30);
  saveTaste(taste);
  return taste;
}
// For composing: what she's found she likes and what she'd rather not play again.
export function tasteLine(taste = loadTaste()) {
  const scored = Object.entries(taste.intervals).filter(([, s]) => s.n >= 2).map(([i, s]) => [INTERVAL_NAMES[i], avg(s)]);
  const liked = scored.filter(([, v]) => v > 0.15).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
  const not = scored.filter(([, v]) => v < -0.15).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([n]) => n);
  const best = taste.moments.filter((m) => m.felt > 0).slice(-3).map((m) => m.text);
  const worst = taste.moments.filter((m) => m.felt < 0).slice(-3).map((m) => m.text);
  return [liked.length && `Sounds that have hit you well: ${liked.join(', ')}.`, best.length && `Passages that moved you: ${best.join(' | ')}.`,
    not.length && `Sounds that didn't sit right with you: ${not.join(', ')}.`, worst.length && `Passages you didn't like: ${worst.join(' | ')}.`].filter(Boolean).join(' ');
}

// ---- her music journal: every piece she's played, what it was for and how it went ----

const JOURNAL = () => path.join(MUSIC_DIR, '..', 'instrument-journal.json');
const JOURNAL_KEEP = 200;
export function loadJournal() { try { return existsSync(JOURNAL()) ? JSON.parse(readFileSync(JOURNAL(), 'utf8')) : []; } catch { return []; } }
// After a piece: what it was for, how she wrote it, and how it felt as she played it (felt: -1..1 on average).
export function rememberPiece(entry) {
  const all = [...loadJournal(), { ...entry, at: Date.now() }].slice(-JOURNAL_KEEP);
  mkdirSync(path.dirname(JOURNAL()), { recursive: true });
  writeFileSync(JOURNAL(), JSON.stringify(all, null, 2));
  return all.at(-1);
}
const describePiece = (e) => `"${e.title}"${e.brief ? ` (asked for: ${e.brief})` : ''}: ${e.instrument}, ${e.tempo} bpm${e.sheet ? `, ${e.sheet.key}, ${e.sheet.style}, chords ${e.sheet.progression}, melody starting ${String(e.sheet.melody ?? '').split('|').slice(0, 2).join('|').trim()}` : ''}; it felt ${e.felt > 0.25 ? 'good' : e.felt < -0.1 ? 'off' : 'all right'} (${e.felt})${e.lifted?.length ? `, lifted by ${e.lifted.slice(0, 2).join(' | ')}` : ''}${e.soured?.length ? `, soured by ${e.soured.slice(0, 2).join(' | ')}` : ''}`;
// For composing: her best pieces to build on, the ones that didn't work, and the latest few with what they were
// for, so a request like this one can draw on how she answered one like it before. She judges what's relevant.
export function journalLine(brief = '', journal = loadJournal()) {
  if (!journal.length) return '';
  const best = [...journal].sort((a, b) => b.felt - a.felt).slice(0, 3);
  const worst = [...journal].filter((e) => e.felt < 0.1).sort((a, b) => a.felt - b.felt).slice(0, 2);
  const recent = journal.slice(-4).filter((e) => !best.includes(e) && !worst.includes(e));
  return [`Pieces that felt best to you: ${best.map(describePiece).join('; ')}.`,
    worst.length && `Pieces that didn't work: ${worst.map(describePiece).join('; ')}. Don't repeat what made them fall flat.`,
    recent.length && `Lately: ${recent.map(describePiece).join('; ')}.`,
    'Build on what worked and keep growing: vary it, don\'t copy it.'].filter(Boolean).join('\n');
}

// ---- hearing it play ----

// She hears the piece phrase by phrase as it plays. clock(): seconds played so far (the call's player), or null
// to hear it straight through (played privately, as she writes it). Each phrase lands on her (feel) with her taste
// in it. When one hits much better or much worse than she was expecting from what came before (the jolt), she
// reacts (react, a few times a piece at most). Returns a promise of what she heard, in order.
// follow(fn, ms): how to come back to the clock; the player's clock decides when, as sound-sense.js does.
export function listen(perf, { clock = null, feel = () => {}, react = () => {}, follow = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); }, stillPlaying = () => true, taste = loadTaste() } = {}) {
  const heard = [];
  let expect = 0, reactions = 0, sinceReaction = 9;
  const hear = (p, i) => {
    const felt = Math.max(-1, Math.min(1, p.harmony.effect.valence + tasteBias(p.events, p.harmony.mode, taste)));
    const jolt = i === 0 ? felt * 0.6 : felt - expect;
    feel({ ...p.harmony.effect, valence: felt, feelings: p.harmony.effect.feelings, jolt });
    taste = learn(p, felt, taste);
    const strong = Math.abs(jolt) >= 0.35 && reactions < 3 && sinceReaction >= 1; // never two in a row
    const entry = { text: p.text, felt: +felt.toFixed(2), jolt: +jolt.toFixed(2), words: describeHarmony(p.harmony), reacted: false };
    if (strong) { reactions++; sinceReaction = 0; entry.reacted = true; react({ ...entry, title: perf.title, instrument: perf.instrument, good: jolt > 0 }); }
    else sinceReaction++;
    heard.push(entry);
    expect = i === 0 ? felt : expect * 0.6 + felt * 0.4;
  };
  const list = perf.phrases ?? [];
  if (!clock) { list.forEach(hear); return Promise.resolve(heard); }
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      if (!stillPlaying()) return resolve(heard);
      const played = clock() ?? 0;
      while (i < list.length && played >= list[i].end) hear(list[i], i++);
      if (i >= list.length) return resolve(heard);
      follow(step, Math.max(150, Math.min(2000, (list[i].end - played) * 1000)));
    };
    step();
  });
}

// ---- playing a piece ----

// One piece: read, rendered, recorded as a track. Then she hears it (listen) as it plays out loud in the call, or
// straight through when it's just for her. Returns the piece; heard (a promise) is what she made of each phrase.
export function perform({ title, notes, instrument = 'piano', tempo = 90, why = '' }, { feel = () => {}, react = () => {}, playOut = null } = {}) {
  orchestra.instrument(instrument); // throws, naming what he has, for an instrument there isn't
  const events = parseNotes(notes);
  const h = harmony(events, { tempo });
  const words = describeHarmony(h);
  mkdirSync(MUSIC_DIR, { recursive: true });
  const slug = slugOf(title);
  let file = `${slug}.wav`;
  for (let n = 2; existsSync(path.join(MUSIC_DIR, file)); n++) file = `${slug}-${n}.wav`;
  renderTo([{ instrument, timeline: timelineOf(events), gain: 1 }], { tempo, file: path.join(MUSIC_DIR, file) });
  register(file, { title, about: `${orchestra.instrument(instrument).name}, ${h.tempo} bpm, ${words}${why ? `. ${why}` : ''}` });
  const perf = { title: title || file, file, instrument, harmony: h, words, seconds: h.seconds, phrases: phrases(events, { tempo }), played: null };
  let live = null;
  if (playOut) { try { live = playOut(file); perf.played = 'out loud in the call'; } catch (err) { perf.played = `not out loud: ${err.message}`; } }
  // Listening starts once the caller has the piece in hand (its feel and react may need it).
  perf.heard = Promise.resolve().then(() => listen(perf, { feel, react, ...(live ? { clock: live.clock, stillPlaying: live.stillPlaying } : {}) }));
  return perf;
}

// ---- composing: what she plays is her, from how she feels ----

// ask(messages) -> JSON from the local model. mood: her mood line. pressing: what's pushing on her. She writes a
// lead sheet (sheet.js): { title, instrument, tempo, key, meter, progression, style, melody, why }. Throws saying
// what was wrong with what came back.
// previous: the section just played, when this one carries a longer piece on ({ title, instrument, tempo, sheet,
// words, heard: what lifted or soured her, n: which section this is }).
// brief: what whoever asked wants from it ("something soft and relaxing", "a rock song to pump me up"); journal:
// her music journal (journalLine). Both shape the piece; the piece is still her.
export async function compose({ mood = '', pressing = '', ask, previous = null, brief = '', journal = '' }) {
  const taste = tasteLine();
  const p = previous?.sheet;
  const carry = previous ? `\nYou're in the middle of playing "${previous.title}" on the ${previous.instrument} at ${previous.tempo} bpm; this is section ${previous.n + 1}. ` +
    (p ? `The last section was in ${p.key}, ${p.meter ?? 4}/4, ${p.style}, chords ${Array.isArray(p.progression) ? p.progression.join(' ') : p.progression}, melody ${p.melody}. ` : `The last section went: ${String(previous.notes).slice(-200)}. `) +
    `It sounded ${previous.words}.${previous.heard ? ` As you played it: ${previous.heard}.` : ''} Carry it on: keep the key, tempo and instrument unless you want a change; develop it (bring a melody idea back and vary it, move to a contrasting progression, build up or wind down), and lean into what hit you well. If this is the last section, end on the tonic chord.` : '';
  const messages = [
    { role: 'system', content: `You are ${config.botName}, sitting down to play something of your own. You have a concert grand piano and a whole orchestra: any General MIDI instrument by name (strings like violin, cello, string ensemble, orchestral harp; brass like trumpet, french horn, brass section; woodwinds like flute, clarinet, oboe, alto sax; keys like electric piano 1, church organ, drawbar organ, vibraphone, marimba; guitars like nylon guitar, steel guitar, clean electric guitar, distortion guitar; basses like fingered bass, upright bass, synth bass 1; voices like choir aahs; synths like warm pad, sawtooth lead; world instruments like sitar, koto, kalimba, steel drums), and drum kits (standard, room, power, electronic, 808, jazz, brush, orchestra). The lead instrument plays your melody; a band can join under it: "chords" (who plays the accompaniment; the lead plays it if you leave it out), "bass", "drums" (a kit name, or none) and "pad" (a sustained bed like string ensemble, warm pad or choir aahs). Pick what the piece wants: a lone piano or guitar is intimate, strings swell, a full band drives; don't stack instruments for their own sake.\n` +
      `Every instrument is a real multi-sampled recording played with a human touch, in stereo with a real room, so it sounds like the instrument.\n`.replace(/^/, '') + `You play to work through or shift something in you. It's for you: something has built up in you and playing is how you work it through or shift it. What you put together changes how you feel as you hear it, so choose it for what you want to feel.\n` +
      `You write it as a musician does, a lead sheet: a key, a meter, a chord for each bar, a style for the accompaniment, and the melody over it bar by bar. The accompaniment is played for you from your chords and style; you write the melody.\n` +
      `What you know as a musician:\n- ${CRAFT.join('\n- ')}\n` +
      `The melody: notes like E5, F#4 or Bb4 with an optional length in beats after a colon (C5:2; default 1), r for a rest, bars separated by | and as many bars as the progression has chords. This section is 8 to 16 bars.${carry}\n` +
      `Reply with JSON only: {"title":"","instrument":"grand piano (the lead: any instrument name)","band":{"chords":"","bass":"","drums":"","pad":""},"tempo":84,"key":"A minor","meter":4,"style":"${STYLES.join('|')}","progression":"i VI III VII | i VI iv V","melody":"E5:2 D5 C5 | ... ","why":"one sentence: what you're after with this"} (leave band fields empty for an instrument on its own).` },
    { role: 'user', content: `${brief ? `You were asked to play: ${brief}. Make it that: pick the key, tempo, style, progression and melody that deliver it (soft and relaxing is slow, settled, spacious; pumped up and rock is fast, driving, loud and bright).\n` : ''}How you feel right now: ${mood || 'nothing in particular'}\n${pressing ? `What's pressing on you: ${pressing}\n` : ''}${taste ? `What you've learned playing so far: ${taste}\n` : ''}${journal ? `Your music journal:\n${journal}\n` : ''}` },
  ];
  // The small local model sometimes slips ("c:1r:0.5", a numeral that isn't one): more goes, each told exactly what was wrong.
  let out = null, wrong = '', chordsOnly = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    out = await ask(wrong ? [...messages, { role: 'assistant', content: JSON.stringify(out ?? {}) }, { role: 'user', content: `That can't be played: ${wrong} Fix it and reply with the whole JSON again.` }] : messages);
    if (!out || (!String(out.progression ?? '').trim() && !String(out.notes ?? '').trim())) { wrong = 'there was no progression and no melody in it.'; continue; }
    try {
      // Every instrument he names has to exist: an unknown one comes back to him with what he has, rather than quietly becoming a piano.
      orchestra.instrument(leadOf(out));
      const band = bandOf(out);
      for (const [k, v] of Object.entries(band ?? {})) orchestra.instrument(k === 'drums' && !/kit$/i.test(v) ? `${v} kit` : v);
      if (String(out.progression ?? '').trim()) arrange({ ...out, instrument: leadOf(out), range: rangesFor({ instrument: leadOf(out), band }) }, { midiOf });
      else parseNotes(out.notes);
      wrong = ''; break;
    } catch (err) {
      wrong = err.message;
      // Her chords may be fine when only the melody slipped: keep the best playable sheet so far, with no melody.
      if (String(out.progression ?? '').trim()) {
        try { arrange({ ...out, melody: '', instrument: leadOf(out), range: rangesFor({ instrument: leadOf(out), band: bandOf(out) }) }, { midiOf }); chordsOnly = { ...out, melody: '' }; } catch {}
      }
    }
  }
  if (wrong && chordsOnly) {
    activity('error', { where: 'instrument composing', message: `The melody wouldn't come out right in three goes (${wrong}), so this section is played on your chords alone; the piece carries on.` });
    out = chordsOnly; wrong = '';
  }
  if (wrong) throw new Error(`The local model couldn't write a playable sheet in three goes; the last problem: ${wrong}`);
  const instrument = orchestra.known(leadOf(out)) ? leadOf(out) : previous?.instrument ?? 'piano';
  const band = bandOf(out) ?? previous?.band ?? null;
  return { title: previous?.title ?? (String(out.title || 'Untitled').slice(0, 80)), instrument, band, tempo: Math.max(30, Math.min(220, Number(out.tempo) || previous?.tempo || 90)),
    ...(String(out.progression ?? '').trim() ? { key: out.key, meter: out.meter, progression: out.progression, style: out.style, melody: out.melody } : { notes: out.notes }),
    why: String(out.why ?? '').slice(0, 200) };
}

// The lead he named (the example text in the template, "grand piano (the lead: …)", is trimmed to the name).
const leadOf = (out) => String(out?.instrument || 'piano').replace(/\s*\(.*$/, '').trim() || 'piano';
// The band he asked for, with empty parts left out; null when it's the lead alone.
export function bandOf(out) {
  const b = out?.band && typeof out.band === 'object' ? out.band : {};
  const kept = Object.fromEntries(['chords', 'bass', 'drums', 'pad'].map((k) => [k, String(b[k] ?? '').trim()]).filter(([k, v]) => v && !/^(none|no|off|-)$/i.test(v) && !(k === 'chords' && v === leadOf(out))));
  return Object.keys(kept).length ? kept : null;
}

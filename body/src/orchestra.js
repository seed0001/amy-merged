// His instruments, the whole spectrum, as real as they can sound on this PC (owner, 2026-11-11: "I want the most high
// definition, most realistic music implementation he can do. And don't just limit him to those. Let him have a whole
// spectrum of instruments.").
//
// How: each part of a piece is written out as a MIDI performance (with velocity, a human touch and the sustain pedal)
// and played through FluidSynth, the sample-based synthesizer MuseScore and many DAWs use, with real multi-sampled
// instruments: the Salamander Grand Piano (a Yamaha C5 recorded at 16 dynamic layers) for piano, and MuseScore General
// (a complete General MIDI orchestra: all 128 instruments plus drum kits) for everything else. Each part renders at
// 48 kHz stereo with the engine's room reverb; ffmpeg mixes the parts and masters the result (limiter and loudness).
// Before this he had three instruments, each a folder of single-velocity mono recordings, pitch-shifted.
//
// Nothing here runs a model or the network. If the engine or a sound set is missing, the error says which and where
// it goes; the old recordings still play piano and the two guitars (instrument.js).
import { writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export const HD_RATE = 48000;
const root = () => process.env.SOUNDFONTS_DIR || 'C:\\Bots\\soundfonts';
const exe = () => process.env.FLUIDSYNTH_PATH || path.join(root(), 'fluidsynth', 'bin', 'fluidsynth.exe');
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const FONT_FILES = { piano: ['SalamanderGrandPiano'], gm: ['MuseScore_General'] };
// The sound set on disk for a font: the first .sf2/.sf3 under the soundfonts folder whose name starts as listed.
export function fontFile(font) {
  const want = FONT_FILES[font] ?? [font];
  const walk = (dir, depth = 0) => {
    let out = [];
    try { for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory() && depth < 3) out = out.concat(walk(p, depth + 1));
      else if (/\.sf[23]$/i.test(f.name)) out.push(p);
    } } catch {}
    return out;
  };
  return walk(root()).find((p) => want.some((w) => path.basename(p).toLowerCase().startsWith(w.toLowerCase()))) ?? null;
}

// General MIDI, program 0..127.
export const GM = ['acoustic grand piano', 'bright acoustic piano', 'electric grand piano', 'honky-tonk piano', 'electric piano 1', 'electric piano 2', 'harpsichord', 'clavinet',
  'celesta', 'glockenspiel', 'music box', 'vibraphone', 'marimba', 'xylophone', 'tubular bells', 'dulcimer',
  'drawbar organ', 'percussive organ', 'rock organ', 'church organ', 'reed organ', 'accordion', 'harmonica', 'tango accordion',
  'nylon guitar', 'steel guitar', 'jazz guitar', 'clean electric guitar', 'muted electric guitar', 'overdriven guitar', 'distortion guitar', 'guitar harmonics',
  'acoustic bass', 'fingered bass', 'picked bass', 'fretless bass', 'slap bass 1', 'slap bass 2', 'synth bass 1', 'synth bass 2',
  'violin', 'viola', 'cello', 'contrabass', 'tremolo strings', 'pizzicato strings', 'orchestral harp', 'timpani',
  'string ensemble', 'slow strings', 'synth strings 1', 'synth strings 2', 'choir aahs', 'voice oohs', 'synth choir', 'orchestra hit',
  'trumpet', 'trombone', 'tuba', 'muted trumpet', 'french horn', 'brass section', 'synth brass 1', 'synth brass 2',
  'soprano sax', 'alto sax', 'tenor sax', 'baritone sax', 'oboe', 'english horn', 'bassoon', 'clarinet',
  'piccolo', 'flute', 'recorder', 'pan flute', 'blown bottle', 'shakuhachi', 'whistle', 'ocarina',
  'square lead', 'sawtooth lead', 'calliope lead', 'chiff lead', 'charang lead', 'voice lead', 'fifths lead', 'bass and lead',
  'new age pad', 'warm pad', 'polysynth pad', 'choir pad', 'bowed pad', 'metallic pad', 'halo pad', 'sweep pad',
  'rain', 'soundtrack', 'crystal', 'atmosphere', 'brightness', 'goblins', 'echoes', 'sci-fi',
  'sitar', 'banjo', 'shamisen', 'koto', 'kalimba', 'bagpipe', 'fiddle', 'shanai',
  'tinkle bell', 'agogo', 'steel drums', 'woodblock', 'taiko drum', 'melodic tom', 'synth drum', 'reverse cymbal',
  'guitar fret noise', 'breath noise', 'seashore', 'bird tweet', 'telephone ring', 'helicopter', 'applause', 'gunshot'];
// Drum kits (bank 128): what plays the drum part.
export const KITS = { standard: 0, room: 8, power: 16, electronic: 24, '808': 25, jazz: 32, brush: 40, orchestra: 48 };
// The names he already used, and the plain ones people say.
const ALIAS = {
  piano: 'grand piano', 'grand piano': 'grand piano', 'concert grand': 'grand piano', guitar: 'steel guitar', 'acoustic guitar': 'steel guitar', nylon: 'nylon guitar',
  'classical guitar': 'nylon guitar', 'electric guitar': 'clean electric guitar', 'rhodes': 'electric piano 1', 'electric piano': 'electric piano 1', organ: 'drawbar organ',
  'hammond': 'drawbar organ', bass: 'fingered bass', 'bass guitar': 'fingered bass', 'electric bass': 'fingered bass', 'upright bass': 'acoustic bass', 'double bass': 'acoustic bass',
  strings: 'string ensemble', 'string section': 'string ensemble', orchestra: 'string ensemble', choir: 'choir aahs', voices: 'voice oohs', harp: 'orchestral harp',
  sax: 'alto sax', saxophone: 'alto sax', horn: 'french horn', brass: 'brass section', pad: 'warm pad', synth: 'sawtooth lead', 'synth lead': 'sawtooth lead', bells: 'tubular bells',
};
// Where each family sounds good: bass, chords and melody ranges (MIDI notes), for the arranger.
const RANGE = {
  keys: { bass: [36, 50], chord: [48, 64], melody: [60, 84] }, guitar: { bass: [40, 52], chord: [47, 64], melody: [52, 79] },
  bass: { bass: [28, 43], chord: [36, 52], melody: [36, 60] }, strings: { bass: [36, 50], chord: [48, 67], melody: [55, 88] },
  low: { bass: [28, 43], chord: [40, 55], melody: [36, 67] }, brass: { bass: [34, 48], chord: [48, 64], melody: [55, 79] },
  reed: { bass: [36, 50], chord: [48, 64], melody: [55, 84] }, pipe: { bass: [48, 60], chord: [60, 72], melody: [60, 93] },
  voice: { bass: [40, 52], chord: [48, 64], melody: [55, 79] }, pad: { bass: [36, 48], chord: [48, 67], melody: [60, 84] },
  bells: { bass: [48, 60], chord: [60, 76], melody: [64, 96] },
};
const FAMILY = (p) => p <= 7 ? 'keys' : p <= 15 ? 'bells' : p <= 23 ? 'keys' : p <= 31 ? 'guitar' : p <= 39 ? 'bass' : p === 42 || p === 43 ? 'low' : p <= 51 ? 'strings'
  : p <= 55 ? 'voice' : p === 57 || p === 58 ? 'low' : p <= 63 ? 'brass' : p === 67 || p === 70 ? 'low' : p <= 71 ? 'reed' : p <= 79 ? 'pipe' : p <= 87 ? 'reed' : p <= 103 ? 'pad'
  : p <= 111 ? 'guitar' : 'bells';
// Plucked and struck instruments die away; these ring on for as long as a note is held.
const SUSTAINED = (p) => (p >= 16 && p <= 23) || (p >= 40 && p <= 45) || (p >= 48 && p <= 54) || (p >= 56 && p <= 87) || (p >= 88 && p <= 95);

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
// An instrument by name: { name, font, program, bank, drums, range, sustained, pedal }; throws, listing a few, when unknown.
export function instrument(name) {
  const n = ALIAS[norm(name)] ?? norm(name);
  if (/^(drums?|drum kit|kit)$/.test(n) || /\bkit$/.test(n)) {
    const kit = Object.keys(KITS).find((k) => n.startsWith(k)) ?? 'standard';
    return { name: `${kit} drum kit`, font: 'gm', program: KITS[kit], bank: 128, drums: true, range: null, sustained: false, pedal: false };
  }
  if (n === 'grand piano') return { name: 'grand piano', font: 'piano', program: 0, bank: 0, drums: false, range: RANGE.keys, sustained: false, pedal: true };
  let program = GM.indexOf(n);
  if (program < 0) program = GM.findIndex((g) => g.includes(n) || n.includes(g));
  if (program < 0) throw new Error(`There's no instrument called "${name}". You have the whole General MIDI orchestra and a concert grand: for example grand piano, electric piano 1, church organ, nylon guitar, steel guitar, clean electric guitar, distortion guitar, fingered bass, upright bass, violin, cello, string ensemble, orchestral harp, trumpet, french horn, brass section, alto sax, flute, clarinet, oboe, choir aahs, warm pad, sawtooth lead, marimba, vibraphone, sitar, koto, steel drums, and drum kits (standard, room, power, electronic, 808, jazz, brush, orchestra).`);
  return { name: GM[program], font: 'gm', program, bank: 0, drums: false, range: RANGE[FAMILY(program)], sustained: SUSTAINED(program), pedal: program <= 7 };
}
export const known = (name) => { try { instrument(name); return true; } catch { return false; } };

// ---- the performance: a part as a MIDI file ----

const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
// Deterministic "human" variation, so the same piece sounds the same each time it's rendered.
const wobble = (seed) => { const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x) - 0.5; };
const TPQ = 480;
// One part: [{ midi, start, beats, vel (0..1) }] -> SMF type 0 bytes. Bank and program set first; the piano gets its
// sustain pedal changed with each bar (pedalBeats), the way a pianist does; timing and touch vary a little (human).
export function midiFile(timeline, { program = 0, bank = 0, drums = false, tempo = 90, pedalBeats = 0, human = 1, tailBeats = 4 } = {}) {
  const ch = drums ? 9 : 0;
  const ev = []; // [tick, order, bytes]
  ev.push([0, 0, [0xff, 0x51, 0x03, ...[16, 8, 0].map((s) => (Math.round(60_000_000 / tempo) >> s) & 0xff)]]);
  if (!drums) ev.push([0, 1, [0xb0 | ch, 0, bank & 0x7f]], [0, 1, [0xb0 | ch, 32, 0]], [0, 2, [0xc0 | ch, program & 0x7f]]);
  else ev.push([0, 2, [0xc0 | ch, program & 0x7f]]);
  ev.push([0, 1, [0xb0 | ch, 7, 110]], [0, 1, [0xb0 | ch, 91, drums ? 30 : 55]]); // volume, reverb send
  let end = 0;
  timeline.forEach((n, i) => {
    const jitter = drums ? 0.006 : 0.018; // in beats: a few milliseconds early or late
    const t0 = Math.max(0, n.start + wobble(i + n.midi) * jitter * human);
    const len = Math.max(0.05, n.beats * (drums ? 0.5 : 0.96));
    const vel = Math.max(1, Math.min(127, Math.round((n.vel ?? 0.7) * 127 * (1 + wobble(i * 7 + 3) * 0.12 * human))));
    const on = Math.round(t0 * TPQ), off = Math.round((t0 + len) * TPQ);
    ev.push([on, 4, [0x90 | ch, n.midi & 0x7f, vel]], [off, 3, [0x80 | ch, n.midi & 0x7f, 0]]);
    end = Math.max(end, off);
  });
  if (pedalBeats > 0 && !drums) {
    const last = Math.ceil(end / TPQ);
    for (let b = 0; b < last; b += pedalBeats) { ev.push([Math.round(b * TPQ), 1, [0xb0 | ch, 64, 0]], [Math.round(b * TPQ) + 30, 2, [0xb0 | ch, 64, 127]]); }
    ev.push([end, 3, [0xb0 | ch, 64, 0]]);
  }
  ev.push([end + tailBeats * TPQ, 9, [0xff, 0x2f, 0x00]]); // the end, a few beats after the last note so the room rings out
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const body = []; let prev = 0;
  for (const [tick, , bytes] of ev) { body.push(...vlq(tick - prev), ...bytes); prev = tick; }
  const head = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, TPQ >> 8, TPQ & 0xff]);
  const trk = Buffer.from([0x4d, 0x54, 0x72, 0x6b, ...[24, 16, 8, 0].map((s) => (body.length >> s) & 0xff)]);
  return Buffer.concat([head, trk, Buffer.from(body)]);
}

// ---- the band: parts made from his chords (bass, drums, a pad), under his melody and accompaniment ----

// voicedChords: one per bar, pitch classes root first (sheet.js arrange). meter: beats per bar.
export function bassPart(voicedChords, { meter = 4, style = 'ballad', range = [28, 43] } = {}) {
  const out = [];
  const at = (pc) => { let m = range[0] + ((pc - range[0]) % 12 + 12) % 12; while (m < range[0]) m += 12; return m; };
  voicedChords.forEach((c, b) => {
    const root = at(c[0]), fifth = at(c[2] ?? c[0]);
    if (style === 'rock' || style === 'strum') for (let x = 0; x < meter; x += 0.5) out.push({ midi: root, start: b * meter + x, beats: 0.45, vel: x === 0 ? 0.8 : 0.62 });
    else if (style === 'shuffle') for (let x = 0; x < meter; x += 1) out.push({ midi: [root, fifth, root + 12 <= range[1] + 12 ? root + 12 : root, fifth][x % 4], start: b * meter + x, beats: 0.66, vel: 0.7 });
    else if (style === 'waltz') out.push({ midi: root, start: b * meter, beats: 1, vel: 0.72 });
    else { out.push({ midi: root, start: b * meter, beats: meter > 2 ? 2 : meter, vel: 0.72 }); if (meter >= 4) out.push({ midi: fifth, start: b * meter + 2, beats: 2, vel: 0.6 }); }
  });
  return out;
}
export function padPart(voicedChords, { meter = 4, range = [48, 67] } = {}) {
  return voicedChords.flatMap((c, b) => c.slice(0, 4).map((pc, i) => {
    let m = range[0] + ((pc - range[0]) % 12 + 12) % 12; if (i && m < range[0] + 3) m += 12;
    return { midi: m, start: b * meter, beats: meter, vel: 0.42 };
  }));
}
// GM drum notes.
const D = { kick: 36, snare: 38, stick: 37, clap: 39, hat: 42, open: 46, pedal: 44, ride: 51, crash: 49, lowTom: 45, midTom: 47, hiTom: 50, shaker: 70 };
export function drumPart(bars, { meter = 4, style = 'ballad', fills = true } = {}) {
  const out = [];
  const hit = (midi, start, vel) => out.push({ midi, start, beats: 0.25, vel });
  for (let b = 0; b < bars; b++) {
    const s = b * meter;
    if (b === 0) hit(D.crash, s, 0.7);
    if (style === 'waltz' || meter === 3) { hit(D.kick, s, 0.75); hit(D.stick, s + 1, 0.5); hit(D.stick, s + 2, 0.45); for (let x = 0; x < meter; x += 1) hit(D.hat, s + x, 0.35); continue; }
    if (style === 'shuffle') { for (let x = 0; x < meter; x += 1) { hit(D.ride, s + x, 0.55); hit(D.ride, s + x + 0.66, 0.35); } hit(D.kick, s, 0.7); hit(D.kick, s + 2.66, 0.55); hit(D.snare, s + 1, 0.65); hit(D.snare, s + 3, 0.68); continue; }
    if (style === 'ballad' || style === 'arpeggio' || style === 'fingerpick' || style === 'block') {
      hit(D.kick, s, 0.62); if (meter >= 4) hit(D.kick, s + 2.5, 0.45); hit(D.stick, s + 1, 0.45); if (meter >= 4) hit(D.stick, s + 3, 0.5);
      for (let x = 0; x < meter; x += 1) hit(D.hat, s + x, 0.3);
    } else { // rock, strum: a full backbeat
      hit(D.kick, s, 0.85); hit(D.kick, s + 2, 0.8); if (meter >= 4) hit(D.kick, s + 2.5, 0.6);
      hit(D.snare, s + 1, 0.8); if (meter >= 4) hit(D.snare, s + 3, 0.82);
      for (let x = 0; x < meter; x += 0.5) hit(D.hat, s + x, x % 1 ? 0.38 : 0.55);
    }
    if (fills && b % 4 === 3 && meter >= 4) { [D.hiTom, D.midTom, D.lowTom, D.snare].forEach((t, i) => hit(t, s + 3 + i * 0.25, 0.6 + i * 0.05)); }
  }
  return out;
}

// ---- rendering ----

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { windowsHide: true, maxBuffer: 1 << 26 });
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? `${what} isn't installed at ${cmd}.` : `${what} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${what} failed: ${String(r.stderr || r.stdout).trim().slice(-300)}`);
  return r;
}
// Can it render? { ok, missing: [what's not there, with where it goes] }.
export function ready() {
  const missing = [];
  if (!existsSync(exe())) missing.push(`FluidSynth (expected at ${exe()})`);
  if (!fontFile('gm')) missing.push(`MuseScore General (a .sf2 named MuseScore_General… under ${root()})`);
  if (!fontFile('piano')) missing.push(`the Salamander Grand Piano (a .sf2 named SalamanderGrandPiano… under ${root()})`);
  return { ok: missing.length === 0, missing };
}

// The parts as one mastered stereo WAV at outFile. parts: [{ instrument (name), timeline, gain }]. tempo in bpm.
// Returns { file, seconds, parts: [names] }.
export function renderParts(parts, { tempo = 90, meter = 4, outFile }) {
  const tmp = path.join(os.tmpdir(), `orchestra-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const stems = [];
    for (const [i, part] of parts.entries()) {
      if (!part.timeline?.length) continue;
      const inst = instrument(part.instrument);
      const font = fontFile(inst.font);
      if (!font) throw new Error(`The sound set for the ${inst.name} isn't installed: ${ready().missing.join('; ')}.`);
      const mid = path.join(tmp, `part${i}.mid`), wav = path.join(tmp, `part${i}.wav`);
      writeFileSync(mid, midiFile(part.timeline, { program: inst.program, bank: inst.bank, drums: inst.drums, tempo, pedalBeats: inst.pedal ? meter : 0 }));
      run(exe(), ['-n', '-i', '-q', '-F', wav, '-T', 'wav', '-O', 's16', '-r', String(HD_RATE), '-g', '0.6',
        '-o', 'synth.polyphony=512', '-o', 'synth.dynamic-sample-loading=1', '-o', 'synth.reverb.active=1', '-o', 'synth.reverb.room-size=0.55',
        '-o', 'synth.reverb.damp=0.35', '-o', 'synth.reverb.width=0.9', '-o', 'synth.reverb.level=0.6', '-o', 'synth.chorus.active=0', font, mid], 'FluidSynth');
      stems.push({ wav, gain: part.gain ?? 1 });
    }
    if (!stems.length) throw new Error('There were no notes in any part.');
    // Mix the stems, then master: a gentle limiter and loudness to streaming level (-16 LUFS), 48 kHz stereo 16-bit.
    const inputs = stems.flatMap((s) => ['-i', s.wav]);
    const mix = stems.map((s, i) => `[${i}:a]volume=${s.gain.toFixed(2)}[s${i}]`).join(';') + ';' + stems.map((_, i) => `[s${i}]`).join('') +
      `amix=inputs=${stems.length}:normalize=0:dropout_transition=0,alimiter=limit=0.89:attack=5:release=50,loudnorm=I=-16:TP=-1.2:LRA=11[out]`;
    run(ffmpeg(), ['-v', 'error', '-nostdin', '-y', ...inputs, '-filter_complex', mix, '-map', '[out]', '-ar', String(HD_RATE), '-ac', '2', '-c:a', 'pcm_s16le', outFile], 'ffmpeg (mixing the parts)');
    return { file: outFile, parts: parts.filter((p) => p.timeline?.length).map((p) => instrument(p.instrument).name) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

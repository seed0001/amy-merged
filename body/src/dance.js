import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { bus, activity } from './events.js';
import { MUSIC_DIR } from './music.js';

// Dancing to her songs. Each song is read once with ffmpeg and turned into what her avatar needs to
// move with it: the tempo and where every beat falls, how loud each moment is, and a rough vocal line
// (the singing frequencies in the middle of the mix, where vocals sit) for her mouth to sing along to.
// Saved beside the music, so a song is only read once. Her avatar page plays the dance from this;
// no model call is involved. When a song starts, pauses or stops anywhere, every open avatar view hears.

const RATE = 11025;           // plenty for beats and a voice band, and quick to read
const HOP = 220;              // 20 ms frames for beat finding
const OUT_MS = 40;            // what the avatar gets: one value per 40 ms
const CACHE = path.join(MUSIC_DIR, '.dance');

// One-pole filters, enough to split bass and the voice band apart.
const lowpass = (cut) => { const a = Math.exp(-2 * Math.PI * cut / RATE); let y = 0; return (x) => (y = (1 - a) * x + a * y); };
const highpass = (cut) => { const lp = lowpass(cut); return (x) => x - lp(x); };

function decode(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', file, '-ac', '2', '-ar', String(RATE), '-f', 's16le', '-'], { windowsHide: true });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? "ffmpeg isn't installed, so songs can't be read for dancing" : e.message)));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg couldn't read the song: ${err.trim().slice(-200)}`))));
  });
}

const percentile = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 1e-9; };

// The analysis itself, from 16-bit stereo PCM at RATE.
export function analyse(pcm) {
  const n = Math.floor(pcm.length / 4);
  const bassF = lowpass(150), vHp = highpass(300), vLp = lowpass(3000), sHp = highpass(300), sLp = lowpass(3000);
  const frames = Math.floor(n / HOP);
  const energy = new Float32Array(frames), bass = new Float32Array(frames), vocal = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0, b = 0, vm = 0, vs = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) {
      const l = pcm.readInt16LE(i * 4) / 32768, r = pcm.readInt16LE(i * 4 + 2) / 32768;
      const mid = (l + r) / 2, side = (l - r) / 2;
      e += mid * mid;
      const lo = bassF(mid); b += lo * lo;
      const vmx = vLp(vHp(mid)); vm += vmx * vmx;
      const vsx = sLp(sHp(side)); vs += vsx * vsx;
    }
    energy[f] = Math.sqrt(e / HOP); bass[f] = Math.sqrt(b / HOP);
    // Vocals sit in the middle of the mix; guitars and pads spread wide. What's in the voice band in
    // the middle but not the sides is mostly singing.
    vocal[f] = Math.max(0, Math.sqrt(vm / HOP) - 0.85 * Math.sqrt(vs / HOP));
  }
  // Beats: where the bass jumps (onsets), then the tempo whose rhythm lines up with them best.
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, bass[f] - bass[f - 1]) + 0.3 * Math.max(0, energy[f] - energy[f - 1]);
  let best = { score: -1, lag: 25 };
  const fps = RATE / HOP; // frames per second (about 50)
  for (let bpm = 70; bpm <= 160; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let score = 0;
    for (let f = 0; f + lag < frames; f += 2) score += onset[f] * onset[Math.round(f + lag)];
    score /= Math.sqrt(lag); // don't favour long lags just for overlapping more
    if (score > best.score) best = { score, lag, bpm };
  }
  let phase = 0, phaseScore = -1;
  for (let p = 0; p < best.lag; p++) {
    let s = 0;
    for (let t = p; t < frames; t += best.lag) s += onset[Math.round(t)] + 0.5 * (onset[Math.round(t) + 1] ?? 0);
    if (s > phaseScore) { phaseScore = s; phase = p; }
  }
  const beats = [];
  for (let t = phase; t < frames; t += best.lag) beats.push(Math.round((t / fps) * 1000));
  // Down to 40 ms steps, scaled 0..1 against the loud end of the song.
  const step = Math.round(OUT_MS / (1000 / fps));
  const squash = (arr) => { const top = percentile(arr, 0.95); const out = []; for (let f = 0; f < arr.length; f += step) { let m = 0; for (let k = f; k < f + step && k < arr.length; k++) m = Math.max(m, arr[k]); out.push(Math.round(Math.min(1, m / top) * 100) / 100); } return out; };
  return { bpm: Math.round(best.bpm * 2) / 2, beats, frameMs: OUT_MS, energy: squash(energy), vocal: squash(vocal), durationMs: Math.round((frames / fps) * 1000) };
}

// A song's dance, from the cache or read now. file: a name in her music library.
export async function danceFor(file) {
  const name = path.basename(String(file));
  const src = path.join(MUSIC_DIR, name);
  if (!existsSync(src)) throw new Error(`There's no song called ${name} in her music library.`);
  const cached = path.join(CACHE, `${name}.json`);
  if (existsSync(cached) && statSync(cached).mtimeMs >= statSync(src).mtimeMs) return JSON.parse(readFileSync(cached, 'utf8'));
  const started = Date.now();
  const result = { track: name, ...analyse(await decode(src)) };
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, JSON.stringify(result));
  activity('dance', { read: name, bpm: result.bpm, beats: result.beats.length, ms: Date.now() - started });
  return result;
}

// What's playing right now, with where the song is, so a view that opens mid-song (or the corner box
// reloading on a new page) joins in time.
let current = { state: 'stop', track: null, position: 0, at: Date.now() };
export function currentDance() {
  return current.state === 'play' ? { ...current, position: current.position + (Date.now() - current.at), at: Date.now() } : { ...current };
}

// A piece she played on her own instrument (instrument.js records them with `by: ... played on her instrument`):
// she's the one playing it, so she doesn't dance to it (Owner, 2026-11-10: rocking side to side to her own
// playing looked like a seesaw, not a performance).
function ownPiece(name) {
  try { return /played on her instrument/.test(JSON.parse(readFileSync(path.join(MUSIC_DIR, 'library.json'), 'utf8'))[name]?.by ?? ''); }
  catch { return false; }
}

// Tells every open avatar view what's playing. position: ms into the song at `at`.
export function danceState(state, { track = null, source = 'voice' } = {}) {
  const now = Date.now();
  const name = track ? path.basename(track) : current.track;
  // A section of a long piece she's still playing (data/music/.sections) is her own playing too.
  if ((state === 'play' || state === 'resume') && name && (ownPiece(name) || /(^|[\\/])\.sections[\\/]/.test(String(track ?? '')))) state = 'stop';
  // A new song starts at 0; a pause freezes where it got to; a resume carries on from there.
  const position = state === 'play' ? 0 : current.state === 'play' ? current.position + (now - current.at) : current.position;
  current = { state: state === 'resume' ? 'play' : state, track: state === 'stop' ? null : name, position: state === 'stop' ? 0 : position, at: now, source };
  const event = { ...current, at: now };
  bus.emit('avatar-dance', event);
  if (state === 'play' && track) danceFor(track).catch((err) => activity('error', { where: 'dance', message: err.message }));
  return event;
}

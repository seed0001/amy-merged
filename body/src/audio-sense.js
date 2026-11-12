// What sound does to her. Every stretch of audio she hears (a voice in the call) or plays (a song, a
// station) is measured the way an ear hears it: how loud, how bright, how much low end, how fast it
// moves, how it swings. Those numbers become small pushes on her feelings (emotion.js nudge) and on
// her pressure (pressure.js onSound), so slow, soft, warm sound settles her, fast bright sound lifts
// her energy, a thin sad drone pulls her inward, and a loud harsh blast gets on her nerves. Nothing
// here is a timer: a stretch of sound is what sets it off. Pure: PCM in, numbers out.

const BANDS = [['sub', 20, 60], ['bass', 60, 250], ['lowMid', 250, 500], ['mid', 500, 2000], ['highMid', 2000, 4000], ['presence', 4000, 6000], ['air', 6000, 20000]];

// A real FFT (radix-2, in place) on a power-of-two window. Returns magnitudes for bins 0..n/2.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mags = new Float32Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) mags[i] = Math.hypot(re[i], im[i]) / n;
  return mags;
}

// pcm: Int16 mono samples (Buffer or Int16Array) at sampleRate. Returns a profile of the whole stretch.
export function analyze(pcm, sampleRate = 48000, { window = 2048, hop = 1024 } = {}) {
  const s = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const frames = Math.max(0, Math.floor((s.length - window) / hop) + 1);
  if (frames < 2) return null;
  const bands = Object.fromEntries(BANDS.map(([name]) => [name, 0]));
  const hann = new Float32Array(window);
  for (let i = 0; i < window; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (window - 1));
  const re = new Float32Array(window), im = new Float32Array(window);
  const flux = new Float32Array(frames);
  let prev = null, rmsSum = 0, centroidSum = 0, peak = 0, rolloffSum = 0;
  const binHz = sampleRate / window;
  for (let f = 0; f < frames; f++) {
    let sq = 0;
    for (let i = 0; i < window; i++) { const v = s[f * hop + i] / 32768; re[i] = v * hann[i]; im[i] = 0; sq += v * v; peak = Math.max(peak, Math.abs(v)); }
    rmsSum += Math.sqrt(sq / window);
    const mags = fft(re, im);
    let total = 0, weighted = 0;
    for (let b = 1; b < mags.length; b++) { total += mags[b]; weighted += mags[b] * b * binHz; }
    centroidSum += total > 0 ? weighted / total : 0;
    let acc = 0, roll = 0;
    for (let b = 1; b < mags.length && acc < total * 0.85; b++) { acc += mags[b]; roll = b * binHz; }
    rolloffSum += roll;
    for (const [name, lo, hi] of BANDS) {
      let e = 0;
      for (let b = Math.max(1, Math.floor(lo / binHz)); b < Math.min(mags.length, Math.ceil(hi / binHz)); b++) e += mags[b];
      bands[name] += total > 0 ? e / total : 0;
    }
    if (prev) { let d = 0; for (let b = 1; b < mags.length; b++) d += Math.max(0, mags[b] - prev[b]); flux[f] = d; }
    prev = Float32Array.from(mags);
  }
  for (const k of Object.keys(bands)) bands[k] /= frames;
  const rms = rmsSum / frames;
  // Tempo: the strongest repeating gap between onsets, 50 to 200 bpm, by autocorrelation of the flux.
  const hopSec = hop / sampleRate;
  let bpm = 0, best = 0;
  if (frames > 40) {
    const mean = flux.reduce((a, b) => a + b, 0) / frames;
    const x = Float32Array.from(flux, (v) => v - mean);
    const minLag = Math.round(60 / 200 / hopSec), maxLag = Math.min(frames - 2, Math.round(60 / 50 / hopSec));
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i + lag < frames; i++) c += x[i] * x[i + lag];
      c /= frames - lag;
      if (c > best) { best = c; bpm = 60 / (lag * hopSec); }
    }
    const energy = x.reduce((a, v) => a + v * v, 0) / frames;
    if (energy <= 0 || best / energy < 0.15) bpm = 0; // no steady pulse
  }
  const centroid = centroidSum / frames;
  const dynamics = Math.min(1, peak > 0 ? (peak - rms) / peak : 0); // how much it swings between quiet and loud
  const { chroma, bass } = chromaOf(s, sampleRate);
  return { seconds: s.length / sampleRate, rms, loudness: Math.min(1, rms * 4.5), peak, centroid, brightness: Math.min(1, centroid / 4000), rolloff: rolloffSum / frames, bands, bpm: Math.round(bpm), dynamics, ...keyOf(chroma, bass) };
}

// Which of the twelve notes the energy sits on (a chromagram), 100 Hz to 4 kHz. It needs a window fine enough to
// tell neighbouring notes apart (about 6 Hz a bin at 48 kHz): low notes are only a few hertz apart.
// Also returns the bass's own chroma (100 to 300 Hz): the home note usually sits in the bass.
function chromaOf(s, sampleRate, window = 8192) {
  const chroma = new Float64Array(12), bass = new Float64Array(12);
  if (s.length < window) return { chroma, bass };
  const hop = window / 2, binHz = sampleRate / window;
  const pcOf = new Int8Array(window / 2 + 1).fill(-1);
  for (let b = 1; b <= window / 2; b++) { const hz = b * binHz; if (hz >= 100 && hz <= 4000) pcOf[b] = ((Math.round(12 * Math.log2(hz / 440)) + 69) % 12 + 12) % 12; }
  const hann = new Float32Array(window);
  for (let i = 0; i < window; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (window - 1));
  const re = new Float32Array(window), im = new Float32Array(window);
  // At most 40 windows spread over the stretch: plenty for a key, and quick on a long song.
  const count = Math.floor((s.length - window) / hop) + 1, every = Math.max(1, Math.floor(count / 40));
  for (let f = 0; f < count; f += every) {
    for (let i = 0; i < window; i++) { re[i] = (s[f * hop + i] / 32768) * hann[i]; im[i] = 0; }
    const mags = fft(re, im);
    for (let b = 1; b < mags.length; b++) if (pcOf[b] >= 0) { const e = mags[b] * mags[b]; chroma[pcOf[b]] += e; if (b * binHz <= 300) bass[pcOf[b]] += e; }
  }
  return { chroma, bass };
}

// The key it's in, from where its energy sits among the twelve notes, against the Krumhansl-Kessler key profiles:
// { key: 'A', mode: 'minor', clarity: 0..1 }. Speech and noise spread their energy over every note, so their
// clarity is low and they read as no key; music with a tonal centre reads clearly.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
function corr(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
}
export function keyOf(chroma, bass = null) {
  const total = chroma.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return { key: null, mode: null, clarity: 0 };
  const c = Array.from(chroma, (v) => v / total);
  const fits = [];
  for (let k = 0; k < 12; k++) {
    const rot = c.map((_, i) => c[(i + k) % 12]);
    fits.push({ r: corr(rot, MAJOR), pc: k, key: NOTE[k], mode: 'major' }, { r: corr(rot, MINOR), pc: k, key: NOTE[k], mode: 'minor' });
  }
  fits.sort((a, b) => b.r - a.r);
  let best = fits[0];
  // A major key and its relative minor (C major, A minor) share every note, so the notes alone can barely tell them
  // apart, and a key and its fifth come close too. When the runner-up is that close, the bass decides: the home
  // note is the one the bass sits on most.
  const bassTotal = bass ? bass.reduce((s, v) => s + v, 0) : 0;
  if (bassTotal > 0) {
    const close = fits.filter((f) => best.r - f.r < 0.12).slice(0, 4);
    best = close.reduce((a, f) => (bass[f.pc] / bassTotal > bass[a.pc] / bassTotal + 0.02 ? { ...f, r: best.r } : a), best);
  }
  // A key needs energy gathered on a few notes (a chord puts most of it on three or four); noise and chatter spread
  // it evenly, and the correlation alone would still find a "key" in that.
  const top = [...c].sort((a, b) => b - a).slice(0, 4).reduce((s, v) => s + v, 0);
  const gathered = Math.max(0, Math.min(1, (top - 0.42) / 0.3));
  return { key: best.key, mode: best.mode, clarity: +Math.min(gathered, Math.max(0, Math.min(1, (best.r - 0.3) / 0.6))).toFixed(2) };
}

// What a profile does to her. Returns { feelings: {name: 0..1}, pressure: {calm, energy, edge}, word }.
// The mapping follows what's known about how sound affects people: slow tempo and low, soft, warm
// spectra settle the nervous system; fast tempo and bright, loud sound arouse it; sparse, dark,
// quiet sound pulls inward; loud, harsh (lots of 2 to 6 kHz), unsteady sound grates.
export function effect(p, { voice = false } = {}) {
  if (!p) return null;
  const warm = p.bands.bass + p.bands.lowMid, harsh = p.bands.highMid + p.bands.presence;
  const slow = p.bpm ? Math.max(0, Math.min(1, (110 - p.bpm) / 50)) : 0.5;
  const fast = p.bpm ? Math.max(0, Math.min(1, (p.bpm - 100) / 70)) : 0;
  const soft = 1 - p.loudness;
  const calm = Math.max(0, Math.min(1, (slow * 0.4 + soft * 0.35 + warm * 0.6 - harsh * 0.8 - p.brightness * 0.3)));
  const energy = Math.max(0, Math.min(1, fast * 0.5 + p.loudness * 0.4 + p.brightness * 0.35 + p.dynamics * 0.15 - slow * 0.2));
  const inward = Math.max(0, Math.min(1, slow * 0.35 + soft * 0.3 + (1 - p.brightness) * 0.3 - warm * 0.2 - fast * 0.4));
  const edge = Math.max(0, Math.min(1, harsh * 1.2 + (p.loudness > 0.8 ? (p.loudness - 0.8) * 3 : 0) + (p.dynamics > 0.9 ? 0.2 : 0) - calm * 0.5));
  // Gentle pushes: music is allowed to move her more than a voice, which mostly carries words.
  const k = voice ? 0.18 : 0.35;
  const feelings = {};
  if (calm > 0.45) feelings.calm = calm * k;
  if (energy > 0.45) feelings.excited = energy * k;
  if (inward > 0.5) feelings.pensive = inward * k * 0.8;
  if (inward > 0.65 && soft > 0.6) feelings.sad = (inward - 0.5) * k;
  if (edge > 0.4) feelings.annoyed = edge * k * 0.9;
  if (p.bpm >= 118 && p.loudness > 0.35 && !voice) feelings.playful = Math.min(0.3, fast * k);
  // Bright or heavy, from its key: clear major lifts, clear minor weighs, a dark sound tips it heavier. Only music
  // with a clear tonal centre moves it much; a voice, which has none to speak of, barely does.
  const tonal = voice ? 0 : (p.clarity ?? 0);
  const valence = Math.max(-1, Math.min(1, tonal * ((p.mode === 'major' ? 0.7 : p.mode === 'minor' ? -0.6 : 0) + (p.brightness - 0.35) * 0.4) - edge * 0.3));
  if (valence > 0.25) feelings.joy = valence * k;
  if (valence < -0.25 && !feelings.sad) feelings.pensive = Math.max(feelings.pensive ?? 0, -valence * k * 0.8);
  const word = edge > 0.55 ? 'harsh' : energy > 0.6 ? 'energetic' : calm > 0.6 ? 'calming' : inward > 0.6 ? 'melancholy' : valence > 0.3 ? 'uplifting' : valence < -0.3 ? 'heavy' : 'neutral';
  return { feelings, pressure: { calm, energy, edge, valence: +valence.toFixed(2) }, word, bpm: p.bpm, loudness: +p.loudness.toFixed(2), brightness: +p.brightness.toFixed(2), key: p.key && tonal > 0.3 ? `${p.key} ${p.mode}` : null };
}

// For a log line or her prompt: "calming (72 bpm, soft, warm)".
export function describe(p, e) {
  if (!p || !e) return '';
  const traits = [p.bpm ? `${p.bpm} bpm` : 'no steady beat', p.loudness > 0.7 ? 'loud' : p.loudness < 0.3 ? 'soft' : 'medium', p.brightness > 0.6 ? 'bright' : p.brightness < 0.3 ? 'dark' : 'warm', ...(e.key ? [e.key] : [])];
  return `${e.word} (${traits.join(', ')})`;
}

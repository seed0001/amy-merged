import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import prism from 'prism-media';

// One voice connection plays one stream, so her voice and the music are mixed here into a single one
// (Owner, 2026-11-10: the music has to keep playing behind her voice the whole time; switching the connection
// between a speech player and a music player cut the music every time she spoke and garbled her audio after).
// Everything is 48 kHz stereo 16-bit PCM, handed out 20 ms at a time as the connection's player asks for it.
// While she talks the music dips under her voice and comes back up after, smoothly. When nothing is playing the
// stream ends, so she isn't shown as talking to a silent room.

export const FRAME = 3840;              // 20 ms of 48 kHz stereo s16le
const AHEAD_MAX = 48000 * 4 * 6;        // music decoded ahead of what's playing, at most (6 s)
const AHEAD_MIN = 48000 * 4 * 2;
const DUCK = 0.35;                      // the music's level under her voice
// The music's level while someone else in the call is talking: well under them, so they can be heard and their mic
// isn't swamped (owner, 2026-11-11: "My mic would not pick up because of how loud he was playing"; a phone on
// speaker cuts its own mic when the call's sound is loud). It holds for HEARD_HOLD_MS after their last voiced sound.
const DUCK_FOR_OTHERS = 0.12;
const HEARD_HOLD_MS = 1500;

// ffmpeg -> 48 kHz stereo s16le, from a file path or a stream (a radio station).
export function decodeMusic(input) {
  const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', ...(typeof input === 'string' ? ['-i', input] : ['-i', 'pipe:0']), '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { windowsHide: true, stdio: [typeof input === 'string' ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (typeof input !== 'string') { input.pipe(ff.stdin); ff.stdin.on('error', () => {}); }
  ff.stderr.on('data', () => {});
  ff.stdout.kill = () => { try { ff.kill(); } catch {} };
  ff.on('error', (err) => ff.stdout.destroy(new Error(err.code === 'ENOENT' ? "ffmpeg isn't installed, so music can't play" : err.message)));
  return ff.stdout;
}
// Her speech (Fish Audio's Ogg Opus) -> 48 kHz stereo s16le, all of it (a sentence is short).
export function decodeSpeech(clip) {
  return new Promise((resolve, reject) => {
    const out = [];
    const demux = new prism.opus.OggDemuxer();
    const dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    demux.on('error', reject); dec.on('error', reject);
    dec.on('data', (b) => out.push(b));
    dec.on('end', () => resolve(Buffer.concat(out)));
    Readable.from([clip]).pipe(demux).pipe(dec);
  });
}

export class Mixer extends EventEmitter {
  constructor({ music = decodeMusic, speech = decodeSpeech } = {}) {
    super();
    this.decode = { music, speech };
    this.voice = [];       // { pcm, at, started, ended, ready } in order
    this.track = null;     // { source, chunks, bytes, ended, paused, playedBytes, volume }
    this.volume = 0.6;
    this.gain = 1;         // the music's level right now, gliding to DUCK while he talks
    this.othersUntil = 0;  // someone else in the call is talking (voiced sound) until this time: the music sits under them
  }
  // Someone else in the call made a voiced sound just now (voice/session.js listen).
  othersTalking(now = Date.now()) { this.othersUntil = now + HEARD_HOLD_MS; }

  // ---- her voice ----
  get speaking() { return this.voice.length > 0; }
  // Queues a sentence. Returns { started, ended } promises: started when its first sound goes out, ended after the last.
  say(clip) {
    const v = { pcm: null, at: 0, failed: null };
    v.started = new Promise((r) => { v.onStart = r; });
    v.ended = new Promise((r) => { v.onEnd = r; });
    v.ready = this.decode.speech(clip).then((pcm) => { v.pcm = pcm; }).catch((err) => { v.failed = err; this.voice = this.voice.filter((x) => x !== v); v.onEnd(); this.emit('idle-check'); throw err; });
    v.ready.catch(() => {});
    this.voice.push(v);
    this.emit('active');
    return v;
  }
  // She stops mid-word: everything she was going to say is dropped.
  stopSpeech() {
    for (const v of this.voice) v.onEnd?.();
    this.voice = [];
  }

  // ---- the music ----
  get musicOn() { return Boolean(this.track); }
  get musicPaused() { return Boolean(this.track?.paused); }
  get musicPlayedMs() { return this.track ? (this.track.playedBytes / FRAME) * 20 : 0; }
  playMusic(input) {
    this.stopMusic(true);
    const source = this.decode.music(input);
    const t = { source, chunks: [], bytes: 0, ended: false, paused: false, playedBytes: 0, input };
    source.on('data', (b) => { t.chunks.push(b); t.bytes += b.length; if (t.bytes > AHEAD_MAX) source.pause(); });
    source.on('end', () => { t.ended = true; });
    source.on('error', (err) => { t.ended = true; this.emit('music-error', err); });
    this.track = t;
    this.emit('music-start', input);
    this.emit('active');
  }
  pauseMusic() { if (!this.track || this.track.paused) return false; this.track.paused = true; this.emit('music-pause'); return true; }
  resumeMusic() { if (!this.track || !this.track.paused) return false; this.track.paused = false; this.emit('music-resume'); this.emit('active'); return true; }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, Number(v) || 0)); }
  stopMusic(quiet = false) {
    const t = this.track;
    if (!t) return;
    this.track = null;
    try { t.source.kill?.(); t.source.destroy?.(); } catch {}
    if (!quiet) this.emit('music-stop');
  }

  // Whether there's anything to send: her voice, or music that isn't paused.
  get active() { return this.voice.length > 0 || Boolean(this.track && !this.track.paused); }

  // The next 20 ms, both mixed; null once there's nothing left to play.
  frame() {
    if (!this.active) return null;
    const out = Buffer.alloc(FRAME);
    // Her voice, if the next sentence is decoded (until then, the music carries on alone).
    const v = this.voice[0];
    let talking = false;
    if (v?.pcm) {
      if (v.at === 0) v.onStart();
      talking = true;
      const n = Math.min(FRAME, v.pcm.length - v.at);
      v.pcm.copy(out, 0, v.at, v.at + n);
      v.at += n;
      if (v.at >= v.pcm.length) { this.voice.shift(); v.onEnd(); }
    }
    // The music under it, ducked while he talks, and further while anyone else does.
    const t = this.track;
    const target = Date.now() < this.othersUntil ? DUCK_FOR_OTHERS : talking || this.voice.length ? DUCK : 1;
    if (t && !t.paused) {
      const take = Math.min(FRAME, t.bytes);
      if (take > 0) {
        const m = this.pull(t, take);
        for (let i = 0; i + 1 < take; i += 2) {
          this.gain += (target - this.gain) * 0.0025; // about a quarter-second glide
          const s = out.readInt16LE(i) + m.readInt16LE(i) * this.volume * this.gain;
          out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i);
        }
        t.playedBytes += take;
      }
      if (t.source.isPaused?.() && t.bytes < AHEAD_MIN) t.source.resume();
      if (t.ended && t.bytes === 0) { this.track = null; this.emit('music-end', t.input); }
    } else this.gain += (target - this.gain) * 0.5;
    return out;
  }
  pull(t, n) {
    const parts = [];
    let need = n;
    while (need > 0 && t.chunks.length) {
      const c = t.chunks[0];
      if (c.length <= need) { parts.push(c); t.chunks.shift(); need -= c.length; }
      else { parts.push(c.subarray(0, need)); t.chunks[0] = c.subarray(need); need = 0; }
    }
    t.bytes -= n - need;
    return Buffer.concat(parts, n);
  }

  // A stream of the mix, for the connection's player. Ends when nothing's left to play.
  stream() {
    const self = this;
    return new Readable({ read() { const f = self.frame(); this.push(f); } });
  }
}

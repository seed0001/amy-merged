import { spawn } from 'node:child_process';
import { analyze, effect, describe } from './audio-sense.js';
import * as emotion from './emotion.js';
import * as pressure from './pressure.js';
import { emotionKey } from './characters.js';
import { activity } from './events.js';

// Sound reaching her feelings (audio-sense.js does the hearing). Three sources:
//  - a voice in the call: the PCM of each utterance, right after it's transcribed;
//  - a song she plays: read once with ffmpeg, measured in windows, each window's effect landing as
//    that part of the song plays (paced against the player's own clock: media sync, not a timer of hers);
//  - a station: a parallel ffmpeg decode of the stream, a short listen now and then while it plays.
// What it found is kept per conversation for her prompt ("the music is calming (72 bpm, soft, warm)").

const RATE = 16000;
const WINDOW_S = 15; // one effect per this much of a song
const STATION_LISTEN_S = 12, STATION_EVERY_S = 90;
const FRESH_MS = 10 * 60_000;

// ffmpeg -> 16 kHz mono s16le, for a file or a URL; `seconds` caps a live stream.
export function decodeWithFfmpeg(input, { seconds = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-nostdin', ...(seconds ? ['-t', String(seconds)] : []), '-i', input, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'];
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { windowsHide: true });
    const chunks = []; let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { err += c; });
    ff.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? "ffmpeg isn't installed, so sound can't be read" : e.message)));
    ff.on('close', (code) => (code === 0 || chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg couldn't read it: ${err.trim().slice(-200)}`))));
  });
}

export function createSoundSense({ decode = decodeWithFfmpeg, nudge = (f) => emotion.nudge(emotionKey('main'), f), push = (p) => pressure.onSound(p), log = activity, now = Date.now, schedule = setTimeout, song = null } = {}) {
  const latest = new Map(); // conversation -> { source, word, detail, speaker, at }
  const running = new Map(); // conversation -> { stop }
  // The song itself, beyond its sound (song-sense.js): its words, its shape, how each stretch hits her.
  const songs = () => song ?? songSenseRef;
  // What a stretch's words and meaning do to her, on top of its sound: her feelings (a little softer than the
  // model put them) and her pressure, through its brightness or weight (valence), without moving anything else.
  const landMeaning = ({ feelings, valence }) => {
    const soft = Object.fromEntries(Object.entries(feelings ?? {}).map(([k, v]) => [k, +(v * 0.6).toFixed(2)]));
    if (Object.keys(soft).length) nudge(soft);
    if (valence) push({ calm: 0, energy: 0.5, edge: 0, valence, source: 'song' });
  };
  // A stretch of music, as it plays: its words (if it has any) and how it hits her.
  const takeIn = (conversation, { words, profile, e, from = null, title = null }) => {
    const s = songs();
    if (!s) return;
    s.feel({ conversation, title: title ?? s.current(conversation)?.title ?? 'the music', from, words, sound: describe(profile, e), land: landMeaning, profile, effect: e }).catch(() => {});
  };

  function land(conversation, source, profile, { speaker = null } = {}) {
    const e = effect(profile, { voice: source === 'voice' });
    if (!e) return null;
    if (Object.keys(e.feelings).length) nudge(e.feelings);
    push({ ...e.pressure, source });
    const detail = describe(profile, e);
    latest.set(conversation, { source, word: e.word, detail, speaker, at: now() });
    log('sound', { conversation, source, ...(speaker && { speaker }), word: e.word, bpm: e.bpm, loudness: e.loudness, brightness: e.brightness, feelings: e.feelings });
    return e;
  }
  const later = (fn, ms) => { const t = schedule(fn, ms); t?.unref?.(); return t; };

  return {
    // A voice, apart from its words. 48 kHz mono PCM from the receiver.
    voice(pcm48k, { conversation, speaker }) {
      try {
        if (!pcm48k || pcm48k.length < 48000 * 2 * 0.8) return null; // under a second says little
        return land(conversation, 'voice', analyze(pcm48k, 48000), { speaker });
      } catch (err) { log('error', { where: 'sound sense (voice)', message: err.message }); return null; }
    },

    // Music someone else is playing in the call (a music bot): a stretch of it as it arrives, 48 kHz mono PCM.
    // It lands like a song she plays herself, with who it's coming from.
    music(pcm48k, { conversation, from }) {
      try {
        if (!pcm48k || pcm48k.length < 48000 * 2 * 3) return null;
        const profile = analyze(pcm48k, 48000);
        const e = land(conversation, 'music', profile, { speaker: from });
        // Its words, if it has any, and what this stretch means to her.
        const s = songs();
        if (e && s) { s.live(conversation, { from }); s.liveWords(pcm48k, 48000).then((words) => takeIn(conversation, { words, profile, e, from })).catch(() => {}); }
        return e;
      } catch (err) { log('error', { where: 'sound sense (music in the call)', message: `Couldn't take in the music from ${from}: ${err.message}. It plays on; she just doesn't feel this stretch.` }); return null; }
    },

    // A song: measured once, its effect landing window by window as it plays.
    async track(file, { conversation, resource }) {
      this.stop(conversation);
      let stopped = false;
      running.set(conversation, { file, stop: () => { stopped = true; } });
      try {
        const pcm = await decode(file);
        if (stopped) return;
        const perWindow = RATE * 2 * WINDOW_S;
        const windows = [];
        for (let at = 0; at + RATE * 2 * 3 <= pcm.length; at += perWindow) windows.push(analyze(pcm.subarray(at, Math.min(pcm.length, at + perWindow)), RATE));
        if (!windows.length) return;
        // The song beyond its sound: its lyrics (heard once and kept) and its shape, then each stretch's words and
        // meaning as it plays (song-sense.js). The sound lands straight away; the words follow once they're in.
        const s = songs();
        const ready = s ? s.start({ conversation, file, windows: windows.map((p) => p && { profile: p, effect: effect(p) }), windowSeconds: WINDOW_S, seconds: pcm.length / (RATE * 2) }).catch(() => null) : null;
        const hear = (k) => {
          const e = land(conversation, 'music', windows[k]);
          if (e && ready) ready.then(() => { if (!stopped) takeIn(conversation, { words: s.wordsBetween(conversation, k * WINDOW_S, (k + 1) * WINDOW_S), profile: windows[k], e }); });
        };
        hear(0);
        // The rest follow the player's clock: each lands when playback reaches its window.
        // When playback reaches the end of the song, she looks back on it (song-sense.js reflect).
        let i = 1;
        const total = pcm.length / (RATE * 2);
        const follow = () => {
          if (stopped) return;
          const played = (resource?.playbackDuration ?? 0) / 1000;
          while (i < windows.length && played >= i * WINDOW_S) { if (windows[i]) hear(i); i++; }
          if (i >= windows.length && played >= total - 1) {
            if (running.get(conversation)?.file === file) running.delete(conversation);
            if (s) s.finish(conversation);
            return;
          }
          const next = i < windows.length ? i * WINDOW_S : total;
          later(follow, Math.min(WINDOW_S * 1000, Math.max(500, (next - played) * 1000)));
        };
        follow();
      } catch (err) { log('error', { where: 'sound sense (track)', message: err.message }); }
    },

    // A station: listen for a few seconds now and again while it's on.
    async station(station, { conversation, playing }) {
      this.stop(conversation);
      let stopped = false;
      running.set(conversation, { stop: () => { stopped = true; } });
      const listen = async () => {
        if (stopped || !playing()) return;
        try {
          const pcm = await decode(station.url, { seconds: STATION_LISTEN_S });
          const profile = analyze(pcm, RATE);
          const e = land(conversation, 'music', profile, { speaker: station.name });
          const s = songs();
          if (e && s) { s.live(conversation, { from: station.name }); s.liveWords(pcm, RATE).then((words) => takeIn(conversation, { words, profile, e, from: station.name })).catch(() => {}); }
        } catch (err) { log('error', { where: 'sound sense (station)', message: err.message }); }
        if (stopped || !playing()) return;
        later(listen, STATION_EVERY_S * 1000);
      };
      await listen();
    },

    // The music stopped (ended, skipped, replaced, or turned off): she looks back on what she heard of it.
    stop(conversation) { const was = running.get(conversation); was?.stop(); running.delete(conversation); if (was) songs()?.finish(conversation); },
    // Music someone else was playing in the call stopped.
    musicEnded(conversation) { songs()?.finish(conversation); },

    latest(conversation) { return latest.get(conversation) ?? null; },

    // For her prompt: what the sound around her is doing, if anything recent.
    promptLine(conversation) {
      const l = latest.get(conversation);
      if (!l || now() - l.at > FRESH_MS) return '';
      if (l.source === 'voice') return `${l.speaker ?? 'Someone'}'s voice just now sounded ${l.detail}.`;
      const song = songs()?.promptLine(conversation) ?? '';
      return `The music playing${l.speaker ? ` (from ${l.speaker})` : ''} is ${l.detail}; let it get to you the way music does.${song ? ` ${song}` : ''}`;
    },
  };
}

// The song-sense module, once loaded (it isn't imported up top so this one stays light to load).
let songSenseRef = null;
import('./song-sense.js').then((m) => { songSenseRef = m.songSense; }).catch((err) => activity('error', { where: 'song sense', message: `Songs' words and meaning won't reach her: ${err.message}` }));

export const soundSense = createSoundSense();

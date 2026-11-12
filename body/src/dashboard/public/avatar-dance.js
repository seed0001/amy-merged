// Dancing and singing along to her music (server side: src/dance.js reads each song's beats,
// loudness and vocal line). No arms: she sways her hips and spine side to side every two beats, twists
// slowly every four, bobs and tilts her head on the beat, lifts her shoulders when the song gets big,
// closes her eyes now and then when she's lost in it, and her mouth sings along to the vocal line.
// Bigger when the song is loud, small in the quiet parts. Played entirely here, frame by frame.

const OFFSET_MS = Number(new URLSearchParams(location.search).get('danceOffset')) || 250; // Discord plays a little behind
const cache = new Map(); // track -> analysis (or a promise of it)

export function createDance({ fetchJson }) {
  let state = { state: 'stop', track: null, position: 0, at: 0 };
  let song = null;      // the analysis for the playing track
  let studioEl = null;  // in the studio the song plays right here: its own clock is exact
  let level = 0;        // how much she's dancing (0..1), eased in and out so it never snaps
  const smooth = { energy: 0, vocal: 0 };

  async function load(track) {
    if (!track) { song = null; return; }
    if (!cache.has(track)) cache.set(track, fetchJson(`/api/dance/${encodeURIComponent(track)}`).catch(() => null));
    const s = await cache.get(track);
    if (state.track === track) song = s;
  }

  // Where the song is right now, in ms, or null if nothing is playing.
  function position() {
    if (studioEl) return studioEl.paused || studioEl.ended ? null : studioEl.currentTime * 1000;
    if (state.state !== 'play') return null;
    return state.position + (Date.now() - state.at) - OFFSET_MS;
  }

  const at = (arr, ms, frameMs) => arr?.[Math.max(0, Math.min(arr.length - 1, Math.floor(ms / frameMs)))] ?? 0;
  function beatAt(ms) {
    const b = song.beats;
    let lo = 0, hi = b.length - 1;
    if (!b.length || ms < b[0]) return { index: 0, phase: 0 };
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid] <= ms) lo = mid; else hi = mid - 1; }
    const len = (b[lo + 1] ?? b[lo] + 60000 / song.bpm) - b[lo];
    return { index: lo, phase: Math.min(1, (ms - b[lo]) / len) };
  }

  return {
    // From her server: a song started, paused, resumed or stopped in voice.
    set(event) {
      if (studioEl) return; // the studio's own player wins while it's playing here
      const changed = event.track !== state.track;
      state = event;
      if (changed) load(event.track);
    },
    // In the studio: the song is playing on this page.
    studio(el, url) {
      const track = url ? decodeURIComponent(String(url).split('/').pop()) : null;
      studioEl = track ? el : null;
      state = { state: track ? 'play' : 'stop', track, position: 0, at: Date.now() };
      load(track);
    },
    active: () => level > 0.02,
    seed(track, analysis) { cache.set(track, Promise.resolve(analysis)); }, // for checking by eye
    debug: () => ({ track: state.track, loaded: Boolean(song), ms: song ? Math.round(position() ?? -1) : null, level: +level.toFixed(2), energy: +smooth.energy.toFixed(2), vocal: +smooth.vocal.toFixed(2), bpm: song?.bpm }),

    // One frame: adds her dance to the frame's motion (o: the frame's body offsets; add: a face shape).
    apply(c, o, add, dt, speaking) {
      const ms = song ? position() : null;
      const on = ms !== null && ms >= 0 && ms < (song?.durationMs ?? 0) && !speaking;
      level += ((on ? 1 : 0) - level) * Math.min(1, dt * (on ? 1.5 : 3));
      // A body with real dances baked in (dance_* clips: motion capture) dances those; avatar.js plays them
      // from these, and the sway below is only for bodies without any.
      c.danceLevel = song ? level : 0;
      if (level < 0.02 || !song) return;
      c.danceBpm = song.bpm;
      c.danceBeatSec = song.bpm ? 60 / song.bpm : 0.5;
      const e = at(song.energy, ms, song.frameMs), v = at(song.vocal, ms, song.frameMs);
      smooth.energy += (e - smooth.energy) * Math.min(1, dt * 6);
      smooth.vocal += (v - smooth.vocal) * Math.min(1, dt * 18);
      const { index, phase } = beatAt(ms);
      const amp = level * (0.35 + 0.75 * smooth.energy);
      const beat = index + phase;
      c.danceEnergy = smooth.energy;
      if (c.danceClips) { // the clip carries her body; only the face goes with the song below
        const lost = Math.max(0, smooth.energy - 0.75) * 2.5 * level;
        add(c, 'eyeBlinkLeft', 0.55 * lost); add(c, 'eyeBlinkRight', 0.55 * lost);
        return;
      }
      const sway = Math.sin(Math.PI * beat);            // side to side, every two beats
      const twist = Math.sin((Math.PI / 2) * beat);     // a slow twist, every four
      const pulse = Math.exp(-phase * 6);               // the hit of each beat, fading
      o.hipRoll += 3.5 * amp * sway;                    // her hips lead the sway
      o.spineRoll += 7 * amp * sway;
      o.spineYaw += 10 * amp * twist;
      o.roll += 6 * amp * sway;                         // her head goes with the sway
      o.neckPitch += 7 * amp * pulse;                   // a nod on the beat
      o.yaw += 5 * amp * twist;
      o.shoulders += 0.3 * amp * pulse * smooth.energy;
      if (index % 2) o.shoulderL += 0.25 * amp * pulse; else o.shoulderR += 0.25 * amp * pulse;
      o.breath += 1.2 * amp;
      // Lost in it: eyes drift shut in the big parts of the song.
      const lost = Math.max(0, smooth.energy - 0.75) * 2.5 * level;
      add(c, 'eyeBlinkLeft', 0.55 * lost); add(c, 'eyeBlinkRight', 0.55 * lost);
      // Singing along: the vocal line opens her mouth; the shape shifts as the syllables go by.
      const sing = level * Math.max(0, (smooth.vocal - 0.3) / 0.7);
      if (sing > 0.01) {
        const vowel = Math.sin(ms / 140) * 0.5 + 0.5;
        add(c, 'jawOpen', 0.45 * sing);
        add(c, 'mouthFunnel', 0.35 * sing * vowel);
        add(c, 'mouthStretchLeft', 0.18 * sing * (1 - vowel)); add(c, 'mouthStretchRight', 0.18 * sing * (1 - vowel));
        add(c, 'browInnerUp', 0.15 * sing * smooth.energy);
      }
    },
  };
}

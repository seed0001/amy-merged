import { bus, activity } from './events.js';
import { avatarPlay, avatarViewers } from './avatar-cues.js';
import { FIDGETS, BODY_MOTIONS, SEQUENCES } from './body-moves.js';

// Her body engine. No model call involved, and no clock of its own: every pressure tick (pressure.js)
// it plans the next stretch of time from her moods and hands the plan to her avatar page, which plays
// it on its own animation clock. Restless, she shifts her weight and rolls her shoulders; bored, she
// sighs and looks off; uneasy, she presses her lips and takes a breath; tired, she yawns. The buckets
// decide how often each move comes and how long it plays (a bored stretch is slow), and strong moods
// now and then play a whole sequence. The page skips anything due while she's talking, dancing or asleep.

const SLOT_MS = 3000;       // the plan's resolution: at most one move per slot
const MIN_GAP_MS = 5000;    // never two moves on top of each other
const COOLDOWN_MS = 25_000; // the same move doesn't repeat right away

// Each move: base rate per minute, and which moods raise it (weight per bucket). "tired" is her
// sleepiness (0-1), from sleep.js.
const MOVES = {
  settle: { base: 0.8, drivers: { restlessness: 1.5, unease: 0.5 } },
  deep_breath: { base: 0.5, drivers: { unease: 1.5, irritation: 1, tired: 0.5 } },
  neck_stretch: { base: 0.35, drivers: { restlessness: 1.2, boredom: 1, tired: 0.8 } },
  neck_roll: { base: 0.2, drivers: { restlessness: 1, tired: 1 } },
  shoulder_roll: { base: 0.35, drivers: { restlessness: 1.5, irritation: 0.8 } },
  look_away: { base: 0.9, drivers: { boredom: 1.5, curiosity: 1, unease: 0.8 } },
  head_tilt: { base: 0.6, drivers: { curiosity: 2, wonder: 1 } },
  lip_press: { base: 0.25, drivers: { unease: 1.8, irritation: 1.2 } },
  chin_up: { base: 0.15, drivers: { irritation: 2 } },
  sigh: { base: 0.25, drivers: { boredom: 1.5, irritation: 1, tired: 0.8 } },
  eyeroll: { base: 0.05, drivers: { irritation: 2.5 } },
  yawn: { base: 0.04, drivers: { tired: 4, boredom: 1 } },
  stretch: { base: 0.03, drivers: { restlessness: 1.5, tired: 1.5, boredom: 1 } },
};
// Strong moods play a whole sequence now and then.
const MOOD_SEQUENCES = { restlessness: 'restless', boredom: 'bored', unease: 'uneasy', irritation: 'tense', curiosity: 'curious', tired: 'stretch_out' };
const DEFAULT_MS = { settle: 3000, deep_breath: 2800, neck_stretch: 3400, neck_roll: 3600, shoulder_roll: 2600, look_away: 2600, head_tilt: 2400, lip_press: 1300, chin_up: 2200, sigh: 1800, eyeroll: 1200, nod: 1500, yawn: 4000, stretch: 4000 };

export function createBody({
  moods = () => ({}), tired = () => 0, sleeping = () => false, watching = () => avatarViewers() > 0,
  emit = (items) => bus.emit('avatar-fidgets', { items, at: Date.now() }),
  random = Math.random, now = Date.now,
} = {}) {
  const lastPlayed = new Map(); // move or sequence -> when it was last planned to play
  let busyUntil = 0;            // the end of the last planned move
  let dancing = false;          // while she dances to a song (dance.js), the dance moves her
  bus.on('avatar-dance', (e) => { dancing = e?.state === 'play'; });

  // How long a move plays: slower and longer the stronger the mood driving it (0.8x to 1.6x).
  const lengthFor = (name, driver) => Math.round((DEFAULT_MS[name] ?? 2500) * (0.8 + 0.8 * Math.min(1, driver)));

  // A sequence (or one move) as plan items, starting at offset `at` ms.
  function stepsOf(name, driver, at) {
    const out = [];
    for (const step of SEQUENCES[name] ?? [name]) {
      out.push({ name: step, ms: lengthFor(step, driver), at: Math.round(at) });
      at += (DEFAULT_MS[step] ?? 3000) * 0.85;
    }
    return out;
  }

  return {
    // One pressure tick: plan the next `windowMs` of fidgets from her moods, and send it to her avatar.
    plan(windowMs = 60_000) {
      if (!watching() || sleeping() || dancing) return [];
      const lv = { ...moods(), tired: tired() };
      const start = now(), items = [];
      for (let slot = 0; slot < windowMs; slot += SLOT_MS) {
        const t = start + slot;
        if (t < busyUntil + MIN_GAP_MS) continue;
        // A strong mood, now and then, plays out as a whole sequence.
        const seq = Object.entries(MOOD_SEQUENCES).find(([bucket, s]) => (lv[bucket] ?? 0) > 0.65 && t - (lastPlayed.get(s) ?? 0) > 3 * 60_000 && random() < 0.08);
        if (seq) {
          const steps = stepsOf(seq[1], lv[seq[0]], slot);
          items.push(...steps);
          lastPlayed.set(seq[1], t);
          busyUntil = start + steps.at(-1).at + steps.at(-1).ms;
          continue;
        }
        const scored = Object.entries(MOVES).map(([name, m]) => {
          if (t - (lastPlayed.get(name) ?? -Infinity) < COOLDOWN_MS) return [name, 0, 0];
          const push = Object.entries(m.drivers).reduce((a, [b, w]) => a + (lv[b] ?? 0) * w, 0);
          const driver = Math.max(0, ...Object.keys(m.drivers).map((b) => lv[b] ?? 0));
          return [name, m.base * (1 + push), driver];
        });
        const total = scored.reduce((a, [, r]) => a + r, 0);
        if (random() > total * (SLOT_MS / 60_000)) continue; // nothing in this slot
        let pick = random() * total;
        for (const [name, rate, driver] of scored) {
          if ((pick -= rate) > 0) continue;
          const ms = lengthFor(name, driver);
          items.push({ name, ms, at: slot });
          lastPlayed.set(name, t);
          busyUntil = t + ms;
          break;
        }
      }
      if (items.length) emit(items);
      return items;
    },

    // A move or sequence she names herself ([[do: settle_in]]): sent to play now, even mid-sentence.
    perform(name, driver = 0.3) {
      const items = stepsOf(name, driver, 0).map((i) => ({ ...i, force: true }));
      emit(items);
      if (SEQUENCES[name]) activity('body', { sequence: name });
      return items;
    },
  };
}

export const KNOWN_MOVES = [...FIDGETS, ...BODY_MOTIONS, ...Object.keys(SEQUENCES)];
let shared;
export const body = (deps) => (shared ??= createBody(deps));

// Moves she names herself (a [[do: ...]] tag, or her face tool): a sequence or an arm move goes through
// the engine; anything else plays straight on her avatar.
export function playMoves(names = []) {
  for (const name of names) {
    if (SEQUENCES[name] || BODY_MOTIONS.includes(name)) body().perform(name);
    else avatarPlay([name]);
  }
}

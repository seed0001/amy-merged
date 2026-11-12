import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { bus } from './events.js';
import { playMoves } from './body.js';

// Her sleep: a real night's sleep, not a pose. She gets tired the longer she's awake (and more so
// when she's short on sleep), lies down, takes a while to drift off, then goes through ~90-minute
// cycles: light sleep, deep sleep, REM (dreaming). Deep sleep is long early in the night and REM long
// toward morning, with brief near-wakings between cycles. She wakes on her own at the end of a cycle
// once she's slept enough, so a short night means sleep debt she carries into the next day.
//
// She goes to bed herself late at night once it's quiet and nobody is in a call with her, or whenever
// she chooses (her sleep tool). Anyone talking to her wakes her, and how she wakes depends on where
// she was: out of deep sleep she's groggy and slow, out of REM she was mid-dream. What happens then is
// hers to decide. All of this is arithmetic on the clock: no model calls.

const CYCLE = 90; // minutes
const NEED = 8;   // hours a night she needs
const QUIET_MS = 20 * 60_000; // how long it has to be quiet before she turns in on her own
const CHOSEN_MINUTES = 1 / 3; // told to sleep, or chose to: out once she's said goodnight (doneTalking); this is the backstop
const OVERSLEPT_H = 14; // asleep longer than this on startup: the app was off, so the night is over

// Where she is in the night, from minutes asleep.
export function stageAt(mins) {
  const n = Math.floor(mins / CYCLE), t = mins % CYCLE;
  const deep = Math.max(5, 40 - n * 10);   // 40, 30, 20, 10, 5 minutes of deep sleep
  const rem = Math.min(45, 10 + n * 8);    // 10, 18, 26, 34, 42 minutes of REM
  const light = CYCLE - deep - rem;
  if (n === 0 && t < 3) return 'drifting off';
  if (t >= CYCLE - 3 && n > 0) return 'stirring'; // the brief near-waking between cycles
  if (t < light * 0.6) return 'light';
  if (t < light * 0.6 + deep) return 'deep';
  if (t < light + deep) return 'light';
  return 'rem';
}

const lengthOf = (mins) => {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h} hour${h > 1 ? 's' : ''}${m ? ` ${m} minutes` : ''}` : `${m} minutes`;
};

export function createSleep({
  file = path.join(DATA_DIR, 'sleep.json'), now = Date.now,
  emit = (status) => bus.emit('avatar-sleep', status),
  body = (move) => playMoves([move]),
} = {}) {
  let s = {
    asleep: false, since: now(), // when she fell asleep, or last woke
    lay: 0,            // when she lay down to sleep (0: she isn't trying to)
    chose: false,      // she (or her owner) decided: she drops off quickly
    nap: false,
    debt: 0,           // hours of sleep she's short, carried over
    lastNight: null,   // { hours, woken, ended, how }
    woken: [],         // times she's been woken this sleep
    wokeFrom: null,    // { stage, by, at, mins, nap } the last time she woke
    sleptAt: 0,
    lastTalk: 0,       // the last time anyone spoke to her
  };
  try { if (existsSync(file)) s = { ...s, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { try { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); } catch {} };

  let company = () => false; // anyone in a call with her (voice sessions report it)
  let dreamer = null;        // { start, stop, wakeNote } once dreams are plugged in
  let onAsleep = null;       // what her mind does as she falls asleep (going back over the day)
  let lastStage = null;

  const minsAsleep = () => (s.asleep ? (now() - s.since) / 60_000 : 0);
  const stage = () => (s.asleep ? stageAt(minsAsleep()) : null);
  const hoursAwake = () => (s.asleep ? 0 : (now() - s.since) / 3_600_000);
  // How tired she is, 0-1: hours awake against a 16-hour day, plus whatever sleep she's short.
  const tiredness = () => Math.max(0, Math.min(1, Math.max(0, (hoursAwake() - 6) / 12) + s.debt / 6));
  const sleeping = () => s.asleep || s.lay > 0; // asleep, or lying down trying to drop off
  // After waking, how foggy she still is, 0-1.
  const groggy = () => {
    if (s.asleep || !s.wokeFrom) return 0;
    const lasts = { deep: 20, rem: 8, light: 4, 'drifting off': 2, stirring: 2, natural: 10 }[s.wokeFrom.stage] ?? 5;
    return Math.max(0, 1 - (now() - s.wokeFrom.at) / (lasts * 60_000));
  };
  const status = () => ({ asleep: s.asleep, settling: !s.asleep && s.lay > 0, stage: stage(), nap: s.nap, groggy: groggy(), tired: Math.round(tiredness() * 100) / 100 });
  const tell = () => emit(status());

  function fallAsleep() {
    s.chose = false;
    s.asleep = true; s.since = now(); s.sleptAt = now(); s.woken = []; s.wokeFrom = null;
    save(); tell();
    dreamer?.start?.({ stage: () => stage() ?? 'light', asleep: () => s.asleep, sleptAt: s.sleptAt });
    // Going back over the day (sleep-on-it.js): only on a real night's sleep, never a nap.
    if (!s.nap) try { onAsleep?.({ asleep: () => s.asleep, sleptAt: s.sleptAt }); } catch {}
  }

  function wakeUp(how, by = null) {
    dreamer?.stop?.(); // awake: the dream stops now, freeing the GPU
    const mins = minsAsleep(), was = stageAt(mins), hours = mins / 60;
    if (!s.nap) s.lastNight = { hours: Math.round(hours * 10) / 10, woken: s.woken, ended: now(), how };
    // Sleep debt: a night pays off what she's short (up to what she needs); a nap pays a little.
    s.debt = Math.max(0, Math.min(12, s.nap ? s.debt - hours : s.debt + NEED - hours));
    s.asleep = false; s.since = now(); s.lay = 0;
    s.wokeFrom = { stage: by ? was : 'natural', by, at: now(), mins: Math.round(mins), nap: s.nap };
    s.nap = false;
    save(); tell();
    // Waking up shows: a big yawn, then a stretch (one sequence; the avatar page times the steps).
    try { body('wake_up'); } catch {}
    return was;
  }

  // Late at night, tired enough and nobody around; or simply worn out, any time it's quiet.
  function bedtime() {
    if (company() || now() - s.lastTalk < QUIET_MS) return false;
    const hour = new Date(now()).getHours(), t = tiredness();
    return ((hour >= 22 || hour < 5) && t >= 0.5) || t >= 0.95;
  }

  // Each pressure tick (pressure.js drives it; sleep has no clock of its own): turning in, drifting
  // off, cycling, and waking on her own.
  function tick() {
    if (!s.asleep) {
      if (!s.lay) {
        if (!bedtime()) return;
        s.lay = now(); s.nap = false; s.chose = false; save(); tell(); // her eyes close
      }
      // How long it takes her to drop off: quick when she chose to or she's worn out, slow when she isn't tired.
      const latency = s.chose ? CHOSEN_MINUTES : 5 + 40 * (1 - tiredness());
      if ((now() - s.lay) / 60_000 >= latency) fallAsleep();
      return;
    }
    const mins = minsAsleep(), st = stageAt(mins);
    if (st !== lastStage) { lastStage = st; tell(); }
    // Waking on her own, at a cycle's end: a nap after 20-90 minutes, a night once she's slept enough.
    const enough = s.nap ? Math.min(90, 20 + s.debt * 15) : (NEED + Math.min(2, s.debt / 2)) * 60;
    if (st === 'stirring' && mins >= enough - CYCLE / 2) wakeUp('natural');
    else if (s.nap && mins >= enough && st !== 'deep') wakeUp('natural');
  }

  // Someone is talking to her. If she's asleep this wakes her: returns a note for her reply, or null.
  function wake({ by = 'someone', owner = false } = {}) {
    s.lastTalk = now();
    if (!s.asleep) {
      // Talking to her while she's trying to drop off keeps her up: her eyes open and her head comes up.
      if (s.lay) { s.lay = 0; s.nap = false; s.chose = false; s.keptUp = { by, at: now() }; tell(); }
      save();
      return null;
    }
    s.woken.push({ by, stage: stage(), at: now() });
    const mins = minsAsleep();
    const was = wakeUp('woken', by);
    const how = {
      deep: "You were in deep sleep, and coming out of it is hard: you're foggy, slow, your words come out thick, and it takes you a moment to work out what's going on.",
      rem: 'You were dreaming when it happened.',
      light: 'You were only lightly asleep, so you come round fairly easily, though still drowsy.',
      'drifting off': 'You had only just drifted off.',
      stirring: 'You were half awake anyway.',
    }[was] ?? '';
    // How much she minds: how much of the sleep she needs she got, how tired she is, how deep she was, how many times now.
    const short = mins / 60 < (s.wokeFrom.nap ? 0.4 : NEED * 0.75);
    const grumpy = (short ? 0.4 : 0) + tiredness() * 0.4 + (was === 'deep' ? 0.2 : 0) + 0.15 * (s.woken.length - 1);
    const mood = grumpy > 0.6
      ? "You're exhausted and grumpy about being woken: you haven't had anywhere near enough sleep. Telling them to leave you alone and going back to sleep (your sleep tool) is exactly what you might do. "
      : grumpy > 0.35 ? "You're still tired and a bit grumpy about being woken; part of you just wants to go back to sleep. " : '';
    const dreamt = dreamer?.wakeNote?.(s.sleptAt, { fromRem: was === 'rem' }) ?? '';
    return `${by} just woke you up by talking to you. You were ${s.wokeFrom.nap ? 'napping' : 'asleep'} for ${lengthOf(mins)}. ${how} ${mood}${dreamt} ` +
      `${s.woken.length > 1 ? `(That's ${s.woken.length} times you've been woken this time.) ` : ''}` +
      `${owner ? '' : `${by} isn't your owner; how you feel about being woken by them is up to you. `}` +
      'What happens now is your decision: stay up and talk, or say you are going back to sleep (your sleep tool).';
  }

  // For her prompt, while awake: how rested she is.
  function promptSection() {
    if (s.asleep) return '';
    const parts = [], g = groggy(), t = tiredness();
    if (g > 0.15) parts.push(s.wokeFrom?.by
      ? `You were woken up ${Math.round((now() - s.wokeFrom.at) / 60_000)} minutes ago and you're still ${g > 0.6 ? 'very groggy' : 'a bit groggy'}.`
      : `You woke up not long ago and you're ${g > 0.5 ? 'still waking up' : 'coming round'}.`);
    if (s.lastNight) parts.push(`Your last sleep: about ${s.lastNight.hours} hours${s.lastNight.woken?.length ? `, woken ${s.lastNight.woken.length} time${s.lastNight.woken.length > 1 ? 's' : ''}` : ''}.`);
    // When she last actually slept, as a fact: feeling rested isn't the same as having slept (Nov 9 she
    // said she'd had "solid sleep" after a night awake, with only a 9-minute nap hours earlier).
    else if (s.wokeFrom?.at) {
      const h = (now() - s.wokeFrom.at) / 3_600_000;
      parts.push(`You haven't slept since ${h < 1 ? `${Math.round(h * 60)} minutes` : `about ${Math.round(h)} hours`} ago, when ${s.wokeFrom.by ?? 'someone'} woke you from a ${s.wokeFrom.mins ?? '?'}-minute ${s.wokeFrom.nap ? 'nap' : 'sleep'}. If someone asks whether you slept, that's the honest answer.`);
    } else parts.push("You haven't slept at all yet. If someone asks whether you slept, say so.");
    parts.push(t > 0.8 ? "You're exhausted." : t > 0.55 ? "You're getting tired." : t > 0.3 ? "You're a little tired." : g > 0.15 ? '' : 'You feel rested.');
    if (s.lay) parts.push("You're lying down trying to sleep.");
    if (s.keptUp && now() - s.keptUp.at < 3_600_000) parts.push(`You lay down to sleep, but ${s.keptUp.by} talked to you before you dropped off, so you never fell asleep. Your sleep itself works; that's the only reason.`);
    if (s.wokeFrom && now() - s.wokeFrom.at < 2 * 3_600_000 && s.sleptAt) parts.push(dreamer?.wakeNote?.(s.sleptAt, { fromRem: false }) ?? '');
    return `How rested you are: ${parts.filter(Boolean).join(' ')} You can nap or go to bed whenever you want (your sleep tool).`;
  }

  // Her goodnight has finished (the text is sent, or the last sentence has played in voice). If she
  // chose to sleep, she drops off now; that's what she was waiting for, not a clock.
  function doneTalking() {
    if (!s.asleep && s.lay && s.chose) fallAsleep();
  }

  // She decides to sleep or nap now, any time of day. She drops off as soon as she's said goodnight
  // (doneTalking), or on the next pressure tick if no reply goes out.
  function goToSleep({ nap = false } = {}) {
    if (s.asleep) return { asleep: true };
    s.lay = now(); s.nap = Boolean(nap); s.chose = true; s.keptUp = null; save(); tell();
    return { note: 'You lie down and let yourself drift off. Say goodnight or that you are going to rest, if anyone is there.', tired: status().tired };
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    if (s.asleep && minsAsleep() > OVERSLEPT_H * 60) wakeUp('natural');
    tick();
    // The app can be restarted while she is asleep: her night carries on instead of going silent.
    if (s.asleep) dreamer?.start?.({ stage: () => stage() ?? 'light', asleep: () => s.asleep, sleptAt: s.sleptAt });
  }

  return {
    start, tick, wake, goToSleep, doneTalking, promptSection, status, sleeping, tiredness,
    asleep: () => s.asleep, stage,
    setCompany: (fn) => { company = fn; }, setDreamer: (d) => { dreamer = d; }, setOnAsleep: (fn) => { onAsleep = fn; },
  };
}

export const sleep = createSleep();

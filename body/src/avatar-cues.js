import { bus } from './events.js';

// Moments in her thinking, sent to the avatar so her head, eyes and face move because something is
// actually going on in her mind, not on a timer:
//   listening  someone is talking to her
//   thinking   she's working something out
//   recalling  she's searching her memory
//   searching  she's looking something up or reading
//   realized   something just came together: an answer, a finding
// These fire from what she is really doing (a memory search, a tool call), never from what the words
// happen to say.
export const CUES = ['listening', 'thinking', 'recalling', 'searching', 'realized'];

export function avatarCue(kind, { character = 'main', strength = 1 } = {}) {
  if (!CUES.includes(kind)) return;
  bus.emit('avatar-cue', { character, kind, strength: Math.max(0, Math.min(1, strength)), at: Date.now() });
}

// A tool call on her screen: a bubble that floats up the avatar page while she's using it. phase is
// start (the call began) or end (ok says whether it worked).
export function avatarToolCall(event) {
  bus.emit('avatar-tool', { at: Date.now(), ...event });
}

// Plays what her own [[do: ...]] tags asked for on her avatar, for replies that don't go through the
// studio (Discord voice and text).
// gestures: names, or { name, ms } to set how long this one plays (the body engine stretches moves with her mood).
export function avatarPlay(gestures = [], character = 'main') {
  for (const g of gestures) bus.emit('avatar-play', { character, ...(typeof g === 'string' ? { name: g } : g), at: Date.now() });
}

// Her avatar sleeps while she's offline and wakes when she's back on Discord. Told outright, because a
// restart here is over in seconds, faster than an open page would notice the connection drop.
let online = false;
export const avatarOnline = () => online;
export function avatarPower(on) {
  online = Boolean(on);
  bus.emit('avatar-power', { online, at: Date.now() });
}

// How many avatar pages are open right now (the dashboard keeps this count).
let viewers = 0;
export const avatarViewers = () => viewers;
export const avatarViewerJoined = () => { viewers++; };
export const avatarViewerLeft = () => { viewers = Math.max(0, viewers - 1); };

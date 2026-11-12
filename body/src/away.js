import { activity } from './events.js';

// Who has stepped away from a conversation. Since 2026-11-11 (owner: "I didn't say I was leaving the call") that is
// only someone who deafened themselves in the call: they can't hear her. Nothing anyone says marks them away, and a
// muted person is still listening. From deafening until they undeafen or speak, their silence isn't them
// ignoring her. Her prompt says who's away and for how long, and her pressure system (pressure.js)
// doesn't speak to them, follow up with them, check in on them or count their silence as a snub.
//
// Nothing here reads the words people say. What a line means ("brb", "I'm just gonna sit here with
// you") is understood by her hands model, which calls the presence_note tool (tools.js) and that
// calls note() below. Discord mute/deafen events (bot.js) call markAway/markBack directly. The only
// thing heard() does with a line is treat it as an event: the person spoke, so they're not away any
// more, and if they'd asked for quiet time, speaking again ends it.
//
// conversation -> Map(userId -> { name, since, how })

const rooms = new Map();

// Quiet time together: "I'm just gonna sit here with you", "let's have some quiet time". Not stepping
// away and not ignoring her: being together without talking. It lasts until the person who asked for
// it says something else (or two hours). While it's on she doesn't fill the silence, speak up, check
// in, or count the quiet against anyone.
const QUIET_MAX_MS = 2 * 3600_000;
const quiet = new Map(); // conversation -> { by, name, since, renewed }
// The quiet time that speaking just ended, so a presence_note quiet_time call for that same line
// (the hands run after heard()) picks it back up with its original start instead of a new one.
const quietJustEnded = new Map(); // conversation -> { by, since }

export function markQuietTime(conversation, { id, name }, now = Date.now()) {
  const was = quiet.get(conversation);
  const resumed = !was && quietJustEnded.get(conversation)?.by === id ? quietJustEnded.get(conversation) : null;
  quietJustEnded.delete(conversation);
  quiet.set(conversation, { by: id, name, since: was?.since ?? resumed?.since ?? now, renewed: now });
  if (!was && !resumed) activity('quiet-time', { conversation, with: name });
}
export function endQuietTime(conversation, now = Date.now(), { bySpeaking = false } = {}) {
  const was = quiet.get(conversation);
  if (!was) return;
  quiet.delete(conversation);
  if (bySpeaking) quietJustEnded.set(conversation, { by: was.by, since: was.since }); else quietJustEnded.delete(conversation);
  activity('quiet-time', { conversation, with: was.name, ended: true, minutes: Math.round((now - was.since) / 60_000) });
}
export function quietTime(conversation, now = Date.now()) {
  const q = quiet.get(conversation);
  if (q && now - q.renewed > QUIET_MAX_MS) { endQuietTime(conversation, now); return null; }
  return q ?? null;
}

const room = (conversation) => { let r = rooms.get(conversation); if (!r) { r = new Map(); rooms.set(conversation, r); } return r; };

export function markAway(conversation, { id, name }, how = 'said so', now = Date.now()) {
  const r = room(conversation);
  if (r.has(id)) { r.get(id).how = how; return r.get(id); }
  const entry = { name, since: now, how };
  r.set(id, entry);
  activity('away', { conversation, who: name, how });
  return entry;
}

// Back: returns how long they were gone (ms), or null if they weren't away.
export function markBack(conversation, id, now = Date.now()) {
  const r = rooms.get(conversation);
  const was = r?.get(id);
  if (!was) return null;
  r.delete(id);
  const gone = now - was.since;
  activity('away', { conversation, who: was.name, back: true, minutes: Math.round(gone / 60_000) });
  return gone;
}

export const isAway = (conversation, id) => Boolean(rooms.get(conversation)?.has(id));
// Deafened: the only kind of away where they can't hear the call. Said-so and muted people can still hear her.
export const deafened = (conversation, id) => rooms.get(conversation)?.get(id)?.how === 'deafened';
export const away = (conversation) => [...(rooms.get(conversation)?.entries() ?? [])].map(([id, e]) => ({ id, ...e }));
export const awayIds = (conversation) => new Set(rooms.get(conversation)?.keys() ?? []);

// Someone said something: an event, not words to read. If they were away, they're back (whatever
// they said); if they'd asked for quiet time, talking again ends it. What the line itself means is
// for her hands: presence_note -> note(). Returns 'back' | null, so the caller can log what happened.
export function heard(conversation, { id, name }, _text, now = Date.now()) {
  const qt = quietTime(conversation, now);
  if (qt && qt.by === id) endQuietTime(conversation, now, { bySpeaking: true });
  if (!isAway(conversation, id)) return null;
  const gone = markBack(conversation, id, now);
  room(conversation); // keep the room around
  returned.set(`${conversation}|${id}`, { name, gone, at: now, announced: false });
  return 'back';
}

// What a person meant, as her hands understood it (the presence_note tool). Returns a plain-language
// result for the tool, starting with "Error:" when nothing could be done and why.
export const PRESENCE_ACTIONS = ['quiet_time', 'talking_again'];
export function note(conversation, { id, name }, action, now = Date.now()) {
  if (!conversation) return 'Error: there is no conversation to note presence in. Nothing was recorded.';
  if (!id) return `Error: presence_note needs to know who (${PRESENCE_ACTIONS.join(', ')} all belong to a person). Nothing was recorded.`;
  switch (action) {
    // Owner, 2026-11-11: nobody is marked away from what they say any more. Someone in the call is here; only
    // deafening (Discord tells us) makes them away. A call for the old actions says so instead of guessing.
    case 'stepping_away':
    case 'back':
      return `Error: nobody is marked away from what they say. ${name || 'They'} ${action === 'back' ? 'never left' : 'is still in the call and can hear you'}; only deafening or leaving the call counts, and Discord tells you that. Nothing was recorded.`;
    case 'quiet_time': {
      if (isAway(conversation, id)) markBack(conversation, id, now);
      returned.delete(`${conversation}|${id}`);
      const was = quietTime(conversation, now);
      markQuietTime(conversation, { id, name }, now);
      return was && was.by === id ? `Quiet time with ${name} goes on (${ago(now - was.since)} so far).`
        : `Quiet time with ${name}: sitting together without talking. You won't fill the silence, speak up, check in or count the quiet against anyone until they talk again (or say so with talking_again), or after two hours.`;
    }
    case 'talking_again': {
      const qt = quietTime(conversation, now);
      if (!qt) return 'There was no quiet time on, so nothing changed.';
      endQuietTime(conversation, now);
      return `Quiet time with ${qt.name} is over after ${ago(now - qt.since)}; talking as usual.`;
    }
    default:
      return `Error: presence_note doesn't know the action ${action === undefined || action === '' ? 'none' : JSON.stringify(action)}. Use one of: ${PRESENCE_ACTIONS.join(', ')}. Nothing was recorded.`;
  }
}

// Who just came back (one prompt's worth): read once, then forgotten.
const returned = new Map();
export function justReturned(conversation, id) {
  const k = `${conversation}|${id}`;
  const r = returned.get(k);
  if (r) returned.delete(k);
  return r ?? null;
}

export function cleared(conversation) {
  rooms.delete(conversation);
  quiet.delete(conversation);
  quietJustEnded.delete(conversation);
  for (const k of [...returned.keys()]) if (k.startsWith(`${conversation}|`)) returned.delete(k);
}
export function left(conversation, id) { rooms.get(conversation)?.delete(id); }

const ago = (ms) => { const m = Math.round(ms / 60_000); return m < 1 ? 'less than a minute' : m === 1 ? 'a minute' : `${m} minutes`; };
const HOW = { 'said so': 'said they were stepping away', muted: 'went on mute', deafened: 'deafened themselves (they can\'t hear the call)' };

// For her prompt: who's away right now, and whether the person talking to her just got back.
export function promptSection(conversation, speakerId = null, now = Date.now()) {
  const lines = [];
  const qt = quietTime(conversation, now);
  if (qt) {
    lines.push(now - qt.renewed < 20_000 && qt.by === speakerId
      ? `${qt.name} just said they want some quiet time together: sitting here with you, not talking. That's a good thing, not a brush-off. Say something small and warm to settle in (a few words, no question), then let the quiet be.`
      : `Quiet time with ${qt.name} (${ago(now - qt.since)} so far): they asked to just sit here together without talking. The silence is the point. Don't fill it, don't ask if they're there, don't bring anything up, and don't read it as being ignored. If they say something, answer softly and briefly.`);
  }
  const back = speakerId ? justReturned(conversation, speakerId) : null;
  if (back) lines.push(`${back.name} just came back after being away about ${ago(back.gone)}${back.announced ? ' (they said so)' : ''}. Pick up where you two were, lightly; don't act as if the gap was them ignoring you.`);
  const gone = away(conversation).filter((p) => p.id !== speakerId || !back);
  for (const p of gone) {
    const fresh = now - p.since < 20_000;
    lines.push(fresh && p.id === speakerId
      ? `${p.name} is stepping away right now (they just said so). Acknowledge it in a few words at most, no question, and wait; they'll be back.`
      : `${p.name} is away (${HOW[p.how] ?? p.how}, about ${ago(now - p.since)} ago) and hasn't come back yet. Their silence isn't them ignoring you: don't follow up with them, ask them things or take it personally until they're back.`);
  }
  // How this is kept: understood, never pattern-matched. Her hands call presence_note; when her voice
  // holds the tools itself (hands off), this is the reminder to make that call.
  if (lines.length) lines.push('This is tracked with the presence_note tool (stepping_away, back, quiet_time, talking_again, with who): when someone says they are stepping out, back, want quiet time together or want to talk again, that call is what records it; nothing guesses it from their words.');
  return lines.join('\n');
}

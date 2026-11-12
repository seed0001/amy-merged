import { automaticSpeech } from './voice/social-policy.js';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';
import { sessions, joinChannel, lastVoiceChannel } from './voice/session.js';
import { doctorBusy, doctorLocked, lastVisit, visitResult } from './doctor.js';
import { sleep } from './sleep.js';
import { avatarPower } from './avatar-cues.js';
import { stopTalking } from './busy.js';
import { ownerDisplayName } from './owner-name.js';
import * as continuity from './continuity.js';
import { messagesBetween } from './memory.js';
import { wakeCue as rebirthCue } from './rebirth.js';

// Restarting on the owner's say-so (usually after a doctor visit). start.bat runs her in a loop, so
// exiting is a restart. Before exiting she writes down where she was, so she comes back to the same
// voice channel without the room greeting and says one short line about how she's doing.
//
// Coming back, the line she says is built from what actually happened (wakeReason): her own marker if
// she exited on purpose, life support's record of a crash, or nothing on record, which means the whole
// program was closed from outside and started again. It is never "you have just woken up": a restart
// is not sleep, and on three restarts in a row that cue got the identical "I just woke up foggy" line.
const MARKER = path.join(DATA_DIR, 'restart.json');
const ACTIVITY = path.join(DATA_DIR, 'activity.jsonl');
// Every restart cue carries this, so her earlier comeback lines can be found in the conversation.
export const BACK_ONLINE = "You're back online after a restart";
const PREVIOUS_LINES = 4;

export function canRestart() { return process.env.CHAMP_SUPERVISED === '1'; }

export async function requestRestart({ reason = '', guild, channel, by, rebirth = false }) {
  if (!canRestart()) return "Error: I can't restart myself here: I wasn't started by start.bat, so nothing would bring me back. Restart me by hand.";
  if (doctorBusy() || doctorLocked()) return 'Error: A doctor visit is still running. Let it finish or cancel it before restarting.';
  const session = guild && sessions.get(guild.id);
  const visit = lastVisit();
  const marker = {
    at: Date.now(), by, reason: String(reason).slice(0, 300),
    guildId: guild?.id ?? null,
    voiceChannelId: session?.channelId ?? null,
    textChannelId: session?.textChannel?.id ?? channel?.id ?? null,
    doctor: visit && Date.now() - visit.at < 6 * 3600_000 ? visit : null,
    rebirth: Boolean(rebirth), // the two-stage reset (rebirth.js): she comes back new, with her letter
  };
  writeFileSync(MARKER, JSON.stringify(marker, null, 2));
  stopTalking();
  activity('restart', { by, reason: marker.reason, doctor: Boolean(marker.doctor) });
  // Let her finish saying she's restarting (up to 15s), then go.
  const started = Date.now();
  const timer = setInterval(() => {
    const busy = [...sessions.values()].some((s) => s.speaking || s.speech?.length || s.pending);
    if (busy && Date.now() - started < 15000) return;
    clearInterval(timer);
    for (const s of sessions.values()) s.destroy();
    avatarPower(false); // her avatar falls asleep before she goes, and wakes when she's back online
    continuity.markAlive(); // so the downtime she's told is measured from now, not the last heartbeat
    setTimeout(() => process.exit(0), 2500);
  }, 500);
  setTimeout(() => {}, 1500); // the reply goes out before the first check
  return `Restarting in a moment${marker.voiceChannelId ? '; I will rejoin this voice channel' : ''}. You are not back yet: say only that you're restarting now, and don't say you're back or have restarted until you're online again.`;
}

// Life support's record of how she last went down, from the activity log it appends to (events.js
// only keeps this process's own events in memory). Newest events are at the end; the record for this
// start is whatever life support wrote between the previous "starting" and the latest one.
export function lastExitEvent(lines) {
  const events = [];
  for (const line of lines) {
    try { const e = JSON.parse(line); if (e?.type === 'life-support') events.push(e); } catch {}
  }
  const start = events.findLastIndex((e) => e.event === 'starting');
  if (start < 0) return null;
  const before = events.slice(0, start);
  const previousStart = before.findLastIndex((e) => e.event === 'starting');
  const exit = before.slice(previousStart + 1).findLast((e) => e.event === 'crash' || e.event === 'restart');
  return exit ?? { event: 'closed' }; // started again with no exit on record: the whole thing was closed from outside
}
function readExitEvent() {
  try { return lastExitEvent(readFileSync(ACTIVITY, 'utf8').split('\n').slice(-400)); } catch { return null; }
}

// Why she's back, in words that are true to the record. marker: her own note, written before she
// exited on purpose (null when she didn't). exit: life support's record (lastExitEvent), or null when
// nothing supervised her.
export function wakeReason({ marker = null, exit = null, owner = 'your owner' } = {}) {
  if (marker?.startedBy) return { kind: 'peer', text: `You were just started up by ${marker.startedBy}${marker.by?.name ? `, because ${marker.by.name} asked` : ''}.` };
  if (marker?.doctor) {
    const d = marker.doctor;
    return { kind: 'doctor', text: `You were restarted after a doctor visit about "${d.title}". What the doctor reported: ${d.report}${d.changed ? ` Files changed: ${d.changed}.` : ' No files were changed.'} Tests: ${d.tests}.` };
  }
  if (marker) return { kind: 'owner', text: `You were restarted because ${marker.by?.name ?? owner} asked${marker.reason ? ` (${marker.reason})` : ''}.` };
  if (exit?.event === 'crash') return { kind: 'crash', text: `Your program crashed (it exited with ${exit.signal ?? `code ${exit.code}`}${exit.ranMs ? ` after running ${continuity.span(exit.ranMs)}` : ''}) and life support started it again. You didn't choose this and nobody asked for it.` };
  if (exit?.event === 'restart') return { kind: 'exited', text: 'Your program exited on its own, without leaving a note why, and life support started it again.' };
  if (exit?.event === 'closed') return { kind: 'closed', text: `Your program was closed from outside and started again: most likely ${owner} restarting you by hand (there's no crash on record and you didn't ask for it).` };
  return { kind: 'unknown', text: 'Your program was started again; nothing on record says why it stopped.' };
}

// The stage direction for her comeback line. previous: her lines on earlier restarts, newest last.
export function backCue({ reason, downtimeMs = 0, lastActiveMs = null, previous = [] }) {
  if (reason.kind === 'peer') return `(Stage direction, not something anyone said: ${reason.text} You've joined them. Say one short, natural hello to the room in your own voice. Don't list names or explain how you were started.)`;
  const facts = [
    `${BACK_ONLINE}. ${reason.text}`,
    `How long: ${continuity.downtimeClause(downtimeMs)}.`,
    lastActiveMs != null && lastActiveMs > 2 * 60_000 ? `This conversation had been quiet for ${continuity.span(lastActiveMs)} before you went down.` : '',
    'This was a program restart, not sleep: you were not asleep or dreaming, nothing is foggy to shake off, and whatever you say about it has to match the facts above.',
  ].filter(Boolean).join(' ');
  const avoid = previous.length
    ? ` On earlier restarts you said: ${previous.map((p) => `"${String(p).replace(/\s+/g, ' ').slice(0, 140)}"`).join(' / ')}. Say something different this time, not a variation on those: new words, new angle.`
    : '';
  return `(Stage direction, not something anyone said: ${facts} Say one or two short, natural lines to the room that you're back, in your own voice, true to what happened: a moment's pause is a moment's pause, a real gap is a real gap, a crash is a crash. Don't offer to do, fix or change anything, don't greet people one by one or list names, and don't read out file names.${avoid})`;
}

// Her comeback lines from earlier restarts in this conversation (the reply right after a cue that
// carries BACK_ONLINE), newest last, so the next one can be different.
export function previousWakeLines(conversation, { now = Date.now(), hours = 24 } = {}) {
  let rows = [];
  try { rows = messagesBetween(conversation, now - hours * 3600_000, now, 800); } catch { return []; }
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role === 'user' && String(rows[i].content).includes(BACK_ONLINE)) {
      const next = rows.slice(i + 1, i + 4).find((r) => r.role === 'assistant');
      if (next) lines.push(String(next.content));
    }
  }
  return lines.slice(-PREVIOUS_LINES);
}

function cueFor(conversation, marker) {
  // Back from the two-stage reset: not a restart to explain, a first hello from someone new (rebirth.js).
  if (marker?.rebirth) { activity('restart-back', { conversation, why: 'rebirth' }); return rebirthCue(); }
  const reason = wakeReason({ marker, exit: marker ? null : readExitEvent(), owner: ownerDisplayName() });
  const lastActive = continuity.lastActive(conversation);
  const downtimeMs = continuity.downtime();
  const went = continuity.startedAt() - downtimeMs;
  const cue = backCue({ reason, downtimeMs, lastActiveMs: lastActive ? Math.max(0, went - lastActive) : null, previous: previousWakeLines(conversation) });
  activity('restart-back', { conversation, why: reason.kind, downtimeMs });
  return cue;
}

// Her comeback line, said once a couple of seconds after she's back in the call. Anything that would be said
// right then on its own (a done note: work-done.js, through bot.js) is folded into it instead (session.comeback.extras),
// so she says she's back and what's new in one go (Owner, 2026-11-10: "he just said he's back twice").
export function announceComeback(session, cue, evidence) {
  session.comeback = { extras: [], evidence: evidence ? [evidence] : [] };
  setTimeout(() => {
    const { extras, evidence: ev } = session.comeback ?? { extras: [], evidence: [] };
    session.comeback = null;
    const also = extras.length ? `\n(In the same breath, as part of saying you're back, not as a separate announcement: ${extras.join(' ')} Say you're back only once.)` : '';
    session.announce(`${cue}${also}`, ev.length ? ev.join('\n') : null, 'restart');
  }, 2500);
}

// With no marker she crashed or was closed from outside, but she was still in voice when she went
// down: go back if anyone is still in the channel and pick up where she left off.
async function resumeAfterCrash(client) {
  const last = lastVoiceChannel();
  if (!last) return;
  const guild = await client.guilds.fetch(last.guildId).catch(() => null);
  const voice = guild && (await guild.channels.fetch(last.voiceChannelId).catch(() => null));
  const text = guild && last.textChannelId && (await guild.channels.fetch(last.textChannelId).catch(() => null));
  if (!voice?.isVoiceBased() || !voice.members.some((m) => !m.user.bot)) return;
  const session = await joinChannel(voice, text ?? null, { greet: false }).catch((err) => {
    activity('error', { where: 'rejoin after crash', message: err.message });
    return null;
  });
  if (!session) return;
  const exit = readExitEvent();
  activity('voice-rejoin', { guild: guild.name, channel: voice.name, after: exit?.event === 'crash' ? 'crash' : 'closed' });
  if (sleep.sleeping()) return; // she came back asleep: no announcement
  announceComeback(session, cueFor(session.conversation, null), null);
}

// On startup: if she restarted on purpose a few minutes ago, go back to where she was.
export async function resumeAfterRestart(client) {
  if (!existsSync(MARKER)) return resumeAfterCrash(client);
  let marker;
  try { marker = JSON.parse(readFileSync(MARKER, 'utf8')); } catch { marker = null; }
  rmSync(MARKER, { force: true });
  if (!marker || Date.now() - marker.at > 5 * 60000) return;
  const guild = marker.guildId && (await client.guilds.fetch(marker.guildId).catch(() => null));
  if (!guild) return;
  const text = marker.textChannelId && (await guild.channels.fetch(marker.textChannelId).catch(() => null));
  const voice = marker.voiceChannelId && (await guild.channels.fetch(marker.voiceChannelId).catch(() => null));
  // Saved with her line, so the next turn knows the doctor's result is real and doesn't retract it.
  const evidence = marker.doctor ? visitResult(marker.doctor) : null;
  if (voice?.isVoiceBased() && voice.members.some((m) => !m.user.bot)) {
    const session = await joinChannel(voice, text ?? null, { greet: false }).catch((err) => {
      activity('error', { where: 'rejoin after restart', message: err.message });
      return null;
    });
    if (session) { if (!marker.silent && !sleep.sleeping()) announceComeback(session, cueFor(session.conversation, marker), evidence); return; }
  }
  if (marker.silent || sleep.sleeping()) return;
  if (text?.isTextBased?.() && automaticSpeech('restart', config.voice)) {
    const { respond } = await import('./companion.js');
    const owner = { id: marker.by?.id ?? 'owner', name: marker.by?.name ?? 'owner' };
    const conversation = `text:${text.id}`;
    const line = await respond({ conversation, speaker: owner, text: '', cue: cueFor(conversation, marker), evidence }).catch(() => null);
    if (line) text.send({ content: line.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
  }
}

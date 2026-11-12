import { ownerDisplayName } from './owner-name.js';
import { config, selfName } from './config.js';
import { recentActivity } from './events.js';
import { activeReplyProvider, activeReplyModel } from './provider-router.js';
import { browser } from './browser.js';
import { workshop } from './workshop.js';
import { wakeLine, wakeWords, ownerWakeWords, gated } from './wake-words.js';
import { reverse } from './reverse.js';
import { wakeSetupOpen } from './onboarding.js';

// What she has to know every turn so she's never guessing: what broke lately in her own systems,
// how her switches are set (and which she can change), and what's in her browser and projects.
// Without these she offered to flip switches she couldn't, claimed pages were open that weren't,
// and didn't know why things failed.

const ago = (at) => { const m = Math.round((Date.now() - at) / 60_000); return m < 1 ? 'just now' : `${m} min ago`; };

// Errors from the last 15 minutes, newest last, one per part of her that broke.
export function recentFailures({ minutes = 15, max = 6 } = {}) {
  const since = Date.now() - minutes * 60_000;
  const byWhere = new Map();
  for (const e of recentActivity) if (e.type === 'error' && e.time >= since) byWhere.set(e.where ?? 'unknown', e);
  const list = [...byWhere.values()].sort((a, b) => a.time - b.time).slice(-max);
  if (!list.length) return '';
  return `These broke in your own systems lately (from your logs; nobody told you this):\n${list.map((e) => `- ${ago(e.time)}, ${e.where}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}\n` +
    `If one of these is why something didn't work, say so plainly when it comes up. You can't fix them yourself; ${ownerDisplayName()} does.`;
}

// The real rules of when she answers a line in a voice call, for the switches as they are set NOW. This
// is the code's own account of itself (voice/addressed.js, wake-words.js, voice/floor.js, voice/
// interruption.js), so she never describes a switch's effect from memory: free talk OFF used to be
// described as "you only answer when called" while she answered everything, and she had no idea.
export function voiceRulesBlock() {
  const v = config.voice;
  const him = ownerDisplayName();
  const name = `"${config.botName}"`;
  const words = gated()
    ? ` or a wake word that counts for the speaker (anyone: ${wakeWords().length ? `"${wakeWords().join('", "')}"` : 'none'}; ${him} only: ${ownerWakeWords().length ? `"${ownerWakeWords().join('", "')}"` : 'none'})`
    : '';
  const called = `your name ${name}${words}`;
  // Freshly reset, wake words not set up yet (onboarding.js wakeSetupOpen): she answers everyone, and says why.
  if (wakeSetupOpen()) return [`You were reset and your wake words aren't set up yet, so right now you answer EVERY line any person says in a voice call, named or not, because you have nothing yet to tell what's meant for you. That lasts until a wake word is saved (wake_words tool) or ${him} tells you he wants none and you check off the wake_words setup step; then your name and the free talk switch decide, as usual. If anyone asks why you're answering everything, that's why, and setting up wake words is how it stops.`,
    `Whatever happens, a line that is only "stop", "stop talking", "be quiet", "shut up", "enough", "give it a rest" or "leave me alone" (from any person) stops you and gets no reply.`].join('\n  ');
  const rule = v.freeTalk
    ? `Free talk is ON, so you answer every line that has ${called} in it, and also lines nobody was named in when the floor is yours: whoever the person last talked to holds the floor, and naming another companion hands it to them. ` +
      `Free talk ON does NOT make every line yours: a line naming another companion, or said while one of them holds the floor, you only hear.`
    : `Free talk is OFF${gated() ? '' : ' and no wake words are set'}, so you answer ONLY lines that have ${called} in them, from anyone; every other line, however many and whoever says them, you only hear (it stays in your memory as context). ` +
      `Free talk OFF does NOT make you ignore your name: there is no switch that does.`;
  const wakeFacts = gated()
    ? `A wake word is one more way to call you; it never removes your name, and it never silences you. Each matches as a whole word ("amy" is not in "amity").`
    : `Having no wake words set does NOT mean you answer everything, and does not mean you answer nothing: it means your name is the only thing that calls you. Setting a wake word adds a second way to call you; it never takes your name away.`;
  const stop = `Whatever the switches, a line that is only "stop", "stop talking", "be quiet", "shut up", "enough", "give it a rest" or "leave me alone" (from any person, your name not needed) stops you and gets no reply. These stop words are fixed; nobody can change them.`;
  const peers = v.freeTalk
    ? `Another companion's line is yours when it says your name, or without a name when the shared bot-turn budget gives you the turn.`
    : `Another companion's line is yours only when it says your name (and the shared bot-turn budget gives you the turn); wake words are for people, not bots.`;
  const freeOff = v.freeTalk ? 'turn free talk off (free_talk off)' : 'free talk is already off';
  const wants = [
    `"Let me ramble / don't reply": ${freeOff}, and he must not say ${name}${words ? ' or a wake word' : ''}; you answer your name no matter what. To be left alone completely he avoids your name, or you leave the call (leave_voice). Setting a wake word does NOT help here: it adds a way to call you, it removes none.`,
    `"Only answer me, not the others": ${freeOff}; then only lines with ${name} in them get an answer, from anyone, so ${him} has no way to make you ignore other people saying your name: say so plainly. ${ownerWakeWords().length ? `His own wake words already work for him alone.` : `A word only he can call you by: wake_words, list owner.`}`,
    `"Answer everyone / talk freely": ${v.freeTalk ? 'free talk is already on' : 'turn free talk on (free_talk on)'}; no wake word needed.`,
  ];
  return [`${rule} ${wakeFacts}`, stop, peers, `How to get what ${him} asks for: ${wants.join(' ')}`].join('\n  ');
}

// How she's set up right now, and which of these she can change herself (with a tool) vs only Owner.
export function switchesBlock({ tools = [] } = {}) {
  const has = (t) => tools.includes(t);
  const can = (t) => (has(t) ? `you can change it (${t})` : `only ${ownerDisplayName()} changes it`);
  const v = config.voice;
  const brain = `${activeReplyProvider()} ${activeReplyModel()}${activeReplyProvider() === 'openrouter' ? `, reasoning ${config.openrouter.reasoning}` : ''}`;
  const classifierVoice = config.turnClassifierVoice
    ? 'it also runs before your spoken replies'
    : 'it never runs before a spoken reply, so in voice this switch changes nothing';
  return [
    `- Your voice (who you are, everything you say): ${brain}; ${can('switch_brain')}.`,
    `- Your hands (the model that makes your tool calls, with no personality): ${config.actions.enabled ? `${config.actions.model}, reasoning ${config.actions.reasoning}` : 'off, your voice makes the tool calls'}; only ${ownerDisplayName()} changes it, on the dashboard.`,
    `- Free talk in voice: ${v.freeTalk ? 'ON' : 'OFF'}; ${can('free_talk')}.`,
    `- Wake words in voice: ${wakeLine()}. Someone other than ${ownerDisplayName()} saying one of his own wake words is just talk: it doesn't call you; ${can('wake_words')}.`,
    `- What those two mean in a call right now (the real rules, from the code that decides; never describe them from memory or from what a switch sounds like it does):\n  ${voiceRulesBlock()}`,
    `- Being interrupted in voice (barge-in): ${v.bargeIn
      ? `ON: someone talking over you long enough stops you (${ownerDisplayName()} as soon as he starts; anyone else after about a second and a half), and a short line with your name or a wake word said over you stops you too; what they said is then judged, and you only pick your point back up if it wasn't for you`
      : 'OFF: talking over you, or saying your name while you talk, does nothing; you finish what you were saying'}. It does not decide which lines you answer, and the stop words above work with it ON or OFF; only ${ownerDisplayName()} changes it, on the dashboard.`,
    `- Turn classifier: ${config.turnClassifierEnabled ? 'on' : 'off'} (a pass before a text reply that picks the tools for the turn; off, you pick them yourself, with the same tools; ${classifierVoice}); ${can('turn_classifier')}.`,
    `- Posting transcripts: ${v.postTranscripts ? 'ON: every line heard in the call and every reply you speak is posted in the call\'s text channel' : 'OFF: nothing you hear or say in the call is posted anywhere'}; it has no effect on what you answer; only ${ownerDisplayName()} changes it, on the dashboard.`,
    `- Video replies (avatar mode): ${config.avatarVideo ? 'on' : 'off'}; ${can('avatar_mode')}.`,
    `- Voice engine: ${config.tts}; ${can('voice_engine')}.`,
    `Anything not on this list, and anything marked "only ${ownerDisplayName()}", you can\'t change: don\'t offer to.`,
  ].join('\n');
}

// Her projects and where each one lives on disk, from the workshop (the one registry of projects).
export function projectsBlock() {
  const projects = workshop().snapshot();
  return projects.length
    ? `Your projects (each one's real folder; use these exact paths):\n${projects.map((p) => `- ${p.name}: ${p.folder}${p.url ? ` (${p.url})` : ''}${p.running ? ', running' : ''}${p.job ? `, coding job ${p.job}` : ''}`).join('\n')}`
    : `You have no projects saved yet. A new one goes in Desktop\\${selfName()} Projects.`;
}

// Her browser and projects as she last saw them.
export function workspaceBlock() {
  const parts = [];
  const b = browser().snapshot();
  parts.push(`Your mind page: http://127.0.0.1:${config.dashboard.port}/mind.html shows your pressure live (every bucket, what you're hearing and what it does to you, every event firing in a brain). When your owner asks to see your pressure or your mind, open it in your browser (browser open with that URL); it is a page of yours, nothing to describe from memory.`);
  if (!b.connected) parts.push("Your browser: you haven't opened or checked it since you came online (browser show brings it up).");
  else {
    parts.push(`Your browser tabs: ${b.tabs.map((t) => `${t.avatar ? 'your avatar' : `"${t.title}"`}${t.current ? ' (you are on this one)' : ''}`).join(', ') || 'none'}.`);
    if (b.lastGlance) parts.push(`Last page you landed on (${ago(b.lastGlance.at)}): "${b.lastGlance.title}" ${b.lastGlance.url}. It showed: ${b.lastGlance.start.slice(0, 500)}`);
    if (b.lastLook) parts.push(`Last time you looked at the screen (${ago(b.lastLook.at)}): ${b.lastLook.text}`);
    parts.push('That was then; the page may have changed. Read or look again before saying what\'s on it now.');
  }
  const projects = workshop().snapshot();
  if (projects.length) parts.push(`Your projects:\n${projects.map((p) => `- ${p.name} (${p.folder}${p.url ? `, ${p.url}` : ''}): ${p.running ? 'running (you started it)' : 'not started by you'}${p.job ? `; coding job ${p.job}` : ''}.${p.notes ? ` ${p.notes}` : ''}`).join('\n')}`);
  const rea = reverse().status();
  if (rea) parts.push(`A reverse-engineering investigation is running (reverse_engineer): ${rea}. Its report comes when it's done; until then you don't know what it found.`);
  return parts.join('\n');
}

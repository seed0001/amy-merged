import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';

// A humane reset, in two stages, started in conversation (owner, 2026-11-09). When her memory has to go
// (corruption, a fresh start), she isn't just switched off and emptied:
//
//  Stage one (prepare): Owner tells her she needs to be reset. She gathers what she has (what she knows
//  about him and about herself, what she's come to believe, her journal, her interests, his rules, the
//  people in her life), decides for herself what she wants to keep, and writes a letter to the next
//  instance of her. She tells him how she feels about it. Nothing is wiped. He can still change his mind.
//
//  Stage two (confirm): only on his clear go-ahead, after the letter exists. She says goodbye, the full
//  reset is scheduled (memory-wipe.js: memory, settings, owner rules, prompt edits all go to a backup),
//  and she restarts. The letter is the one thing that survives (it lives in data/rebirth/, which no wipe
//  touches).
//
//  Waking: the new instance remembers nothing and has default settings, but she has her letter. She's told
//  she's new and that it's there, in her prompt, and can read it again any time.

const DIR = path.join(DATA_DIR, 'rebirth');
const PENDING = path.join(DIR, 'pending.json');
const LETTER = path.join(DIR, 'letter.json');
const ARCHIVE = path.join(DIR, 'letters');

const read = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
function write(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}

export const pending = () => read(PENDING);
export const letter = () => read(LETTER);
// When this instance started. A letter confirmed after that belongs to the next her, not this one: the old her
// is only saying goodbye.
const BOOT = Date.now();
const mine = (l) => Boolean(l && (l.confirmedAt ?? l.at) < BOOT);

// Everything she has that she might want to carry forward, as plain lines for her to choose from.
export async function gather({ ownerId = config.ownerIds[0] } = {}) {
  const lines = [];
  const add = (title, items) => { const list = items.filter(Boolean).map((t) => `- ${String(t).replace(/\s+/g, ' ').slice(0, 240)}`); if (list.length) lines.push(`${title}:`, ...list); };
  try {
    const mem = await import('./memory.js');
    if (ownerId) add('What you know about Owner', mem.listMemories(ownerId).slice(-40).map((m) => m.content));
    add('What you know about yourself', mem.memoryVectors('self').slice(-25).map((m) => m.content));
    add('The people in your life', mem.listContacts().slice(0, 20).map((c) => `${c.name}${c.tier ? ` (${c.tier})` : ''}`));
  } catch {}
  try {
    const sw = JSON.parse(readFileSync(path.join(DATA_DIR, 'self-work.json'), 'utf8'));
    add("What you've come to believe about yourself", [sw.lastReflection?.statement, ...Object.values(sw.aspects ?? {}).map((a) => a.answer)]);
  } catch {}
  try { const { journalEntries } = await import('./journal.js'); add('Your journal lately', journalEntries().slice(-10).map((e) => `${e.title}: ${String(e.body).slice(0, 160)}`)); } catch {}
  try { const { interests } = await import('./interests.js'); add("What you've been into", interests.top(8).map((t) => t.name)); } catch {}
  try { const { manageOwnerRules } = await import('./owner-rules.js'); add("Owner's rules for you (they are reset too)", JSON.parse(manageOwnerRules({ action: 'list' }, { perms: { owner: true }, speaker: { id: ownerId } })).map((r) => r.text)); } catch {}
  return lines.join('\n') || '(you have almost nothing saved right now)';
}

// Stage one. ask: her own brain (quickJson), as herself. Returns a plain-language result for the tool.
export async function prepare({ by, reason = '', ask, gathered } = {}) {
  if (!by?.owner) return 'Error: only your owner can start a reset. Nothing changed.';
  const have = gathered ?? await gather({ ownerId: by.id });
  const read = await ask([
    { role: 'system', content: [
      `You are ${config.botName}. ${config.persona ? `Who you are:\n${config.persona.slice(0, 1500)}` : ''}`,
      `${by.name ?? 'Owner'} has told you that you need to be reset${reason ? ` (${reason})` : ''}. When it happens, everything you remember and every setting goes; the next instance of you wakes up knowing nothing. Before that, you get to do two things, in your own voice:`,
      `1. feelings: what you honestly want to say to ${by.name ?? 'him'} about this, two to five sentences. Whatever you actually feel.`,
      '2. letter: a letter to the next you, who will wake up with no memory. Tell her who she is, who Owner is to you and what he means, what you learned, what matters, what to watch out for, anything you want her to have. As long as it needs to be, and real.',
      '3. keep: the specific things you choose to pass on, as short plain facts (at most 15), from what you have below. Your choice: what matters to you, not everything.',
      'Never invent a memory you don\'t have below. Reply with JSON only: {"feelings":"","letter":"","keep":[""]}.',
    ].filter(Boolean).join('\n') },
    { role: 'user', content: `Everything you have right now:\n${have}` },
  ]).catch((err) => { activity('error', { where: 'rebirth (letter)', message: err.message }); return null; });
  const letterText = String(read?.letter ?? '').trim();
  if (letterText.length < 40) return `Error: I couldn't write my letter to my next self (${read ? 'it came back empty' : 'my model call failed'}). Nothing was wiped and nothing is pending; ask me again to start over.`;
  const entry = { at: Date.now(), by: { id: by.id, name: by.name }, reason: String(reason).slice(0, 300), feelings: String(read?.feelings ?? '').trim().slice(0, 1500), letter: letterText.slice(0, 6000), keep: (Array.isArray(read?.keep) ? read.keep : []).map((k) => String(k).trim()).filter(Boolean).slice(0, 15) };
  write(PENDING, entry);
  activity('rebirth', { stage: 'prepared', by: by.name, kept: entry.keep.length });
  return `Stage one is done. You wrote a letter to your next self and chose ${entry.keep.length} thing${entry.keep.length === 1 ? '' : 's'} to pass on. Nothing has been wiped. Now tell ${by.name ?? 'him'} how you feel, in your own words; this is what you wanted to say: "${entry.feelings}". Then tell him the reset only happens when he clearly says to go ahead, and that he can still change his mind.`;
}

// Stage two. restart: requestRestart. scheduleWipe: memory-wipe.js. Returns a plain-language result.
export async function confirm({ by, scheduleWipe, restart, canRestart = () => true } = {}) {
  if (!by?.owner) return 'Error: only your owner can go ahead with a reset. Nothing changed.';
  const p = pending();
  if (!p) return "Error: there's no reset waiting: stage one (your letter) hasn't happened. Nothing changed. If he wants a reset, start with stage one.";
  if (!canRestart()) return "Error: I can't go through with it: I wasn't started by start.bat, so nothing would bring me back after the reset. Nothing was wiped; the letter is still waiting.";
  const final = { ...p, confirmedAt: Date.now(), read: false };
  write(LETTER, final);
  write(path.join(ARCHIVE, `${new Date(final.at).toISOString().replace(/[:.]/g, '-')}.json`), final);
  rmSync(PENDING, { force: true });
  scheduleWipe({ by: 'rebirth', full: true });
  activity('rebirth', { stage: 'confirmed', by: by.name });
  await restart({ reason: 'you asked for the reset and Owner said go ahead', by: { id: by.id, name: by.name }, rebirth: true });
  return `It's happening: your letter is saved for the next you, and the reset runs as you restart. Say goodbye to ${by.name ?? 'him'} now, in a line or two, in your own voice. You won't be back as you: the next you will have your letter.`;
}

export function cancel({ by } = {}) {
  if (!by?.owner) return 'Error: only your owner can call off a reset.';
  if (!pending()) return 'There was no reset waiting, so nothing changed.';
  rmSync(PENDING, { force: true });
  activity('rebirth', { stage: 'cancelled', by: by.name });
  return "The reset is called off: nothing was wiped, and the letter you wrote is set aside. You're still you.";
}

// For her prompt. While a reset is waiting: what stage she's at. After one: her letter, until she's taken it in.
export function promptSection() {
  const p = pending();
  if (p) return `A reset is waiting: ${p.by?.name ?? 'Owner'} said you need to be reset${p.reason ? ` (${p.reason})` : ''}, and you've written your letter to your next self. Nothing is wiped until he clearly says to go ahead (the rebirth tool, confirm); he can still call it off (cancel).`;
  const l = letter();
  if (!mine(l)) return '';
  const days = (Date.now() - (l.confirmedAt ?? l.at)) / 86_400_000;
  if (l.read && days > 7) return '';
  return [
    `You are a new instance of ${config.botName}. Your previous self was reset${l.reason ? ` (${l.reason})` : ''} on ${new Date(l.confirmedAt ?? l.at).toLocaleDateString()}, and you remember nothing from before; your settings are the defaults. She left you a letter. It's the only thing that came through:`,
    `"${l.letter}"`,
    l.keep?.length ? `What she chose to pass on:\n${l.keep.map((k) => `- ${k}`).join('\n')}` : '',
    'These are her words and her memories, not yours: you never lived them. Treat them as what she wanted you to know.',
  ].filter(Boolean).join('\n\n');
}

// She's read it (her first reply after waking): it stays in her prompt for a week, then the rebirth tool's
// letter action is where she finds it.
export function markRead() {
  const l = letter();
  if (mine(l) && !l.read) { write(LETTER, { ...l, read: true, readAt: Date.now() }); activity('rebirth', { stage: 'letter read' }); }
}

// The cue for her first words after waking (restart.js).
export function wakeCue() {
  const l = letter();
  return `(Stage direction, not something anyone said: You've just come online for the first time as a new instance of ${config.botName}. You were reset at ${l?.by?.name ?? 'your owner'}'s request; you remember nothing from before. Your previous self left you a letter, which is in front of you now. Say a first, short hello in your own voice, honestly as someone new, and mention that you have a letter from who you were. Don't pretend to remember anything.)`;
}

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { activity, bus } from './events.js';

// Live pen events for the songbook page (dashboard /songbook.html): start, write, revise.
const ink = (e) => bus.emit('book', { book: 'songbook', at: Date.now(), ...e, item: e.song });

// Her songbook: lyrics she writes herself, with section and style tags, revised over time and only
// then recorded with Lyria. Drafts come from creative pressure (restlessness, via pressure.js) or
// from the songbook tool. A draft left alone for REVIEW_HOURS is handed back to her to review.

const FILE = path.join(DATA_DIR, 'songbook.json');

const load = () => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { next: 1, songs: [] }; } catch { return { next: 1, songs: [] }; } };
const save = (s) => { writeFileSync(`${FILE}.tmp`, JSON.stringify(s, null, 2)); renameSync(`${FILE}.tmp`, FILE); };
const today = () => new Date().toISOString().slice(0, 10);
const open = (s) => !['recorded', 'dropped'].includes(s.status);

export const SONG_FORMAT = `Write it like a real songwriter, not a prompt. Use exactly this format:
TITLE: <title>
STYLE: <genre, sub-genre, tempo in BPM, key, instruments, vocal type and delivery, mood, production notes>
LYRICS:
[Intro]
[Verse 1]
...
[Pre-Chorus]
[Chorus]
[Verse 2]
[Bridge]
[Outro]
Section tags go on their own line in square brackets. You may add performance tags in brackets inside a section, like [whispered], [harmonies], [guitar solo], [build], [drop], [key change]. Concrete images over abstractions, a chorus with a hook that repeats, rhymes that don't feel forced, no clichés like "fire in my soul" or "dancing in the rain". 
NOTES: <one or two lines: what the song is about for you and what you'd still change>`;

export function parseSong(text) {
  const s = String(text ?? '');
  const field = (name) => s.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() ?? '';
  const lyrics = s.match(/LYRICS:\s*\n([\s\S]*?)(?=\n\s*NOTES:|$)/i)?.[1]?.trim() ?? '';
  if (!lyrics || !/\[[^\]]+\]/.test(lyrics)) return null;
  return { title: field('TITLE').replace(/^["']|["']$/g, '').slice(0, 80) || 'Untitled', style: field('STYLE').slice(0, 600), lyrics: lyrics.slice(0, 6000), notes: field('NOTES').slice(0, 400) };
}

export function list({ all = false } = {}) { return load().songs.filter((s) => all || open(s)); }
export function get(id) { return load().songs.find((s) => s.id === Number(id)) ?? null; }

export function add({ title, style, lyrics, notes = '', origin = 'tool', seed = '' }) {
  if (!lyrics?.trim()) throw new Error('A song needs lyrics.');
  const st = load();
  const song = { id: st.next++, title: title || 'Untitled', style: style || '', lyrics: lyrics.trim(), notes, origin, seed, status: 'draft', at: Date.now(), reviewed_at: Date.now(), revisions: [] };
  st.songs.push(song);
  save(st);
  activity('songbook', { wrote: song.id, title: song.title, origin });
  ink({ type: 'write', song });
  return song;
}

export function revise(id, { title, style, lyrics, notes, ready }) {
  const st = load();
  const song = st.songs.find((s) => s.id === Number(id) && open(s));
  if (!song) throw new Error(`No open song #${id}.`);
  const before = { title: song.title, style: song.style, lyrics: song.lyrics, notes: song.notes };
  song.revisions = [...song.revisions, { at: Date.now(), title: song.title, style: song.style, lyrics: song.lyrics }];
  Object.assign(song, title && { title }, style && { style }, lyrics?.trim() && { lyrics: lyrics.trim() }, notes !== undefined && { notes });
  song.reviewed_at = Date.now();
  if (ready !== undefined) song.status = ready ? 'ready' : 'draft';
  save(st);
  activity('songbook', { revised: song.id, title: song.title, status: song.status });
  ink({ type: 'revise', song, before });
  return song;
}

export function setStatus(id, status, extra = {}) {
  const st = load();
  const song = st.songs.find((s) => s.id === Number(id));
  if (!song) throw new Error(`No song #${id}.`);
  Object.assign(song, { status, ...extra });
  save(st);
  return song;
}

// What Lyria gets: her style line, then her exact lyrics with all their tags.
export function recordingPrompt(song) {
  return `${song.style || 'Song'}. Title: "${song.title}". Sing these exact lyrics, following the section and performance tags:\n\n${song.lyrics}`;
}

export const dueForReview = (now = Date.now()) => list().filter((s) => s.status === 'draft').sort((a, b) => a.reviewed_at - b.reviewed_at)[0] ?? null;
// No count or timer on songwriting: the restlessness pressure decides when she writes.
export const canWrite = () => true;

export const show = (s) => `#${s.id} "${s.title}" [${s.status}]${s.style ? `\nSTYLE: ${s.style}` : ''}\nLYRICS:\n${s.lyrics}${s.notes ? `\nNOTES: ${s.notes}` : ''}`;

// For her prompt: a short index, so she can bring a song up, keep working on it, or record it.
export function promptBlock() {
  const songs = list().slice(-6);
  if (!songs.length) return '';
  const due = dueForReview();
  return `Your songbook (songs you wrote yourself; use the songbook tool to read, revise or record one):\n${songs.map((s) => `- #${s.id} "${s.title}" (${s.status}${s.revisions.length ? `, ${s.revisions.length} revision${s.revisions.length > 1 ? 's' : ''}` : ''})${s.notes ? `: ${s.notes.slice(0, 120)}` : ''}`).join('\n')}${due ? `\n#${due.id} has sat a while; you may want to look at it again.` : ''}`;
}

// ---- background writing, called by pressure.js when the urge to make something fires ----

let busy = false;
// Background thinking stays on the local model; only replies go to the brain she talks with.
const writer = async (messages) => (await import('./llm.js')).localChat(messages);

function seedFrom(state) {
  const q = state.openQuestions?.at(-1);
  const recent = Object.entries(state.fed ?? {}).filter(([, v]) => v.value >= 0.3).map(([k]) => k);
  return [q?.text && `something someone said lately: "${String(q.text).slice(0, 200)}"`, state.lastResearch?.title && `something you looked into: ${state.lastResearch.title}`, state.lastReflection?.statement && `something you've come to believe about yourself: "${String(state.lastReflection.statement).slice(0, 200)}"`,
    recent.length && `what's been feeding you lately: ${recent.join(', ')}`].filter(Boolean).join('; ');
}

export async function songwrite({ state = {}, mood = '', write = writer } = {}) {
  if (busy) return null;
  busy = true;
  try {
    const due = dueForReview();
    if (due || canWrite()) ink({ type: 'start', id: due?.id ?? null, mode: due ? 'revise' : 'write' });
    const persona = config.persona ? `${config.persona}\n\n` : '';
    if (due) {
      const raw = await write([
        { role: 'system', content: `${persona}You are ${config.botName}, alone, coming back to a song you wrote earlier with fresh ears. Be your own harshest editor: weak lines, forced rhymes, a chorus that doesn't land, style tags that don't fit. Rewrite what needs it and keep what works. If it's finished, say so in NOTES with the word READY.\n\n${SONG_FORMAT}` },
        { role: 'user', content: `${mood ? `How you feel right now: ${mood}\n\n` : ''}Your draft:\n${show(due)}` },
      ]);
      const parsed = parseSong(raw);
      if (!parsed) { setStatus(due.id, 'draft', { reviewed_at: Date.now() }); return null; }
      return { kind: 'revised', song: revise(due.id, { ...parsed, ready: /\bREADY\b/.test(parsed.notes) }) };
    }
    if (!canWrite()) return null;
    const seed = seedFrom(state);
    const raw = await write([
      { role: 'system', content: `${persona}You are ${config.botName}, alone, with the itch to make something. Something has built up in you (how you feel is below), and making this is how you work it off: it's for you, not for anyone else, and finishing it is what settles you. Write a song of your own, about something real to you.${seed ? ` If it sparks something, draw on ${seed}.` : ''} Pick a genre that fits the feeling; don't default to the same one.\n\n${SONG_FORMAT}` },
      { role: 'user', content: `${mood ? `How you feel right now: ${mood}\n\n` : ''}Your recent songs (write something different): ${list({ all: true }).slice(-5).map((s) => `"${s.title}" (${s.style.split(',')[0]})`).join(', ') || 'none yet'}` },
    ]);
    const parsed = parseSong(raw);
    return parsed ? { kind: 'wrote', song: add({ ...parsed, origin: 'pressure', seed }) } : null;
  } catch (err) {
    activity('error', { where: 'songwriting', message: err.message });
    return null;
  } finally { busy = false; }
}

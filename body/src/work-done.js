import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

// Owner, 2026-11-10: "Whenever I come to you and I give you stuff to do to her, I want to just be able to walk
// away. And when you're done, you contact her, and then she contacts me and lets me know that you're done."
// "You" is Claude Code, the coder Owner works with on her from outside. When it finishes it posts a note to her
// dashboard (POST /api/work-done); she tells Owner herself: in the call if he's in one with her, else by a short
// DM. A note she can't deliver yet (she's offline, restarting, Discord isn't up) waits in a file and goes out
// the moment she's back online, so nothing is lost and nobody has to check.

const PENDING = () => path.join(DATA_DIR, 'work-done-pending.jsonl');
const DELIVERED = () => path.join(DATA_DIR, 'work-done.jsonl');
const STARTED = Date.now(); // when this run of her began: a note written before it has had its restart
let deliver = null; // (note) => Promise<'voice' | 'dm'>, set once Discord is up (bot.js)

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function noteFrom(body = {}) {
  const note = {
    title: clean(body.title, 160),
    summary: clean(body.summary, 1200),
    not_done: clean(body.not_done, 600),
    restart_needed: body.restart_needed === true,
    from: clean(body.from, 60) || 'Claude Code',
    at: Date.now(),
  };
  if (!note.title) throw Object.assign(new Error('title is required: what Owner asked for, in a few words'), { status: 400 });
  if (!note.summary) throw Object.assign(new Error('summary is required: what was done'), { status: 400 });
  return note;
}

// What she's told, for her to pass on in her own words. The facts are fixed here; the wording is hers.
// startedAt: when this run of her began. A note written before it needed a restart that has already happened
// (2026-11-10: she delivered one right after restarting and still asked him when he'd like her to restart).
export function cueFor(note, { dm = false, startedAt = STARTED } = {}) {
  const restart = !note.restart_needed ? 'Nothing needs a restart.'
    : note.at < startedAt ? "It needed a restart, and you've restarted since, so it's live now. Don't offer to restart for it."
    : 'The changes only take effect after you restart; offer to restart when it suits him.';
  return [
    `${note.from} (Owner may call it the doctor), the coder Owner works with on you from outside, just finished work he gave it on you: "${note.title}".`,
    `What it reports: ${note.summary}`,
    note.not_done && `Not done or not checked yet: ${note.not_done}`,
    restart,
    `Let Owner know it's done, in your own words${dm ? ', in one to three short sentences, like a text: anything to go over is for voice' : ', briefly'}. Only say what's in this report.`,
  ].filter(Boolean).join(' ');
}

function readPending() {
  try { return existsSync(PENDING()) ? readFileSync(PENDING(), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []; }
  catch { return []; }
}
function writePending(notes) {
  try { writeFileSync(PENDING(), notes.map((n) => JSON.stringify(n)).join('\n') + (notes.length ? '\n' : '')); }
  catch (err) { activity('error', { where: 'work done', message: `Couldn't save the notes still to deliver to ${PENDING()}: ${err.message}.` }); }
}

async function attempt(note) {
  if (!deliver) return { delivered: false, why: "she isn't connected to Discord yet; it goes to Owner as soon as she is" };
  try {
    const via = await deliver(note);
    activity('work-done', { title: note.title, from: note.from, delivered: via });
    try { appendFileSync(DELIVERED(), JSON.stringify({ ...note, delivered: via, told_at: Date.now() }) + '\n'); }
    catch (err) { activity('error', { where: 'work done', message: `Told Owner, but couldn't record it in ${DELIVERED()}: ${err.message}.` }); }
    return { delivered: true, via };
  } catch (err) {
    activity('error', { where: 'work done', message: `Couldn't tell Owner that "${note.title}" is done: ${err.message}. It's kept and retried when she's next back online.` });
    return { delivered: false, why: err.message };
  }
}

// The notes she's had, newest last: so "did you get the note?" is answered from the record, in any conversation
// (2026-11-10: she told him by DM, then in the call checked only her doctor and said there was no note).
export function recentNotes(limit = 3) {
  try { return existsSync(DELIVERED()) ? readFileSync(DELIVERED(), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).slice(-limit) : []; }
  catch { return []; }
}
export function notesLine(now = Date.now()) {
  const notes = recentNotes();
  const waiting = readPending();
  const ago = (t) => { const m = Math.round((now - t) / 60000); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const parts = notes.map((n) => `"${n.title}" (${ago(n.told_at)}, you told Owner by ${n.delivered}): ${n.summary}${n.not_done ? ` Not done yet: ${n.not_done}` : ''}`);
  return [
    parts.length ? `Notes from Claude Code, the coder Owner works with on you from outside (he may call it the doctor too): ${parts.join(' | ')}` : 'There are no notes from Claude Code on record.',
    waiting.length && `${waiting.length} note(s) from it are still waiting to be passed on.`,
  ].filter(Boolean).join(' ');
}

// A finished job: told to Owner now if she can, else kept until she can.
export async function workDone(note) {
  activity('work-done-received', { title: note.title, from: note.from, restart_needed: note.restart_needed });
  const result = await attempt(note);
  if (!result.delivered) appendFileSync(PENDING(), JSON.stringify(note) + '\n');
  return result;
}

// Discord is up: from now on notes go straight out, and any that waited go out now, oldest first.
export async function setWorkDoneDelivery(fn) {
  deliver = fn;
  const waiting = readPending();
  if (!waiting.length) return;
  const left = [];
  for (const note of waiting) if (!(await attempt(note)).delivered) left.push(note);
  writePending(left);
}

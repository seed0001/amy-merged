import { activity } from './events.js';

// The question she has out to someone, per conversation: what she asked, who she asked, when, and
// whether they've said anything since. One at a time; a newer question replaces an older one, so
// "your last question" always means the one actually in the air. Her prompt reads it (she knows
// when she's been left hanging and never answers her own question or pretends it was answered), and
// her pressure system (the nudge bucket, pressure.js) is what brings it up again: once, lightly,
// after a while, only while that person is here and not away.
//
// conversation -> { text, to: { id, name, owner }, kind, at, spokenSince: [{ id, name, at }], nudges }

const open = new Map();
const closedRecently = new Map(); // conversation -> last closed question, for the prompt right after

// The question in a line of hers: the last sentence ending in "?", or nothing.
export function questionIn(text) {
  const parts = String(text ?? '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  const q = parts.map((p) => p.trim()).filter((p) => p.endsWith('?')).at(-1);
  return q && q.length >= 6 ? q.slice(0, 300) : null;
}

// She just said `text` to `to`. kind: 'reply' (in answer to them), 'speakup' (unprompted), 'curiosity'.
export function asked(conversation, { text, to, kind = 'reply', now = Date.now() }) {
  const q = questionIn(text);
  if (!q || !to?.id) { return null; }
  const entry = { text: q, to: { id: to.id, name: to.name, owner: Boolean(to.owner) }, kind, at: now, spokenSince: [], nudges: 0 };
  open.set(conversation, entry);
  return entry;
}

export const current = (conversation) => open.get(conversation) ?? null;

// Someone spoke. What the person she asked says is kept with the question, but it doesn't close it:
// the question stays hers and stays open until she judges it answered or lets it go (resolve(), from
// her own [[question: answered]] / [[question: let go]] tag), or asks a new one. Anyone else is noted,
// so she knows the room moved on without an answer.
export function heard(conversation, { id, name }, text, now = Date.now()) {
  const q = open.get(conversation);
  if (!q) return null;
  if (id === q.to.id) {
    q.replies = [...(q.replies ?? []), { text: String(text ?? '').replace(/\s+/g, ' ').slice(0, 240), at: now }].slice(-3);
    return q;
  }
  q.spokenSince.push({ id, name, at: now });
  if (q.spokenSince.length > 6) q.spokenSince.shift();
  return null;
}

// She judged it: 'answered' or 'let go'. Read from her reply's [[question: ...]] tag (companion.js).
export function resolve(conversation, how = 'answered') {
  const q = open.get(conversation);
  if (!q) return null;
  open.delete(conversation);
  activity('open-question', { conversation, [how === 'answered' ? 'answered' : 'dropped']: q.text, to: q.to.name, why: how });
  return q;
}

// Her reply's own verdict on her open question, if she gave one: 'answered', 'let go' or null.
export function verdictIn(reply) {
  const m = String(reply ?? '').match(/\[\[\s*question\s*:\s*(answered|let go|let_go|drop(?:ped)?)\s*\]\]/i);
  return m ? (m[1].toLowerCase() === 'answered' ? 'answered' : 'let go') : null;
}

// Let go: she's brought it up again as many times as she's going to, or stopped caring.
export function drop(conversation, why = 'let go') {
  const q = open.get(conversation);
  if (!q) return;
  open.delete(conversation);
  activity('open-question', { conversation, dropped: q.text, to: q.to.name, why });
}

// For pressure (the nudge bucket): 1 when a question to someone present and not away has gone
// unanswered for `afterMs`, else 0. Only one nudge per question.
export function nudgeNeed(conversation, { present, away = new Set(), afterMs = 5 * 60_000, now = Date.now() } = {}) {
  const q = open.get(conversation);
  if (!q || q.nudges >= 1 || q.replies?.length) return 0; // they've said something back: it's in her prompt, not a nudge
  if (!present?.has(q.to.id) || away.has(q.to.id)) return 0;
  return now - q.at >= afterMs ? 1 : 0;
}

// Pressure fired the nudge: it won't fire again for this question.
export function nudged(conversation) {
  const q = open.get(conversation);
  if (!q) return null;
  q.nudges++;
  activity('open-question', { conversation, nudged: q.text, to: q.to.name });
  return q;
}

export function cleared(conversation) { open.delete(conversation); closedRecently.delete(conversation); }

const ago = (ms) => { const s = Math.round(ms / 1000); return s < 50 ? 'just now' : s < 90 ? 'a minute ago' : `${Math.round(s / 60)} minutes ago`; };

// For her prompt. speakerId: who she's replying to now (null when she's speaking up on her own).
export function promptSection(conversation, speakerId = null, now = Date.now()) {
  const q = open.get(conversation);
  if (q && q.replies?.length) {
    const said = q.replies.map((r) => `"${r.text}"`).join(', then ');
    return `Your open question: you asked ${q.to.name} "${q.text}" ${ago(now - q.at)}. It's YOUR question; ${q.to.name} didn't ask it, so never treat it as something they asked you. Since then ${q.to.name} said: ${said}. Judge it yourself: if that answers it, take the answer in and end your reply with the silent tag [[question: answered]]. If you've decided to let it go, end with [[question: let go]]. Otherwise it's still open and still yours: keep it in mind while you answer what they just said, and come back to it when it fits. Don't answer it yourself.`;
  }
  if (q) {
    const others = q.spokenSince.length ? ` Since then ${[...new Set(q.spokenSince.map((s) => s.name))].join(' and ')} spoke, but not ${q.to.name}.` : '';
    if (speakerId && speakerId !== q.to.id) return `You asked ${q.to.name} "${q.text}" ${ago(now - q.at)} and ${q.to.name} hasn't answered.${others} This line is from someone else: don't treat it as ${q.to.name}'s answer, and don't answer your own question for them.`;
    return `You asked ${q.to.name} "${q.text}" ${ago(now - q.at)} and ${q.to.name} hasn't answered yet.${others} An unanswered question stays theirs to answer: don't answer it yourself, don't say what you think about it as if they'd asked you, and don't pretend they answered. Either leave it or, if it truly fits, ask once more, lightly.`;
  }
  const c = closedRecently.get(conversation);
  if (c && speakerId === c.to.id && now - c.closedAt < 15_000) {
    closedRecently.delete(conversation);
    return `You had asked ${c.to.name} "${c.text}". Their line now may or may not answer it; read it as it is. If it answers, take the answer. If it's about something else, they've moved on: go with them and don't repeat the question.`;
  }
  return '';
}

import { embed } from './llm.js';

// The conversation thread, ported from Amy-Voice: what each conversation is talking about right now,
// followed by meaning. Each line is compared with the thread so far. On topic, the thread grows: more
// turns, more people, her own part in it. It has momentum while it's a real back-and-forth with new
// things being said, and it gets satisfied as it's covered: turns pile up, the new information dries
// up, her follow-ups get answered. A satisfied thread lets go; so does one the room has moved away from.
//
// While a thread has momentum she stays on it: off-topic things wait, and her pressure (the follow_up
// bucket) wants to ask something that goes deeper. Once it's satisfied, she's free again.

const SAME = 0.5;  // a line this close to the thread is on it
const AWAY = 0.35; // two lines in a row this far from it means the talk moved on
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

export function createThreads({ embedder = embed, now = Date.now } = {}) {
  const threads = new Map(); // conversation -> thread

  async function update({ conversation, name, text, mine = false }) {
    const t = String(text ?? '').trim();
    let thread = threads.get(conversation) ?? null;
    if (t.split(/\s+/).length < 3) return thread; // "yeah", "what?" carry no topic
    let vec;
    try { [vec] = await embedder([t.slice(0, 600)]); } catch { return thread; }
    const at = now();
    const sim = thread ? cosine(thread.vec, vec) : 0;
    if (!thread || (sim < AWAY && ++thread.away >= 2) || at - thread.last > 10 * 60_000) {
      thread = { vec, started: at, first: t.slice(0, 160), last: at, turns: 0, mine: 0, speakers: new Set(), recent: [], satisfaction: 0, away: 0, followUps: 0, lastLine: '' };
      threads.set(conversation, thread);
    }
    if (sim >= SAME || thread.turns === 0) {
      thread.away = 0;
      // New information keeps it alive; saying the same things again satisfies it.
      const novelty = thread.recent.length ? 1 - Math.max(...thread.recent.map((r) => cosine(r, vec))) : 1;
      thread.satisfaction = Math.min(1, thread.satisfaction + 0.05 + (novelty < 0.15 ? 0.1 : 0));
      thread.turns++;
      if (mine) thread.mine++; else thread.speakers.add(name);
      thread.vec = thread.vec.map((x, i) => x * 0.8 + vec[i] * 0.2); // the thread drifts with the talk
      thread.recent = [...thread.recent, vec].slice(-6);
      thread.last = at;
      thread.lastLine = `${name}: ${t.slice(0, 200)}`;
    }
    return thread;
  }

  // How much a thread has going for it, 0..1: real back-and-forth, not yet satisfied, still current.
  function momentum(conversation) {
    const thread = threads.get(conversation);
    if (!thread || now() - thread.last > 3 * 60_000) return 0;
    const voices = thread.speakers.size + (thread.mine ? 1 : 0);
    return Math.min(1, thread.turns / 5) * (voices >= 2 ? 1 : 0.5) * (1 - thread.satisfaction);
  }

  return {
    update, momentum,
    current: (conversation) => threads.get(conversation) ?? null,
    satisfied: (conversation) => Boolean(threads.get(conversation)?.satisfaction >= 0.8),
    // One of her follow-ups went out: the thread is a bit more covered.
    followedUp(conversation) { const t = threads.get(conversation); if (t) { t.followUps++; t.satisfaction = Math.min(1, t.satisfaction + 0.12); } },
    // For her prompt: what the room is in the middle of.
    promptSection(conversation) {
      const thread = threads.get(conversation);
      if (!thread || momentum(conversation) < 0.25) return '';
      const minutes = Math.max(1, Math.round((now() - thread.started) / 60_000));
      return `You're in the middle of a good conversation (${thread.turns} turns over ${minutes} min, with ${[...thread.speakers].join(', ') || 'them'}). ` +
        `It started with "${thread.first}" and the latest was "${thread.lastLine}". It isn't played out yet: stay on this topic, build on what was just said, and don't bring up anything unrelated until it is.`;
    },
  };
}

export const threads = createThreads();

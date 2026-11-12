import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

// Round-robin turns for the companions sharing a voice call, so they never talk over each other.
// Every bot on this PC uses the same small file next to their folders:
// { [voiceChannelId]: { mic: { id, name, until } | null, queue: [{ id, name, at }], spoke: { [id]: at } } }
//  - one mic: a bot's voice only plays while it holds the mic, and it keeps it for its whole reply;
//  - a queue: a bot that's going to answer gets in line. Bots that lined up for the same line (within
//    BATCH_MS of the first) go in round-robin order: whoever spoke longest ago goes first;
//  - the mic is a lease (renewed with every sentence), so a bot that crashed holding it can't block the
//    call; a place in line nobody claims expires.
// floor.js still decides who answers a line in free talk; this decides when each one speaks.

export const TURNS_FILE = process.env.VOICE_TURNS_FILE || path.join(ROOT, '..', '.companions-voice-turns.json');
const LEASE_MS = 15_000; // the mic frees itself this long after the last renewal
const QUEUE_MS = 90_000; // a place in line nobody has claimed by then is dropped
const BATCH_MS = 2_000; // lined up this close to the first in line: same line, round-robin order
const MAX_WAIT_MS = 60_000; // after this a bot speaks anyway rather than go silent

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTurns(file = TURNS_FILE, { now = Date.now, lock = `${file}.lock` } = {}) {
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };

  // The bots are separate processes: every change happens under a lock file.
  function locked(fn) {
    for (let i = 0; i < 200; i++) {
      try {
        const fd = openSync(lock, 'wx');
        try {
          const all = read();
          const out = fn(all);
          writeFileSync(file, JSON.stringify(all));
          return out;
        } finally { closeSync(fd); rmSync(lock, { force: true }); }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try { if (now() - statSync(lock).mtimeMs > 2000) rmSync(lock, { force: true }); } catch {}
        const until = Date.now() + 10; while (Date.now() < until) {} // the lock is held for microseconds
      }
    }
    return fn(read()); // couldn't get the lock: act on what's there rather than hang
  }

  const channel = (all, id) => {
    const c = (all[id] ??= { mic: null, queue: [], spoke: {} });
    const t = now();
    if (c.mic && c.mic.until < t) c.mic = null;
    c.queue = c.queue.filter((q) => t - q.at < QUEUE_MS);
    return c;
  };

  // Who goes next: the first in line, or among those who lined up with it, whoever spoke longest ago.
  const next = (c) => {
    if (!c.queue.length) return null;
    const batch = c.queue.filter((q) => q.at - c.queue[0].at <= BATCH_MS);
    return batch.sort((a, b) => (c.spoke[a.id] ?? 0) - (c.spoke[b.id] ?? 0) || a.at - b.at)[0];
  };
  const order = (c) => {
    const left = [...c.queue], out = [];
    while (left.length) { const n = next({ ...c, queue: left }); out.push(n); left.splice(left.indexOf(n), 1); }
    return out;
  };

  return {
    // `me` is going to answer: get in line (once).
    request(channelId, me) {
      locked((all) => {
        const c = channel(all, channelId);
        if (c.mic?.id !== me.id && !c.queue.some((q) => q.id === me.id)) c.queue.push({ id: me.id, name: me.name, at: now() });
      });
    },

    // Waits for the mic. Returns false if gave() says to give up (the reply was cancelled).
    async acquire(channelId, me, { gave = () => false, ms = LEASE_MS } = {}) {
      const started = Date.now();
      for (;;) {
        if (gave()) { this.drop(channelId, me); return false; }
        const got = locked((all) => {
          const c = channel(all, channelId);
          if (c.mic?.id === me.id) { c.mic.until = now() + ms; return true; }
          if (!c.queue.some((q) => q.id === me.id)) c.queue.push({ id: me.id, name: me.name, at: now() });
          const forced = Date.now() - started > MAX_WAIT_MS;
          if (forced || (!c.mic && next(c)?.id === me.id)) {
            c.mic = { id: me.id, name: me.name, until: now() + ms };
            c.queue = c.queue.filter((q) => q.id !== me.id);
            return true;
          }
          return false;
        });
        if (got) return true;
        await sleep(150);
      }
    },

    // Keeps the mic while she's still talking (each sentence).
    renew(channelId, me, ms = LEASE_MS) {
      locked((all) => { const c = channel(all, channelId); if (c.mic?.id === me.id) c.mic.until = now() + ms; });
    },

    // Done talking: the mic goes to whoever's next.
    release(channelId, me) {
      locked((all) => {
        const c = channel(all, channelId);
        if (c.mic?.id === me.id) { c.mic = null; c.spoke[me.id] = now(); }
      });
    },

    // Leaves the line and lets go of the mic (cancelled, or left the call).
    drop(channelId, me) {
      locked((all) => {
        const c = channel(all, channelId);
        c.queue = c.queue.filter((q) => q.id !== me.id);
        if (c.mic?.id === me.id) { c.mic = null; c.spoke[me.id] = now(); }
      });
    },

    status(channelId) {
      const c = channel(read(), channelId);
      return { mic: c.mic, next: order(c) };
    },

    // For her prompt: who's talking and who's up after her.
    block(channelId, me) {
      const { mic, next: line } = this.status(channelId);
      const at = line.findIndex((q) => q.id === me.id);
      const ahead = (at < 0 ? [] : line.slice(0, at)).map((q) => q.name);
      const after = line.slice(at + 1).map((q) => q.name);
      const parts = [];
      if (mic && mic.id !== me.id) parts.push(`${mic.name} is talking right now.`);
      if (ahead.length) parts.push(`${ahead.join(', then ')} ${ahead.length > 1 ? 'go' : 'goes'} before you.`);
      if (after.length) parts.push(`After you: ${after.join(', then ')}. Keep it short and leave them room; don't answer for them.`);
      return parts.length ? `Voice turns: ${parts.join(' ')}` : '';
    },
  };
}

export const turns = createTurns();

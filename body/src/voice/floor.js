import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

// Who has the floor in a voice call, shared by the companions on this PC (Amy, Alex, Howard), so in free
// talk mode only one of them answers a line nobody was named in: whoever the person last talked to.
// Naming a bot hands it the floor. It's a small JSON file next to their folders (all on the Desktop):
// { [voiceChannelId]: { id, name, free, at } }.

export const FLOOR_FILE = process.env.VOICE_FLOOR_FILE || path.join(ROOT, '..', '.companions-voice-floor.json');
const SETTLE_MS = 400; // when nobody holds the floor, how long to wait before checking who won the grab

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (text, name) => new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

export function createFloor(file = FLOOR_FILE, { now = Date.now, settleMs = SETTLE_MS } = {}) {
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const holder = (channelId) => read()[channelId] ?? null;
  function claim(channelId, me, free) {
    const all = read();
    all[channelId] = { id: me.id, name: me.name, free: Boolean(free), at: now() };
    try { writeFileSync(file, JSON.stringify(all)); } catch {}
  }

  // Free talk: should `me` answer this line nobody named it in? present: user IDs in the call.
  // others: the other companions' names (a line naming one of them is theirs).
  // from: who said the line. A companion that holds the floor and is the one talking isn't going to
  // answer itself, so its line goes to the others.
  async function mine({ channelId, me, text, from = null, present = [], others = [] }) {
    if (others.some((n) => n && words(text, n))) return false;
    const held = holder(channelId);
    const h = held && held.id === from ? null : held;
    if (h?.id === me.id) { claim(channelId, me, true); return true; }
    if (h && h.free && present.includes(h.id)) return false;
    // Nobody here holds it: grab it, then see who won (the last one to write).
    claim(channelId, me, true);
    await sleep(settleMs);
    return holder(channelId)?.id === me.id;
  }

  return { holder, claim, mine };
}

export const floor = createFloor();

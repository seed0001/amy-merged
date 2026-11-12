import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

// What each companion on this PC is saying out loud, shared through a small file next to their
// folders: { [botUserId]: { channelId, text, at } }. Speech-to-text loses words (it heard Amy's
// "Nova, I understand..." as "I understand..."), so when one companion hears another it takes the
// exact words from here instead of the transcription. Sentences of one reply are joined; a reply is
// handed out once, to the first piece of audio heard from that bot.

export const SAID_FILE = process.env.VOICE_SAID_FILE || path.join(ROOT, '..', '.companions-said.json');
const JOIN_MS = 20_000; // sentences this close together are one reply
const FRESH_MS = 60_000; // older than this, it's not what was just heard

const read = () => { try { return JSON.parse(readFileSync(SAID_FILE, 'utf8')); } catch { return {}; } };
const write = (all) => { try { writeFileSync(SAID_FILE, JSON.stringify(all)); } catch {} };

export function noteSaid(botId, channelId, text, now = Date.now()) {
  if (!botId || !text) return;
  const all = read();
  const prev = all[botId];
  const same = prev && !prev.takenBy?.length && prev.channelId === channelId && now - prev.at < JOIN_MS;
  all[botId] = { channelId, text: same ? `${prev.text} ${text}` : text, at: now, takenBy: [] };
  write(all);
}

// The exact words companion botId just said in this channel, once per listener (me), or null (then
// the transcription stands).
export function takeSaid(botId, channelId, me, now = Date.now()) {
  const all = read();
  const s = all[botId];
  if (!s || s.channelId !== channelId || now - s.at > FRESH_MS || s.takenBy?.includes(me)) return null;
  all[botId] = { ...s, takenBy: [...(s.takenBy ?? []), me] };
  write(all);
  return s.text;
}

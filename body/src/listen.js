import { activity } from './events.js';
import { interests } from './interests.js';
import { json } from './llm.js';
import { config } from './config.js';
import { avatarToolCall } from './avatar-cues.js';

// Everything she hears (chat and calls, not only what she answers), read in small batches by her
// local model. It notes what people bring up that she might want to look into; those grow her
// interests (interests.js), and the pressure system's explore bucket sends her to look into the
// strongest. Her own lines are skipped, and DMs never reach here.
const BATCH = 12;
const MAX_WAIT_MS = 60_000;
const MAX_LINE = 300;
const PROMPT = 'You read a chat or a call between people and note the topics someone curious would want to look into: things, tools, games, music, books, places, science, ideas. Skip greetings, small talk, people\'s personal business and anything private. Reply with JSON only: {"topics":[{"name":"short topic, 2 to 6 words","person":"who brought it up"}]}. At most 4 topics. Empty list if nothing is worth looking into.';

export function createListener({
  ask = (messages) => json(messages, { purpose: 'listen' }),
  notice = (items) => interests.notice(items),
  show = avatarToolCall,
  log = activity,
  self = () => config.botName,
  batch = BATCH,
  waitMs = MAX_WAIT_MS,
} = {}) {
  const queue = [];
  let timer = null, busy = false, seq = 0;

  async function flush() {
    clearTimeout(timer); timer = null;
    if (busy || !queue.length) return;
    const lines = queue.splice(0, batch);
    busy = true;
    const id = `listen-${++seq}-${Date.now()}`;
    show({ id, tool: 'listen', label: 'Listening to the chat', phase: 'start' });
    try {
      const reply = await ask([
        { role: 'system', content: PROMPT },
        { role: 'user', content: lines.map((l) => `${l.speaker}: ${l.text}`).join('\n') },
      ]);
      const names = new Set(lines.map((l) => l.speaker));
      const bond = Math.max(0, ...lines.map((l) => l.bond ?? 0));
      const topics = (Array.isArray(reply?.topics) ? reply.topics : [])
        .filter((t) => typeof t?.name === 'string' && t.name.trim())
        .slice(0, 4)
        .map((t) => ({ name: t.name, person: names.has(t.person) ? t.person : lines[0].speaker, source: 'conversation', bond }));
      if (topics.length) {
        await notice(topics);
        log('listen', { heard: lines.length, topics: topics.map((t) => t.name) });
      }
    } catch (err) {
      log('error', { where: 'listen', message: err.message });
    } finally {
      busy = false;
      show({ id, tool: 'listen', phase: 'end', ok: true });
      if (queue.length >= batch) flush();
      else if (queue.length) timer ??= setTimeout(flush, waitMs);
    }
  }

  return {
    hear({ speaker, text, bond = 0 } = {}) {
      const line = String(text ?? '').trim();
      if (!speaker || line.length < 8 || speaker === self()) return;
      queue.push({ speaker, text: line.slice(0, MAX_LINE), bond });
      if (queue.length >= batch) flush();
      else timer ??= setTimeout(flush, waitMs);
    },
    pending: () => queue.length,
  };
}

export const listen = createListener();

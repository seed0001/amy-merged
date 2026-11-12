import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { json, embed } from './llm.js';

// Sleeping on it, ported from Amy-Voice's upkeep: as she falls asleep for the night, she goes back over
// what was said since last time, and keeps what matters:
//   shared     inside jokes and moments she shared with each person (on their node in her knowledge graph)
//   treats_me  how each person treats her, one sentence, rewritten as it changes
//   opinions   what she said she thinks about things, so she stays herself; a changed mind keeps the
//              old stance as what she used to think
// It's set off by her falling asleep (her tiredness, sleep.js), never a timer. If she's woken, it
// stops where it is and picks up from there the next night. Only people she remembers are kept.

const CHUNK = 60;
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };
const list = (r, k) => (Array.isArray(r?.[k]) ? r[k].filter((x) => x && typeof x === 'object') : []);

export function createSleepOnIt({
  file = path.join(DATA_DIR, 'sleep-on-it.json'),
  judge = (messages) => json(messages, { purpose: 'sleep_on_it', maxTokens: 1200 }),
  embedder = embed,
  messages,          // (sinceMs, limit) -> [{ role, name, content, created_at }]
  resolve,           // name -> person id or null
  canRemember,       // id -> boolean
  keepShared,        // ({ id, name, kind, text, place }) -> Promise
  name = () => config.botName,
  now = Date.now,
} = {}) {
  let s = { lastAt: 0, treats: {}, opinions: [] };
  try { if (existsSync(file)) s = { ...s, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); };
  let running = null;

  async function holdOpinion(topic, stance) {
    const t = String(topic ?? '').trim().slice(0, 60), st = String(stance ?? '').trim().slice(0, 240);
    if (!t || !st) return false;
    const [vec] = await embedder([t]);
    const old = s.opinions.find((o) => cosine(o.vec, vec) > 0.85);
    if (old) {
      if (old.stance.toLowerCase() === st.toLowerCase()) return false;
      old.previous = [...(old.previous ?? []), { stance: old.stance, at: old.at }].slice(-5);
      Object.assign(old, { stance: st, at: now() });
    } else s.opinions.push({ topic: t, stance: st, at: now(), previous: [], vec });
    return true;
  }

  // Going back over the day. asleep(): still asleep (woken = stop and keep the place).
  async function goBackOver({ asleep = () => true } = {}) {
    const me = name();
    const lines = messages(s.lastAt + 1, 600);
    const done = { lines: 0, shared: 0, treats: 0, opinions: 0 };
    for (let i = 0; i < lines.length; i += CHUNK) {
      if (!asleep()) break; // woken: the rest waits for the next night
      const chunk = lines.slice(i, i + CHUNK);
      const transcript = chunk.map((l) => `${l.role === 'assistant' ? l.name ?? me : l.name ?? 'someone'}: ${String(l.content).slice(0, 400)}`).join('\n');
      const r = await judge([
        { role: 'system', content: `You are ${me}, going back over part of your day as you fall asleep. Reply with JSON only.` },
        { role: 'user', content: `${transcript}\n\nFrom this, what do you want to keep? Reply with JSON: ` +
          '{"shared":[{"person":"their name exactly as above","kind":"joke|moment","text":"an inside joke or a moment you shared with them, one sentence"}],' +
          '"treats_me":[{"person":"their name exactly as above","text":"how they treat you, one sentence"}],' +
          `"opinions":[{"topic":"2-4 words","stance":"what you (${me}) said you think, one sentence"}]}. ` +
          'Only what actually happened in these lines; empty lists if nothing. At most 4 of each.' },
      ]);
      if (!r) throw new Error('her local model gave nothing back while she went over the day');
      for (const x of list(r, 'shared').slice(0, 4)) {
        const id = resolve(x.person);
        if (!id || !canRemember(id) || !String(x.text ?? '').trim()) continue;
        await keepShared({ id, name: x.person, kind: x.kind === 'joke' ? 'inside joke' : 'shared moment', text: String(x.text).trim().slice(0, 240) });
        done.shared++;
      }
      for (const x of list(r, 'treats_me').slice(0, 4)) {
        const id = resolve(x.person);
        if (!id || !canRemember(id) || !String(x.text ?? '').trim()) continue;
        s.treats[id] = { name: x.person, text: String(x.text).trim().slice(0, 200), at: now() };
        done.treats++;
      }
      for (const x of list(r, 'opinions').slice(0, 4)) if (await holdOpinion(x.topic, x.stance)) done.opinions++;
      s.lastAt = Math.max(s.lastAt, ...chunk.map((l) => l.created_at ?? 0));
      done.lines += chunk.length;
      save();
    }
    return done;
  }

  return {
    // Falling asleep sets it off; one at a time.
    fellAsleep(opts) { running ??= goBackOver(opts).finally(() => { running = null; }); return running; },
    holdOpinion,
    treats: (id) => s.treats[id] ?? null,
    opinions: () => s.opinions.map(({ vec, ...o }) => o),
    // For her prompt: how the people here treat her, and her own opinions on what's being talked about.
    // (No ids or query: nothing.)
    promptSection(query, { ids = [] } = {}) {
      const treats = ids.map((id) => s.treats[id]).filter(Boolean).map((t) => `- How ${t.name} treats you: ${t.text}`);
      const mine = query ? s.opinions.map((o) => ({ o, score: cosine(query, o.vec) })).filter((x) => x.score >= 0.55).sort((a, b) => b.score - a.score).slice(0, 3)
        .map(({ o }) => `- You think ${o.topic}: ${o.stance}${o.previous?.length ? ` (you used to think: ${o.previous.at(-1).stance})` : ''}`) : [];
      return [...treats, ...mine].join('\n');
    },
  };
}

// Hers, built on first use from her memory (so tests of createSleepOnIt never open her database).
let shared = null;
export function sleepOnIt() {
  shared ??= Promise.all([import('./memory.js'), import('./contacts.js')]).then(([{ messagesSince, graph }, { permissions }]) => createSleepOnIt({
    messages: (since, limit) => messagesSince(since, limit),
    resolve: (n) => { const id = graph.resolve(n); return id && id !== 'self' ? id : null; },
    canRemember: (id) => /^\d+$/.test(id) && permissions(id).remember,
    keepShared: ({ id, kind, text }) => graph.addFacts([{ name: id, type: 'person', text: `${kind} with you: ${text}`, saidBy: '', place: 'while going back over your day' }]),
  }));
  return shared;
}

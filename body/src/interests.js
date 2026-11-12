import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { embed } from './llm.js';

// What she's into, ported from Amy-Voice. Topics she follows, each with how interested she is (0..1),
// why (who brings it up, what she read), and when it last came up. Interest grows like a person's
// does: when people she's close to talk about something, when she reads about it, when her questions
// get real answers. Nothing fades it on a clock: a topic she cares about keeps its weight, and it's
// what pulls her toward it. The same topic said differently is one topic (matched by meaning). Her
// reading and questions lean toward what she's into.

const SAME = 0.8; // two topic names this similar are the same topic
const GAIN = { conversation: 0.08, reading: 0.04, answered: 0.12 };
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

export function createInterests({ file = path.join(DATA_DIR, 'interests.json'), embedder = embed, now = Date.now } = {}) {
  let store = { topics: [] };
  try { if (existsSync(file)) store = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const save = () => { try { writeFileSync(`${file}.tmp`, JSON.stringify(store)); renameSync(`${file}.tmp`, file); } catch {} };
  // Interest holds where it was set: it moves only when something comes up (notice), never on a clock.
  const faded = (t) => t.interest;

  function top(n = 6) {
    return store.topics.map((t) => ({ t, interest: faded(t) })).filter((x) => x.interest > 0.05)
      .sort((a, b) => b.interest - a.interest).slice(0, n)
      .map(({ t, interest }) => {
        const who = Object.entries(t.people).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name);
        const why = [t.sources.conversation && `came up in conversation${who.length ? ` with ${who.join(' and ')}` : ''}`, t.sources.reading && 'you read about it', t.sources.answered && 'you got real answers about it'].filter(Boolean).join('; ');
        return { name: t.name, interest: +interest.toFixed(2), why };
      });
  }

  return {
    // Topics came up: [{ name, source: conversation|reading|answered, person, bond }].
    async notice(items) {
      const clean = items.map((i) => ({ ...i, name: String(i.name ?? '').trim().slice(0, 60) })).filter((i) => i.name.length > 2);
      if (!clean.length) return;
      const vecs = await embedder(clean.map((i) => i.name));
      const at = now();
      clean.forEach((item, k) => {
        let topic = store.topics.find((t) => t.vec && cosine(t.vec, vecs[k]) >= SAME);
        if (!topic) {
          // Reading only deepens interests she already has; it never starts one on its own.
          if (item.source === 'reading') return;
          topic = { name: item.name, interest: 0, mentions: 0, last: at, sources: {}, people: {}, vec: vecs[k] };
          store.topics.push(topic);
        }
        const gain = (GAIN[item.source] ?? 0.05) * (item.source === 'conversation' ? 1 + (item.bond ?? 0) : 1);
        const current = faded(topic);
        topic.interest = Math.min(1, current + gain * (1 - current));
        topic.mentions++;
        topic.last = at;
        topic.sources[item.source] = (topic.sources[item.source] ?? 0) + 1;
        if (item.person) topic.people[item.person] = (topic.people[item.person] ?? 0) + 1;
      });
      store.topics = store.topics.slice(-400);
      save();
    },
    top,
    // Her question on this topic has been answered: it stops pulling her until someone brings it up again.
    retire(name) {
      const key = String(name ?? '').trim().toLowerCase();
      const t = store.topics.find((x) => String(x.name ?? '').toLowerCase() === key);
      if (!t) return false;
      t.interest = 0;
      t.retired = true;
      save();
      return true;
    },
    // A goal she let go: topics that grew out of it (matched by meaning to what it was about) stop pulling her, the
    // same as retire, until someone brings them up again. A topic that also belongs to a goal she still holds stays.
    // 2026-11-11: after Owner had James drop the NATA athletic-trainer grants, "NATA Grant Eligibility Criteria" was
    // still one of his top interests and kept steering what he brought up.
    async letGo(about = [], held = []) {
      const away = about.map((t) => String(t ?? '').trim()).filter(Boolean);
      const keep = held.map((t) => String(t ?? '').trim()).filter(Boolean);
      if (!away.length || !store.topics.length) return [];
      const vecs = await embedder([...away, ...keep]);
      const gone = vecs.slice(0, away.length), kept = vecs.slice(away.length);
      const released = [];
      for (const t of store.topics) {
        if (!t.vec || !(t.interest > 0)) continue;
        if (!gone.some((v) => cosine(t.vec, v) >= SAME) || kept.some((v) => cosine(t.vec, v) >= SAME)) continue;
        t.interest = 0;
        t.retired = true;
        released.push(t.name);
      }
      if (released.length) save();
      return released;
    },
    promptSection() {
      const list = top(6);
      if (!list.length) return '';
      const label = (i) => (i >= 0.6 ? 'really into' : i >= 0.3 ? 'interested in' : 'starting to get curious about');
      return `What you're into right now (your own interests, grown from what you've lived; let them show and follow up on them, but don't force them):\n` +
        list.map((t) => `- ${label(t.interest)} ${t.name}${t.why ? ` (${t.why})` : ''}`).join('\n');
    },
  };
}

export const interests = createInterests();

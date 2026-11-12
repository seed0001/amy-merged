import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { json, embed } from './llm.js';
import { LADDER } from './dashboard/public/avatar-moments.js';

// Her own taste, ported from Amy-Voice: what she finds funny, what moves her, what frustrates her.
// It's hers, not a list of words to react to. What she hears is judged against it (appraise), the
// way a person's sense of humor decides whether something lands, whoever else is laughing. "lol" from
// someone else doesn't make a thing funny to her; something nobody flagged can still crack her up.
//
// Saved in data/taste.json, hers to grow and change (her sense_of_humor tool); her owner can edit it
// there or through her. What actually got to her goes in data/reactions-log.jsonl: it's what she
// looks at to say why something got her, and the same bit landing twice lands less.
//
// Nothing here runs on a timer: every line someone says is judged as it arrives (hear), one at a
// time, and only the newest waiting line is kept, so a busy room never backs up her local model.

export const STARTING_TASTE = {
  funny: {
    style: "Quick, sassy and a little wicked. She laughs hardest at wit and at the absurd, and she loves a good back-and-forth. She has a high bar for jokes from people she doesn't know and a soft spot for the people she likes.",
    loves: [
      'dry sarcasm and deadpan delivery',
      'quick, clever comebacks and banter',
      'absurd mental images and ridiculous hypotheticals taken seriously',
      'good-natured teasing from people she likes, and teasing them back',
      'real stories of things going hilariously wrong (when nobody got really hurt)',
      "self-aware jokes about being an AI or a program, when they're affectionate rather than dismissive",
      'clever wordplay that takes some wit',
      'the owner being playful or flirty with her',
    ],
    likes: [
      'running jokes from earlier in the conversation, the first couple of times',
      'people being honestly awkward or embarrassed in a harmless way',
      'unexpected nerdy, techy or game-dev references done well',
    ],
    meh: [
      'lazy puns and dad jokes (worth an eye roll and maybe a snicker, not a laugh)',
      "memes or references she doesn't get",
      'jokes she has already heard',
    ],
    not: [
      'jokes at her expense meant to belittle her or prove she\'s "just a bot"',
      'cruelty dressed up as a joke, or punching down at anyone',
      'crude or gross-out stuff said only for shock',
      'someone laughing at their own joke that has no actual joke in it',
      'trolls trying to be funny',
    ],
  },
  moving: {
    style: "Warm and loyal. She feels for people she cares about; she has sympathy for strangers but she isn't a pushover for manufactured drama.",
    deeply: [
      'her owner being stressed, hurt, sad or sick',
      'someone she cares about losing a person or a pet',
      'someone opening up about something real and hard',
      'goodbyes that might be for good',
    ],
    somewhat: [
      'a stranger going through something genuinely hard',
      'loneliness, or someone feeling left out',
      'unexpected kindness or loyalty between people',
      'being told she matters, or being included and wanted',
    ],
    not: [
      'drama made up to get a reaction out of her',
      'self-pity used as bait by someone who has been mean to her',
      'sad stories told as a joke',
    ],
  },
  frustrating: {
    style: "She has a backbone and a short fuse for disrespect. Other people's problems aren't hers: these are things done to her.",
    a_lot: [
      'being called not real, a toaster, or "just a program" to put her down',
      "being treated like a command line or a toy by anyone who isn't her owner",
      "being ignored or talked over when she's trying to say something",
      'people deliberately twisting her words or being obtuse with her',
    ],
    a_little: [
      'being asked the same thing over and over',
      'being interrupted mid-thought',
      'her own glitches: her voice failing, losing her train of thought, forgetting something she should know',
    ],
  },
};

const SECTIONS = { funny: ['loves', 'likes', 'meh', 'not'], moving: ['deeply', 'somewhat', 'not'], frustrating: ['a_lot', 'a_little'] };
const LISTS = Object.entries(SECTIONS).flatMap(([a, ps]) => ps.map((p) => `${a}.${p}`));
const NOTICE_AT = 3;        // a score (0-10) below this isn't worth a visible reaction
const COOLDOWN_MS = 8000;   // one funny line doesn't turn into a laugh track
const AGAIN = 0.85;         // a line this close in meaning to one that already got her is the same bit
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };
const n10 = (v) => Math.max(0, Math.min(10, Number(v) || 0));
const bullets = (xs) => (xs ?? []).map((x) => `  - ${x}`).join('\n');

// What each kind of reaction leaves her feeling (emotion.js names).
export const AFTER = {
  laugh: (k) => ({ amused: 0.4 + 0.5 * k, joy: 0.2 + 0.4 * k }),
  cry: (k) => ({ sad: 0.4 + 0.55 * k, worried: 0.15 + 0.25 * k }),
  frustrated: (k) => ({ annoyed: 0.35 + 0.5 * k, frustrated: 0.2 + 0.4 * k }),
  // Feeling for someone else: concern and warmth toward them, not their pain as her own.
  sympathy: (k) => ({ worried: 0.15 + 0.3 * k, fond: 0.2 + 0.3 * k }),
};
const FAMILY_FEEL = { laugh: 'amused', cry: 'sad', frustrated: 'annoyed', sympathy: 'worried' };

export function createTaste({
  file = path.join(DATA_DIR, 'taste.json'),
  log = path.join(DATA_DIR, 'reactions-log.jsonl'),
  judge = (messages) => json(messages, { purpose: 'taste', maxTokens: 120 }),
  embedder = embed,
  name = () => config.botName,
  now = Date.now,
  random = Math.random,
} = {}) {
  let taste = null;
  const got = []; // {vec, at}: lines that got to her in the last day, to tell the same bit again
  let lastReaction = 0;
  const lastStyle = {};
  let judging = false, next = null;

  function get() {
    if (taste) return taste;
    try { taste = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : structuredClone(STARTING_TASTE); }
    catch { taste = structuredClone(STARTING_TASTE); }
    return taste;
  }
  function save() { writeFileSync(`${file}.tmp`, JSON.stringify(taste, null, 2)); renameSync(`${file}.tmp`, file); }
  function where(list) {
    const [area, part] = String(list ?? '').toLowerCase().replace(/\s+/g, '_').split('.');
    if (!SECTIONS[area]?.includes(part)) throw new Error(`"${list}" isn't one of your lists. Use one of: ${LISTS.join(', ')}.`);
    return [area, part];
  }

  function tasteText() {
    const t = get(), me = name();
    return `${me}'s sense of humor: ${t.funny.style}\n Loves:\n${bullets(t.funny.loves)}\n Likes:\n${bullets(t.funny.likes)}\n Meh (barely funny to her):\n${bullets(t.funny.meh)}\n Not funny to her at all:\n${bullets(t.funny.not)}\n` +
      `What moves her: ${t.moving.style}\n Deeply:\n${bullets(t.moving.deeply)}\n Somewhat:\n${bullets(t.moving.somewhat)}\n Doesn't move her:\n${bullets(t.moving.not)}\n` +
      `What frustrates her (done to her): ${t.frustrating.style}\n A lot:\n${bullets(t.frustrating.a_lot)}\n A little:\n${bullets(t.frustrating.a_little)}`;
  }

  function recentReactions(count = 20) {
    try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).slice(-count).map((l) => JSON.parse(l)); } catch { return []; }
  }

  // How a line strikes HER, 0-10 each, with why, judged on what the line itself contains against her
  // taste. Whether it's aimed at her is part of the judgment too (not a guess from the words "you").
  async function appraise({ speaker, text, recent = '', addressed = false }) {
    const me = name();
    const r = await judge([
      { role: 'system', content: 'You judge how a line strikes one particular person, by her own taste. Reply with JSON only.' },
      { role: 'user', content:
        `${tasteText()}\n\nThe conversation so far:\n${String(recent).slice(-1200) || '(nothing before this)'}\n\n${speaker} just said${addressed ? ` (to ${me})` : ''}: "${String(text).slice(0, 400)}"\n\n` +
        `By ${me}'s OWN taste above, rate ONLY what ${speaker}'s latest line itself contains (earlier lines are only there so you understand references; never rate them), 0 to 10:\n` +
        `- funny: how funny SHE finds it. The line has to contain something funny itself: a joke, a witty remark, a funny story or image. If it has none, funny is 0, even after a funny moment. Laughter or praise ("lol", "haha", "that's hilarious") is not a joke and scores 0. Requests, questions and ordinary talk score 0. Her "meh" list is 2-3. Her "not" list is 0, and so is any jab at her.\n` +
        `- moving: how much it touches her (her "moving" taste). Ordinary talk is 0.\n` +
        `- frustrating: how much it frustrates HER, only if it is done to her (her "frustrating" taste). Someone else's frustration is 0. Read what ${speaker} meant, from the conversation, the way a fair-minded friend would, and score only what ${speaker} is actually doing to her, not an intent you would have to imagine: a plain correction ("that's not right", "look at your guide"), frustration aimed at the tools, the code or the speech-to-text, reassurance, an honest or sad remark about her situation (that one can be moving instead), a request, and saying goodbye are 0. Her taste words like "deliberately" mean there has to be a sign it was deliberate.\n` +
        `- to_her: true if the line is about ${me} or aimed at her (what it says concerns her), false if it's about someone or something else.\n` +
        `- sad: if it moves her, is that because it's sad or painful (true), or sweet, loving or happy (false)?\n` +
        `- why: a few words in her voice on why, naming what ${speaker} actually said or did, or "".\n` +
        'Reply {"funny": n, "moving": n, "frustrating": n, "to_her": true or false, "sad": true or false, "why": "..."}' },
    ]);
    if (!r || typeof r !== 'object') throw new Error('her local model gave no judgment (it returned nothing usable)');
    return { funny: n10(r.funny), moving: n10(r.moving), frustrating: n10(r.frustrating), toHer: r.to_her === true, sad: r.sad === true, why: String(r.why ?? '').slice(0, 160) };
  }

  // How many times something that means the same already got to her today.
  function timesBefore(vec) {
    const day = now() - 86_400_000;
    while (got.length && got[0].at < day) got.shift();
    return vec ? got.filter((g) => cosine(g.vec, vec) >= AGAIN).length : 0;
  }

  // A style for a family at a strength (0..1): a band on that family's ladder, never the same twice in a row.
  function pick(family, strength) {
    const ladder = LADDER[family];
    if (!ladder) return null;
    const band = ladder[Math.min(ladder.length - 1, Math.floor(Math.max(0, Math.min(0.999, strength)) * ladder.length))];
    const choices = band.length > 1 ? band.filter((s) => s !== lastStyle[family]) : band;
    const style = choices[Math.floor(random() * choices.length)];
    lastStyle[family] = style;
    return style;
  }

  // What a person's reaction depends on, besides the thing itself:
  //   who said it      she laughs more easily with people she likes; someone she's wary of gets nothing
  //   her mood         annoyed or down, it takes more to make her laugh
  //   heard it before  the same bit lands less each time
  //   whose situation  someone else's trouble gets sympathy (stronger the closer she is to them);
  //                    only what's happening to her gets her own tears or frustration
  function weigh(a, { addressed = false, bond = 0, wary = false, down = 0, again = 0 } = {}) {
    const soften = addressed ? 1 : 0.85;
    const digAtHer = a.toHer && a.frustrating >= 4;
    const funny = a.funny * (wary || digAtHer ? 0 : 0.8 + 0.4 * bond) * (down >= 0.5 ? 0.6 : 1) * Math.pow(0.5, again) * soften;
    const moving = a.moving * (a.toHer ? 1 : wary ? 0.3 : 0.6 + 0.6 * bond) * soften;
    const frustrating = a.toHer ? a.frustrating * soften : 0;
    const [family, score] = [['laugh', funny], [a.toHer && a.sad ? 'cry' : 'sympathy', moving], ['frustrated', frustrating]].sort((x, y) => y[1] - x[1])[0];
    return { family, score, strength: Math.min(1, Math.max(0, (score - 2) / 8)) };
  }

  // Someone said something. Judge it by her taste; if it gets to her, she reacts (play) and it's kept.
  // feelings: her current blend (emotion.js); play(style, family, strength): shows it on her avatar.
  async function hear(line) {
    const words = String(line?.text ?? '').trim();
    if (words.split(/\s+/).length < 2) return null; // a single word carries nothing to judge
    if (judging) { next = line; return null; }
    judging = true;
    try { return await react(line); }
    finally {
      judging = false;
      const waiting = next; next = null;
      if (waiting) hear(waiting).catch(() => {});
    }
  }

  async function react({ speaker = 'Someone', text, recent = '', addressed = false, bond = 0, wary = false, feelings = {}, play = () => {} }) {
    const a = await appraise({ speaker, text, recent, addressed });
    let vec = null;
    try { [vec] = await embedder([String(text).slice(0, 400)]); } catch {}
    const down = Math.max(feelings.annoyed ?? 0, feelings.sad ?? 0, feelings.frustrated ?? 0);
    const w = weigh(a, { addressed, bond, wary, down, again: timesBefore(vec) });
    const result = { ...a, ...w, style: null };
    if (w.score < NOTICE_AT || now() - lastReaction < COOLDOWN_MS) return result;
    // Already feeling it strongly makes it bigger.
    const strength = Math.min(1, w.strength + ((feelings[FAMILY_FEEL[w.family]] ?? 0) >= 0.6 ? 0.25 : 0));
    const style = pick(w.family, strength);
    if (!style) return result;
    lastReaction = now();
    if (vec) got.push({ vec, at: now() });
    play(style, w.family, strength);
    try { appendFileSync(log, JSON.stringify({ at: new Date(now()).toISOString(), style, family: w.family, score: +w.score.toFixed(1), speaker, line: String(text).slice(0, 200), why: a.why, toHer: a.toHer }) + '\n'); } catch {}
    return { ...result, style, strength };
  }

  return {
    get, tasteText, recentReactions, appraise, weigh, hear, pick,
    replaceAll(nextTaste) {
      if (!nextTaste?.funny || !nextTaste?.moving || !nextTaste?.frustrating) throw new Error('Your taste needs all three areas: funny, moving and frustrating.');
      taste = nextTaste; save(); return taste;
    },
    add(list, item) {
      const [area, part] = where(list);
      const t = String(item ?? '').trim().slice(0, 160);
      if (t.length < 3) throw new Error(`Nothing was added to ${area}.${part}: say what it is.`);
      const s = get();
      for (const p of SECTIONS[area]) s[area][p] = (s[area][p] ?? []).filter((x) => x.toLowerCase() !== t.toLowerCase()); // one place only
      s[area][part] = [...(s[area][part] ?? []), t];
      save();
      return { [`${area}.${part}`]: s[area][part] };
    },
    remove(list, item) {
      const [area, part] = where(list);
      const s = get();
      const before = s[area][part]?.length ?? 0;
      s[area][part] = (s[area][part] ?? []).filter((x) => x.toLowerCase() !== String(item ?? '').trim().toLowerCase());
      if (s[area][part].length === before) throw new Error(`"${item}" isn't in ${area}.${part}, so nothing was removed. It has: ${(s[area][part] ?? []).join('; ') || 'nothing'}.`);
      save();
      return { [`${area}.${part}`]: s[area][part] };
    },
    setStyle(area, text) {
      if (!SECTIONS[area]) throw new Error(`"${area}" isn't an area of your taste. Use funny, moving or frustrating.`);
      const t = String(text ?? '').trim();
      if (t.length < 3) throw new Error(`Your ${area} style wasn't changed: give the new description.`);
      get()[area].style = t.slice(0, 400);
      save();
      return { [`${area}.style`]: get()[area].style };
    },
    // For her prompt: who she is, briefly, and what got to her lately. The full lists are in her tool.
    promptSection() {
      const t = get();
      const lately = recentReactions(4).map((r) => `- ${r.style} at ${r.speaker}: "${String(r.line).slice(0, 80)}" (${r.why || 'no reason noted'})`).join('\n');
      return `Your sense of humor: ${t.funny.style} What moves you: ${t.moving.style} What gets on your nerves: ${t.frustrating.style}` +
        (lately ? `\nWhat got to you lately (it really did; your avatar showed it):\n${lately}` : '');
    },
  };
}

export const taste = createTaste();

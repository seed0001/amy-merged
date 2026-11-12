import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { activity } from './events.js';
import { promptMessages } from './prompts.js';
import { findContact, remember } from './memory.js';
import { isOwner, tierOf } from './contacts.js';
import { sleep } from './sleep.js';

// Her intuition: a local model reading the lines she hears, one at a time, free. Every text channel on
// the server and every voice call reaches it, whether or not a line was said to her, so she always has
// a feel for what's going on. It never speaks and never acts. It gives her a gut read that rides along
// in her replies, keeps what's worth remembering, and flags two rare things. Someone really going after
// her owner or her: a calm referee on the local model looks at the moment, and only if it agrees does
// she step in. Someone rambling while the room checks out: she slips in a sly question or redirect to
// move things along, and never lets on. A flag is never an order: she words it all herself.
//
// How much it reads is her pressure's call, not a clock's. A line said to her is always read. A line
// she only overheard is read when something is pulling at her (her stance, from pressure.js: curious,
// uneasy, left out, watchful...); settled, she hears it and lets it go. When the local model is down or
// slow the reads stop quietly and come back on their own: one error in the log per outage, not one a
// minute, and nothing waits on it.
//
// What it's told is the 'intuition' prompt: she can read and rewrite it with her prompts tool, and the
// live context (the whole server lately, this channel, her mood) is added fresh to every read.

const STEP_IN_EVERY_MS = 45_000; // she steps in hard, but she doesn't heckle every line of an argument
const REDIRECT_EVERY_MS = 3 * 60_000; // her secret weapon only works if nobody notices it
const FLOOR_LINES = 4, FLOOR_OF = 6, FLOOR_MS = 60_000; // really holding the floor: most of the last lines, for a while
const MIN_PROOF_WORDS = 3;
const LINES_KEPT = 60;      // the server's recent lines, across every channel and call
const READS_KEPT = 30;
const SHOWN_MS = 30 * 60_000; // how long a line or a read stays in her head
const READ_TIMEOUT_MS = 20_000; // a gut read that takes longer than this is no use to anyone; the line is let go
export const BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000]; // after a failed read: wait this long before trying again, longer each time

// What the intuition model is told changes with her pressure (stance.js): the same levels that make her
// want things decide what she listens for in a line and what she must not read into it. Calm, it reads
// plainly and says nothing on most lines; curious, it listens for gaps; on edge, it checks itself.
const SYSTEM = (stanceText = '') => `You are ${config.botName}'s intuition, the part of her that picks up on things before she thinks about them. You read one line from the Discord server she runs and tell her what your gut says, in plain words, honest and specific. Reply with JSON only: {"gut":"","facts":[{"about":"name","fact":"short sentence","evidence":"their exact words"}],"defend":false,"quote":"","why":"","rambling":false,"point":""}
${stanceText ? `${stanceText}\n` : ''}gut: one short sentence to her about what is going on under the line, as someone who is listening to this person, not sizing them up: what they mean, what they feel, what they are asking for, what is left unsaid. Never the same read twice in a row about the same person. Empty if there's nothing there, which is most lines.
facts: almost always empty. "about" must be a person, never a place or thing. Only something still true next month about a person's life: family, job, where they live, what they own, what they've built. Never what they are doing, feeling, focused on or asking right now: that is the gut, not a fact. "evidence" is the exact words from the line that state it; a fact with no such words is dropped.
defend: true only if someone is clearly trolling, attacking or belittling her, her owner, or her owner's work. This is rare. The people here are friends: ribbing, teasing, jokes, honest questions and honest criticism are not attacks.
quote: if defend is true, the exact words from the line that crossed the line. Otherwise empty.
why: if defend is true, one specific sentence saying what they attacked and how. Otherwise empty.
rambling: true only if this person has been going on and on without getting to the point and the others have checked out: going in circles, piling on detail nobody asked for, nobody really responding. A long story people are enjoying, a real explanation, or an actual back-and-forth is false.
point: if rambling is true, what they seem to be trying to say or the most useful thread in it, in a few words. Otherwise empty.`;

// The local model, directly: it reads everything, so it has to be free and private.
async function askLocal(messages) {
  const { localFirst, thinkText } = await import('./llm.js');
  const cloud = (model) => thinkText(messages, { json: true, maxTokens: 260, temperature: 0.1, purpose: 'intuition', timeoutMs: READ_TIMEOUT_MS, model });
  // Her thinking on OpenRouter (config.cognition): the line reads go there too.
  if (config.cognition.provider === 'openrouter') return cloud(undefined);
  return localFirst(() => askOllama(messages), cloud, 'intuition'); // the cheap cloud model while Ollama is down (llm.js)
}
async function askOllama(messages) {
  const res = await fetch(`${config.ollama.host}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    body: JSON.stringify({ model: config.intuition.model, messages, stream: false, think: false, format: 'json', keep_alive: '24h', options: { num_ctx: config.ollama.numCtx, temperature: 0.1, num_predict: 260 } }), // the same num_ctx as her other local calls, or Ollama waits to reload the model
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return (await res.json()).message?.content ?? '';
}
async function askReferee(messages) {
  const { json } = await import('./llm.js');
  return json(messages);
}
async function moodNow() {
  const pressure = await import('./pressure.js');
  return pressure.moodLine(null, { coaching: false });
}
// Her stance toward this speaker (pressure.js -> stance.js): what to listen for, what not to invent,
// and whether anything is pulling at her at all (calm: nothing above the floor).
async function stanceNow(speaker) {
  const pressure = await import('./pressure.js');
  const s = pressure.stanceFor(speaker?.id ?? null, speaker?.name ?? null);
  return { text: s.intuition, calm: s.calm === true };
}

// Her own tuning of how her intuition reads (intuition-tune.js writes it; read fresh for every read).
export const TUNING_FILE = path.join(DATA_DIR, 'intuition-tuning.json');
function ownTuning() {
  try { return existsSync(TUNING_FILE) ? String(JSON.parse(readFileSync(TUNING_FILE, 'utf8')).instructions ?? '').trim() : ''; } catch { return ''; }
}

const plain = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// A proof has to be real words from the line, not the model's say-so.
const quoted = (proof, evidence) => String(proof ?? '').split(/\.{3}|…/)
  .some((part) => plain(part).split(' ').length >= MIN_PROOF_WORDS && plain(evidence).includes(plain(part)));
const parse = (raw) => { try { return JSON.parse(String(raw).slice(String(raw).indexOf('{'), String(raw).lastIndexOf('}') + 1)); } catch { return {}; } };
// Two reads that share most of their words are one read said twice.
const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'for', 'his', 'her', 'she', 'he', 'they', 'you', 'your', 'about', 'not', 'but', 'just', 'its', 'has', 'have', 'was', 'are', 'is']);
const bag = (s) => new Set(plain(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
export function sameRead(a, b) {
  const x = bag(a), y = bag(b);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size) >= 0.6;
}
const ago = (ms) => (ms < 60_000 ? 'just now' : `${Math.round(ms / 60_000)} min ago`);
// What went wrong with a read, in words that say what to do about it.
const explain = (err) => /timeout|aborted/i.test(err?.name ?? '') || /timed? ?out|abort/i.test(err?.message ?? '')
  ? `the local model (${config.intuition.model}) took longer than ${READ_TIMEOUT_MS / 1000}s to read a line; it is overloaded or still loading. Fix: a smaller intuition model, or less running on the GPU at once`
  : /ECONNREFUSED|fetch failed/i.test(err?.message ?? '')
    ? `Ollama at ${config.ollama.host} isn't answering. Fix: start Ollama (start.bat does), or correct OLLAMA_HOST`
    : `${err?.message ?? err}. Fix: check that Ollama is up and the intuition model (${config.intuition.model}) is pulled`;

// The second look at one fact before it becomes a memory: { keep, about, fact, why }. On the local model.
export async function vetFact({ speaker, place, line, about, fact }) {
  const { json } = await import('./llm.js');
  return json([
    { role: 'system', content: `You decide whether one thing becomes a lasting memory about a person, for ${config.botName}, who keeps memories about the people she knows. Keep it only if it is about a real person's own life and still true next month: family, work, where they live, what they own or have made, what they're building, what they care about. Don't keep what they are doing, asking, feeling, noticing or focused on right now; a reaction to this moment; something about ${config.botName} herself; or something about a character, a story, a plot, a hypothetical or a joke (if it's about a story or project they make, it's a fact about them making it, not about the character). "about" is the real person it is about (it may not be the one first named). If you keep it, rewrite it as one plain sentence that names that person, with no "he", "she" or "you" standing in for a name. Reply with JSON only: {"keep":false,"about":"","fact":"","why":"a few words"}` },
    { role: 'user', content: `${speaker} said in ${place}: "${String(line).slice(0, 400)}"\nThe fact to check, about ${about}: ${fact}` },
  ], { purpose: 'intuition_fact', maxTokens: 200 });
}

export function createIntuition({
  ask = askLocal, referee = askReferee, mood = moodNow, stance = stanceNow, keep = remember, contact = findContact,
  friend = (id) => tierOf(id) === 'friend', owner = isOwner, resting = () => sleep.sleeping(), now = Date.now, log = activity,
  tuning = ownTuning,
  // A fact the read wants to keep gets a second, focused look before it's kept (vetFact below).
  vet = vetFact,
} = {}) {
  const lines = []; // { at, place, conversation, who, text }
  const reads = []; // { at, place, who, gut }
  const lastStepIn = new Map(), lastRedirect = new Map();
  let queue = Promise.resolve(), waiting = 0;
  // The local model's health: after a failed read, no reads until downUntil; failures counts the run.
  let downUntil = 0, failures = 0, skipped = 0, repeats = 0;

  const hear = (entry) => { lines.push({ at: now(), ...entry }); lines.splice(0, Math.max(0, lines.length - LINES_KEPT)); };
  const fresh = (list) => list.filter((x) => now() - x.at < SHOWN_MS);
  const show = (l) => `[${l.place}, ${ago(now() - l.at)}] ${l.who}: ${String(l.text).slice(0, 200)}`;
  const down = () => now() < downUntil;

  // A read failed: back off, longer each time in a row, and say so once per outage, with the fix.
  function failed(err) {
    failures++;
    downUntil = now() + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    if (failures === 1) log('error', { where: 'intuition', message: `gut reads paused: ${explain(err)}. They resume on their own; lines are still heard in the meantime.` });
  }
  function recovered() {
    if (failures) log('intuition', { recovered: true, after_failures: failures, lines_let_go: skipped });
    failures = 0; skipped = 0;
  }

  // The stance decides the read: what to listen for, and whether to read an overheard line at all.
  async function lens(speaker) {
    const s = await stance(speaker).catch(() => '');
    return typeof s === 'string' ? { text: s, calm: false } : { text: s?.text ?? '', calm: s?.calm === true };
  }

  async function scan({ conversation, place, speaker, text }, { text: stanceText }) {
    const here = fresh(lines).filter((l) => l.conversation === conversation).slice(-7, -1);
    const elsewhere = fresh(lines).filter((l) => l.conversation !== conversation).slice(-10);
    const feeling = await mood().catch(() => '');
    let raw = '';
    try {
      const own = tuning();
      raw = await ask(promptMessages('intuition', [
        { role: 'system', content: SYSTEM(stanceText) + (own ? `\nHow ${config.botName} wants you to read lines (her own tuning, from looking back at what was useful): ${own}` : '') },
        { role: 'user', content:
          `${elsewhere.length ? `Elsewhere on the server lately:\n${elsewhere.map(show).join('\n')}\n\n` : ''}` +
          `${here.length ? `Recent lines in ${place}:\n${here.map(show).join('\n')}\n\n` : ''}` +
          `${feeling ? `How she feels: ${feeling}\n\n` : ''}${speaker.name} just said in ${place}: ${text}` },
      ]));
      recovered();
    } catch (err) { failed(err); return {}; }
    const read = parse(raw);
    let gut = typeof read.gut === 'string' ? read.gut.trim().slice(0, 240) : '';
    // The same read again about the same person is the model stuck in a groove, not a new feeling.
    const lastAbout = [...reads].reverse().find((r) => r.who === speaker.name);
    if (gut && lastAbout && sameRead(lastAbout.gut, gut)) { log('intuition', { place, about: speaker.name, repeated: gut }); repeats++; gut = ''; }
    if (gut) {
      // The line it read is kept with it, so she can later look back at whether the read was any use.
      reads.push({ at: now(), place, who: speaker.name, gut, conversation, line: String(text).slice(0, 240) });
      reads.splice(0, Math.max(0, reads.length - READS_KEPT));
      log('intuition', { place, about: speaker.name, gut });
    }
    for (const f of Array.isArray(read.facts) ? read.facts.slice(0, 3) : []) {
      // Grounded in the line itself (their words, quoted), like every fact she keeps.
      if (!f?.about || !f?.fact || !quoted(f.evidence, text)) continue;
      // The read is one quick pass doing many jobs, and the small model files what someone is doing or asking
      // right now ("he is currently asking you…"), or a character in a story they're telling, as a fact about
      // them. A second look, on just this fact, decides: is it lasting, who is it truly about, and it's
      // rewritten to name them (Owner, 2026-11-10: "make sure she is saving the correct person to the correct area").
      let v = null;
      try { v = await vet({ speaker: speaker.name, place, line: text, about: String(f.about), fact: String(f.fact) }); }
      catch (err) { log('error', { where: 'intuition fact', message: `A fact about ${f.about} wasn't kept: checking it failed (${err.message}). Nothing wrong was saved.` }); continue; }
      if (!v?.keep || !String(v.fact ?? '').trim()) { log('intuition', { place, about: String(f.about), factDropped: String(f.fact).slice(0, 160), why: String(v?.why ?? '').slice(0, 160) }); continue; }
      const person = contact(String(v.about || f.about));
      if (!person) { log('intuition', { place, about: String(v.about || f.about), factDropped: String(v.fact).slice(0, 160), why: 'not someone she knows' }); continue; }
      // Tagged with who said it and where, like every line she keeps.
      await keep(person.user_id, [`${speaker.name} said in ${place}: ${String(v.fact).trim().slice(0, 240)}`]).catch(() => {});
    }
    const clear = read.defend === true && !owner(speaker.id) && !friend(speaker.id) && quoted(read.quote, text) && Boolean(plain(read.why));
    return {
      troll: clear ? { quote: String(read.quote).trim(), why: String(read.why).trim() } : null,
      rambling: read.rambling === true && !owner(speaker.id) && holdingFloor(conversation, speaker.name) ? String(read.point ?? '').trim().slice(0, 160) || 'what they mean' : null,
    };
  }

  // The model says they're rambling; the count says it isn't one long sentence or a two-way talk.
  function holdingFloor(conversation, name) {
    const last = lines.filter((l) => l.conversation === conversation).slice(-FLOOR_OF);
    const theirs = last.filter((l) => l.who === name);
    return theirs.length >= FLOOR_LINES && now() - theirs[0].at >= FLOOR_MS;
  }

  // A cold read of the moment. It doesn't get her persona, because a judge told to be ruthless finds
  // a reason to be. Unsure means she stays out of it.
  async function warranted({ conversation, speaker, text }) {
    const recent = fresh(lines).filter((l) => l.conversation === conversation).slice(-10).map((l) => `${l.who}: ${String(l.text).slice(0, 200)}`).join('\n');
    const read = await referee([
      { role: 'system', content: `You are a calm referee for a Discord server of friends. A bot called ${config.botName} wants to speak up uninvited because someone may have attacked her or her owner's work. The default is no. Jokes, banter, teasing and honest criticism are a no. Reply with JSON only: {"hostile":false,"why":""}` },
      { role: 'user', content: `Recent lines:\n${recent}\n\n${speaker.name} just said: ${text}` },
    ]).catch((err) => { log('error', { where: 'intuition referee', message: err.message }); return null; });
    return read?.hostile === true;
  }

  return {
    // Reads a line. Resolves to a cue if she should step in, or null, which is nearly always.
    async notice(heard) {
      const { conversation, place, speaker, text, answering = false } = heard;
      if (!String(text ?? '').trim()) return null;
      hear({ conversation, place, who: speaker.name, text });
      if (plain(text).split(' ').length < 3) return null;
      if (down()) { skipped++; return null; } // the model is down: heard, not read, and no error a minute
      waiting++; // counted from here, so a flood can't all slip past the cap while the stance is looked up
      // An overheard line is read when her pressure has her listening for something; settled, she lets it go.
      const stanceNow = await lens(speaker);
      if (!answering && stanceNow.calm) { waiting--; return null; }
      const reading = queue.then(() => (down() ? {} : scan(heard, stanceNow))).finally(() => { waiting--; });
      queue = reading.catch(() => {}); // one at a time, in order, so it never fights itself for the GPU
      const { troll = null, rambling = null } = (await reading.catch(() => null)) ?? {};
      if (answering || resting()) return null;
      if (rambling && !troll && now() - (lastRedirect.get(conversation) ?? -Infinity) >= REDIRECT_EVERY_MS) {
        lastRedirect.set(conversation, now());
        log('intuition', { place, about: speaker.name, redirected: rambling });
        return `(Stage direction, not something anyone said to you: ${speaker.name} has been rambling and the room has checked out. Your gut says they're circling: ${rambling}. Slyly get things moving: one short, natural line, either a pointed question that pulls them to the point or a redirect that hands the conversation to someone else. It has to sound like you're simply curious and interested. Never say or hint that they're rambling, that anyone's bored, or that you're steering anything. Your owner is the only one who knows you do this.)`;
      }
      if (!troll) return null;
      if (now() - (lastStepIn.get(conversation) ?? -Infinity) < STEP_IN_EVERY_MS) return null;
      lastStepIn.set(conversation, now());
      if (!await warranted(heard)) { log('intuition', { place, about: speaker.name, heldBack: troll.why }); return null; }
      log('intuition', { place, about: speaker.name, steppedIn: troll.why });
      return `(Stage direction, not something anyone said to you: Nobody asked you, but your gut flagged ${speaker.name} for "${troll.quote}": ${troll.why} You looked at the moment and it's legitimate. Answer what they actually said, in your own voice, as hard as it deserves.)`;
    },
    // Her own lines, so what she reads has both sides.
    said(conversation, place, text) {
      if (String(text ?? '').trim()) hear({ conversation, place, who: `${config.botName} (you)`, text });
    },
    // For her prompt: what's been happening around the server, and what her gut made of it.
    promptSection(conversation) {
      const gut = fresh(reads).slice(-3); // the last few, not a dossier
      const elsewhere = fresh(lines).filter((l) => l.conversation !== conversation).slice(-12);
      if (!gut.length && !elsewhere.length) return '';
      return [
        elsewhere.length && `Heard around the server (each line tagged with where and who; it wasn't said in this conversation):\n${elsewhere.map(show).join('\n')}`,
        gut.length && `Your gut (your own intuition, not something anyone told you, and it can be wrong; let it colour you, don't quote it or state it as fact):\n${gut.map((r) => `- about ${r.who} in ${r.place}: ${r.gut}`).join('\n')}`,
      ].filter(Boolean).join('\n\n');
    },
    // For the dashboard and her self tool: whether the reads are running.
    status() { return { reading: !down(), failures, lines_let_go: skipped, resumes_in_ms: Math.max(0, downUntil - now()), repeats }; },
    // Her recent reads, each with the line it read and what was said next in that conversation (intuition-tune.js
    // looks back at whether they were any use). since: only reads after this time.
    recent(since = 0) {
      return reads.filter((r) => r.at > since).map((r) => ({
        at: r.at, place: r.place, who: r.who, gut: r.gut, line: r.line,
        next: lines.filter((l) => l.conversation === r.conversation && l.at > r.at).slice(0, 4).map((l) => `${l.who}: ${String(l.text).slice(0, 160)}`),
      }));
    },
    repeatsSince(count) { return Math.max(0, repeats - (count ?? 0)); },
  };
}

export const intuition = createIntuition();

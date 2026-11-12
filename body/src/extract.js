import { ownerDisplayName } from './owner-name.js';
import { config } from './config.js';
import { json as localJson } from './llm.js';
const json = (messages) => localJson(messages, { purpose: 'memory' });
import { remember, conversations, messagesPage, forgetEveryone } from './memory.js';
import { permissions } from './contacts.js';
import { activity } from './events.js';

// Pulling long-term memories out of conversations, shared by the after-each-reply pass (companion.js)
// and the "rebuild your memories from history" tool. Facts are filed under the person they're TRUE
// of, not whoever said them, and only for people whose tier is remembered (not strangers).

export const MEMORY_TASK = (names, botName) =>
  `"facts": durable facts worth remembering about the people in this conversation: ${names.join(', ')}. Preferences, plans, relationships, life details, things they asked to be remembered. ` +
  `Each fact must include "certainty":"asserted" and "evidence":"an exact verbatim excerpt from a human message that explicitly states the fact as true". Each fact is {"about": "<exactly one of: ${names.join(', ')}>", "fact": "<short standalone sentence starting with that person's name>"}. ` +
  `Get the person right: a fact belongs to whoever it is TRUE of, not whoever said it. If ${ownerDisplayName()} says "my boy friend_2's girlfriend is Katie", that fact is about friend_2, not ${ownerDisplayName()}. ` +
  `People may be called by a nickname or real name instead of their screen name; match them to the screen name from who is speaking and who is being addressed. ` +
  `Only keep facts that will still be true and useful weeks from now: who they are, their family, partner and friends, work, projects, interests, habits, strong opinions, plans. ` +
  `Skip: what someone said or asked in the moment, advice they gave, reactions, time of day, being tired or hungry right now, guesses ("likely", "implied", "or similar"), anything you're unsure who it belongs to, ` +
  `facts about anyone not in that list, small talk, anything already known, traits people assign to ${botName}, and requests about how ${botName} should act (those are persona changes, not facts). ` +
  `A question, suspicion, hypothesis, proposed explanation, or bot reply is NOT confirmation. Never rewrite "is that from OpenAI?" as "${ownerDisplayName()} confirmed it came from OpenAI". Do not infer confirmation from later discussion. Evidence must come from an explicit human statement, not the assistant, and preserve uncertainty by skipping unconfirmed claims. ` +
  `Fewer, solid facts beat many weak ones. Empty list if nothing new.`;

// Her knowledge graph's part of the same pass (kg.js): how things connect, other names, dates.
export const GRAPH_TASK = (names, botName) =>
  `"graph": how the people and things in the latest exchange connect, only what a human message explicitly states as true. An object with four lists (each empty if nothing):\n` +
  `- "links": {"from": "<name>", "from_type": "<type>", "rel": "<short relation, e.g. owns, is making, works at, is dating, lives in, is the brother of>", "to": "<name>", "to_type": "<type>"}. For a person in the conversation use exactly their screen name (one of: ${names.join(', ')}); anyone or anything else by its own name.\n` +
  `- "things": facts about something that is not one of those people: {"name": "<its name>", "type": "<type>", "fact": "<short standalone sentence starting with its name>"} (e.g. a pet, a game, a project, a place, a friend not in the conversation).\n` +
  `- "aliases": another name a person in the conversation goes by, when they or someone says so: {"person": "<one of: ${names.join(', ')}>", "alias": "<the other name>"}.\n` +
  `- "dates": a date that matters to someone, when stated: {"about": "<person's name>", "what": "<birthday, anniversary, ...>", "date": "<MM-DD, or YYYY-MM-DD if the year is known>"}.\n` +
  `<type> is one of: person, pet, place, project, game, thing, idea, event, group, work. Every item also has "certainty":"asserted" and "evidence":"an exact verbatim excerpt from a human message that states it". ` +
  `Skip guesses, questions, jokes, anything ${botName} said, and anything about ${botName} herself.`;

// Files the graph part of the pass. Same gate as facts: only what a human actually stated, and only
// from people she remembers (not strangers). Every item is tagged with who said it and where.
// Returns what was saved, for the activity feed.
export async function fileGraph(g, { people, speaker, place, sourceMessages, graph }) {
  if (!g || typeof g !== 'object' || !permissions(speaker.id).remember) return { links: [], things: [], aliases: [], dates: [] };
  const ok = (x) => groundedFact(x, sourceMessages);
  const list = (k) => (Array.isArray(g[k]) ? g[k].slice(0, 8).filter((x) => x && typeof x === 'object' && ok(x)) : []);
  const inConversation = (name) => people.find((p) => p.name.toLowerCase() === String(name ?? '').trim().toLowerCase());
  // A person in the conversation goes in by their Discord ID; if their tier isn't remembered, nothing about them does.
  const who = (name) => { const p = inConversation(name); return p ? (permissions(p.id).remember ? p.id : null) : String(name ?? '').trim(); };
  const tags = { saidBy: speaker.name, place };
  const links = await graph.addLinks(list('links').map((l) => ({ from: who(l.from), fromType: l.from_type, rel: l.rel, to: who(l.to), toType: l.to_type, ...tags })).filter((l) => l.from && l.to));
  const things = await graph.addFacts(list('things').filter((t) => !inConversation(t.name)).map((t) => ({ name: t.name, type: t.type, text: t.fact, ...tags })));
  const aliases = list('aliases').map((a) => { const id = who(a.person); return id && inConversation(a.person) ? graph.addAlias(id, a.alias) : null; }).filter(Boolean);
  const dates = list('dates').map((d) => { const id = who(d.about); return id ? graph.addDate({ about: id, what: d.what, date: d.date, ...tags }) : null; }).filter(Boolean);
  return { links, things, aliases, dates };
}

// The span of `text` that says `evidence` once case, spacing and punctuation are ignored, as
// { start, length } in the original text, or null. Words have to appear whole and in order.
export function looseIndex(text, evidence) {
  const words = String(evidence).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (!words.length) return null;
  const tokens = [...String(text).matchAll(/[\p{L}\p{N}']+/gu)].map((m) => ({ word: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length }));
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((w, j) => tokens[i + j].word === w)) return { start: tokens[i].at, length: tokens[i + words.length - 1].end - tokens[i].at };
  }
  return null;
}

// A second gate checks the actual human source, not just the extractor's paraphrase.
export function groundedFact(fact, sourceMessages = []) {
  if (!fact || typeof fact !== 'object' || fact.certainty !== 'asserted' || typeof fact.evidence !== 'string') return false;
  const evidence = fact.evidence.trim();
  if (evidence.length < 8) return false;
  return sourceMessages.some((m) => {
    if (m.role && m.role !== 'user') return false;
    const text = String(m.text ?? m.content ?? '');
    // Where the evidence sits in what they said. The exact words first; failing that, the same words
    // with case, spacing and punctuation ignored, because a transcript and a small local model never
    // agree on commas, and a fact said out loud was being thrown away over them.
    let start = text.indexOf(evidence);
    let found = evidence;
    if (start < 0) {
      const at = looseIndex(text, evidence);
      if (!at) return false;
      ({ start, length: found } = at);
      found = text.slice(start, start + at.length);
    }
    const before = text.slice(0, start);
    const sentenceStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('?'), before.lastIndexOf('!'), before.lastIndexOf('\n')) + 1;
    const tail = text.slice(start + found.length);
    const end = tail.search(/[.!?\n]/);
    const sentence = text.slice(sentenceStart, start + found.length + (end < 0 ? tail.length : end + 1));
    return !/[?]/.test(sentence) && !/^\s*(?:what|why|how|when|where|who|which|is|isn't|are|aren't|does|do|did|can|could|would|should)\b/i.test(sentence) &&
      !/\b(?:maybe|perhaps|might|suspect|wonder(?:ing)?|guess|hypothes[ei]s|hypothetical|seems?|not sure|not confirmed|unconfirmed)\b/i.test(sentence);
  });
}

// Every stored line says who said it and where, so when she mixes up sources she can check the tag.
export const sourceTag = ({ saidBy = null, place = null } = {}) =>
  saidBy ? ` (${saidBy} said so${place ? ` in ${place}` : ''})` : place ? ` (from ${place})` : '';

// Saves extracted facts under the right people. people: [{ id, name }]; a bare string fact (older
// prompt format) counts as being about fallbackName, who is also the one who said it unless source
// says otherwise. Returns how many were saved.
export async function fileFacts(facts, people, fallbackName, sourceMessages = [], source = {}) {
  const byPerson = new Map();
  const tag = sourceTag({ saidBy: source.saidBy ?? fallbackName ?? null, place: source.place ?? null });
  for (const f of Array.isArray(facts) ? facts.slice(0, 12) : []) {
    const fact = typeof f === 'string' ? f.trim() : typeof f?.fact === 'string' ? f.fact.trim() : '';
    if (!fact || !groundedFact(f, sourceMessages)) continue;
    const about = (typeof f === 'object' && typeof f.about === 'string' ? f.about : fallbackName ?? '').trim().toLowerCase();
    const person = people.find((p) => p.name.toLowerCase() === about);
    if (!person || !permissions(person.id).remember) continue;
    if (!byPerson.has(person)) byPerson.set(person, []);
    byPerson.get(person).push(`${fact}${tag}`);
  }
  let count = 0;
  for (const [person, list] of byPerson) {
    const saved = await remember(person.id, list);
    count += saved.length;
    if (saved.length) activity('remembered', { speaker: person.name, userId: person.id, facts: saved });
  }
  return count;
}

// Reads through saved conversations and repopulates memories. Runs in the background (it can take
// a few minutes on a long history); progress and the result go to the activity feed.
// fresh: wipe every memory first. only: a conversation id to limit it to.
let rebuilding = null;
export function rebuildMemories({ fresh = false, only = null } = {}) {
  if (rebuilding) return { started: false, message: 'A rebuild is already running.' };
  const targets = conversations().filter((c) => !only || c.conversation === only).map((c) => c.conversation);
  if (!targets.length) return { started: false, message: 'There is no conversation history to read.' };
  rebuilding = (async () => {
    const started = Date.now();
    if (fresh) activity('persona', { reason: `Cleared ${forgetEveryone()} memories before rebuilding`, changedBy: 'owner' });
    let saved = 0, read = 0;
    for (const conversation of targets) {
      let after = 0;
      for (;;) {
        const page = messagesPage(conversation, after, 40);
        if (!page.length) break;
        after = page[page.length - 1].id;
        read += page.length;
        const ids = new Map();
        for (const m of page) if (m.role === 'user' && m.user_id && m.user_id !== 'dashboard') ids.set(m.user_id, m.name ?? 'Someone');
        // Everyone is named, strangers too, so their facts are recognised as theirs (and then dropped
        // by fileFacts) instead of being pinned on someone else.
        const people = [...ids].map(([id, name]) => ({ id, name }));
        if (!people.some((p) => permissions(p.id).remember)) continue;
        const transcript = page.map((m) => `${m.role === 'assistant' ? m.name ?? config.botName : m.name}: ${m.content}`).join('\n');
        const result = await json([
          { role: 'system', content: `You maintain the long-term memory of a companion named ${config.botName}. Read this stretch of conversation and reply with JSON {${MEMORY_TASK(people.map((p) => p.name), config.botName)}}` },
          { role: 'user', content: transcript },
        ]).catch((err) => {
          activity('error', { where: 'memory rebuild', message: err.message });
          return null;
        });
        // Who said each one is in the page, not in the fact: the tag names the record it was read from.
        saved += await fileFacts(result?.facts, people, undefined, page.filter((m) => m.role === 'user'), { place: `the saved history of ${conversation}` });
      }
    }
    activity('persona', { reason: `Memory rebuild done: read ${read} messages, saved ${saved} memories in ${Math.round((Date.now() - started) / 1000)}s`, changedBy: 'owner' });
    return { read, saved };
  })().finally(() => (rebuilding = null));
  return { started: true, conversations: targets.length, done: rebuilding };
}

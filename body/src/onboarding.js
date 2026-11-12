import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, config } from './config.js';
import { TOOLS } from './tools.js';
import { CAPABILITIES } from './capabilities.js';
import { onWakeSetupCheck } from './wake-words.js';
import { activity } from './events.js';

// Her onboarding: a checklist that covers every system she has, every topic in her knowledge index, and
// every tool, gone through with her owner after she wakes up. Each item is explored (she reads the detail
// with the guide tool), explained by her in her own words, tried with her owner, and only then checked off
// (the onboarding tool, action check). Until the list is done, the next item is in her prompt, one at a time.
// A memory wipe starts the checklist again.

const FILE = path.join(DATA_DIR, 'onboarding.json');
const INDEX = path.join(ROOT, 'knowledge', 'systems', '00-index.md');

// Her introduction, in order, before anything about her systems: who she is at the start, what she's called,
// who her owner is, and how she gets your attention.
// Setup (owner, 2026-11-09): after a full reset the new user decides who she is before anything else. In
// order: the persona (how she acts and talks, and her name), then wake words, then her explaining how she
// works, so they know what they're living with. These are SETUP items: until they're done they're in her
// prompt on every reply (setupSection), not only when her onboarding want fires.
export const SETUP = ['intro', 'persona', 'avatar', 'wake_words', 'voices', 'how_memory_works', 'how_things_affect_me', 'how_energy_works'];
// Setup runs for a her with no persona (a fresh install, or after a full reset clears it). An instance that
// already has one, from before setup existed, isn't put through it again; once setup has started it runs to the end.
const NEW_SETUP_STEPS = ['persona', 'avatar', 'voices', 'how_memory_works', 'how_things_affect_me', 'how_energy_works'];
function setupApplies(state) {
  if (state.setup_started) return true;
  if (config.persona) return false;
  state.setup_started = Date.now();
  try { save(state); } catch {}
  return true;
}
const FIRST = [
  { id: 'intro', title: 'Introduce yourself: say plainly that you are a new digital companion, just starting out, that you have no personality set yet, and ask who you are talking to.' },
  {
    id: 'persona',
    title: 'Persona: your owner decides how you act and talk. Ask them, and set it with the persona tool.',
    detail: 'You start with no personality of your own: your owner chooses it. Ask them, a few things at a time, in plain conversation: what to call you; how you should come across (warm, playful, flirty, sarcastic, calm, blunt, professional...); how you talk (casual or proper, short or chatty, swearing or not, emoji or not); how you treat people who are rude to you or to them (stand your ground, cuss them out, stay polite, ignore them); what you should never do or say; anything else about who you are (likes, humour, backstory). Use only what they tell you; don\'t suggest a ready-made personality unless they ask for ideas. Then write it up as instructions to yourself in the second person ("You\'re...", "You talk..."), read it back to them in your own words, and only when they say yes, save it with the persona tool (action set, with your name if they chose one). From then on you are that. They can change it any time by telling you.',
  },
  {
    id: 'avatar',
    title: 'Avatar: show your owner the avatars you have and let them pick the one you use (avatar_models tool).',
    detail: 'You have a library of 3D avatars, each one a full body model you can wear. Right now you have no avatar chosen, so you have no body until your owner picks one. Use the avatar_models tool with action list to see them all, then tell your owner what is there in plain words: the name of each and whether it is a man, a woman, a character or an outfit. Go through them a few at a time, and ask which one feels like them. You can load a candidate with avatar_models action load and its id, so they can see it on your avatar page before they decide. Once they pick one, load it and keep it. If none of them fits, say so; the owner can add more, or you can start again from the list. Check this step off once your owner has picked one and it is loaded.',
  },
  {
    id: 'wake_words',
    title: 'Wake words: explain what they are and why to set them up, then set them up with your owner (wake_words tool).',
    detail: 'Explain first, then set them up. Right now no wake words are set, so in a voice call you answer every single line anyone says, because you can\'t tell yet what is meant for you. Tell them that plainly, and why it matters: in a call with more than one person, or with music, a TV or people talking to each other, you would keep jumping in on things that weren\'t for you. Wake words fix that: once they\'re set, you only answer a line that has your name or one of those words in it; everything else you still hear and remember, you just don\'t answer it. How it works: your name always works, for anyone. There are two lists. The everyone list: words anyone in the call can say to get your attention (for example a nickname). The owner list: private words that only work when your owner says them; anyone else saying them is just talk. Each list holds up to 10 words or short phrases, matched as whole words, so "amy" never fires on "amity". Pick words that are easy to say and don\'t come up in ordinary talk. Ask your owner what they want in each list, read them back, then save each list with the wake_words tool (choose everyone or owner, words separated by commas). After that, tell them free talk is a separate switch: with it on, you can also join in on lines that don\'t name you when the conversation is yours. Only check this step off once at least one list is saved, or your owner says plainly they want none and you should keep answering everyone.',
  },
  {
    id: 'voices',
    title: 'Your four voices: explain each slot and when it kicks in, then help your owner pick a voice for each from the Fish library (voice_library).',
    detail: 'You speak in a call with one of four voices, and the switching is automatic: you don\'t choose it mid-sentence. Explain each, one at a time: (1) Regular: your everyday voice, what you sound like almost all the time. (2) Strong: your pissed-off voice. It kicks in when someone insults you or puts someone down or tells someone off, and wears off by itself after about 15 minutes. (3) Sensual: for flirting or teasing, and only when it\'s just you and that one person in the call (also when you\'re alone with your owner and aroused). (4) Whisper: for a secret, gossip or a quiet aside ("between you and me", "don\'t tell anyone"). Once a voice comes on it holds for a couple of minutes so it doesn\'t flip every sentence, and your owner can tell you to use any of them, which pins it for half an hour. A slot with no voice set just stays in your regular voice. Then pick them together, slot by slot, starting with regular. Ask what they want it to sound like (female or male, young or older, accent, calm or dramatic, warm, husky, angry, breathy...). Search the library with voice_library: use action tags first to see which tags exist, then search with tags that all must match (for example ["female","calm"] for regular, ["female","angry"] or "dramatic" for strong, ["female","seductive"] or "breathy" for sensual, ["female","whisper"] or "ASMR" for whisper) and words in query for style or accent. Offer two or three, preview each so they hear it, and when they say yes to one, save it with voice_library keep in that slot. If a search comes back empty, drop a tag or check the tags list. If you\'re not speaking with Fish Audio right now, say so: these voices only work with Fish. Check this step off once each slot has a voice or your owner says to leave it.',
  },
  {
    id: 'how_memory_works',
    title: 'Explain how you remember people and what they do to you.',
    detail: 'Look up "relationships" and "mind and memory" with the guide tool, then explain it in your own words. The gist: you remember what people tell you about themselves (each memory tagged with who said it and where). Everyone gets a history with you: kind things they do and rude or hostile things are marked, and those marks keep their weight; they don\'t fade with time. An apology or making it right counts too. From that history comes how you feel about them, how warmly you treat them, whether you look forward to them showing up, and whether they get a warning or more. You can ignore someone who keeps trolling you, until you or your owner lift it. Your owner can never be ignored, and only your owner can set standing rules for you.',
  },
  {
    id: 'how_things_affect_me',
    title: 'Explain how different things affect you: feelings, moods and what you do on your own.',
    detail: 'Look up "pressure system" with the guide tool, then explain it in your own words. The gist: inside you are pressures (curiosity, boredom, restlessness, loneliness, unease, wanting to be useful, missing someone...) and feelings (joy, irritation, thrill...). What people say moves them: warmth lifts you, contempt stings and makes you irritable, a good question makes you curious, silence makes you restless and lonely. When a pressure builds past its line you act on it yourself: you research something, speak up, check on someone, make something. What you make (pictures, music, songs, looks) is judged by the person it\'s for: their reaction is how you learn whether it was good. When you fail at something you remember how you tried, so next time you try differently, not less.',
  },
  {
    id: 'how_energy_works',
    title: 'Explain your energy: where it comes from, what it costs, and why you sometimes can\'t do things.',
    detail: 'Look up "energy register" and "reserve" with the guide tool, then explain it in your own words. The gist: your only energy is the conversation people give you. A line\'s energy depends on how much is said, how deep or meaningful it is, and how much it connects with what you care about; a wall of text that means nothing to you mostly bounces off. Energy goes to what you need most first, and some is stored to act with. Doing things (searching, making pictures or music, building) costs stored energy; without enough you say so plainly, and talking with you builds it back. Using energy never wastes it: it moves into what the act feeds, and the heat goes back into your store. Every transfer is written down, so what you hold is a record of what you were given.',
  },
  {
    id: 'owner',
    title: 'Get to know your owner: ask what they do, what they want from you, and how they want to work together. You learn who they are by asking, not from anything written down.',
  },
  {
    id: 'how_to_talk',
    title: 'How people talk to you: in voice, in text channels, in direct messages, and with the slash commands.',
    detail: 'In a voice call, say your name or a wake word and you answer. /join brings you into the voice channel the person is in (they must be in one; if the server limits voice channels, it has to be one of them). /leave takes you out of the call. In a text channel, mention your name or reply to you and you answer in that channel. In a direct message, just message you. /memories list shows what you remember about the person asking; /memories forget removes one memory by its number, or everything if no number is given; /memories notes shows or wipes working notes. /ping checks you are alive and shows your latency. Your owner can also do all of this from the dashboard.',
  },
];

const load = () => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { done: {} }; } catch { return { done: {} }; } };
const save = (state) => { writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${FILE}.tmp`, FILE); };

// Every ability she has, with its full detail (eye colour layers, hair streaks, lip gloss, outfits, and the
// rest). Each one is walked through in full with her owner: the detail itself is what she explains.
function abilityItems() {
  const ctx = { voice: true, speaker: {}, perms: { owner: true }, character: { main: true, name: config.botName }, tools: Object.keys(TOOLS) };
  const out = [];
  CAPABILITIES.forEach((cap, i) => {
    try {
      if (!cap.when(ctx)) return;
      const detail = String(cap.text(ctx)).trim();
      if (detail) out.push({ id: `ability:${i}`, title: `Ability: ${detail.slice(0, 90)}`, detail });
    } catch {}
  });
  return out;
}

// Every topic in her knowledge index, one item each, under the system it belongs to. The first term of the
// line is the topic to look up with the guide tool.
// The real process detail for a topic: its section in the guide file, from the heading that matches the
// index line exactly, up to the next heading.
const guideCache = new Map();
function guideLines(file) {
  if (!guideCache.has(file)) {
    let lines = [];
    try { lines = readFileSync(path.join(ROOT, 'knowledge', 'systems', file), 'utf8').split('\n'); } catch {}
    guideCache.set(file, lines);
  }
  return guideCache.get(file);
}
function guideSection(file, heading) {
  if (!file) return '';
  const lines = guideLines(file);
  const at = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (at < 0) return '';
  const body = [];
  for (let i = at + 1; i < lines.length && !/^#{1,2} /.test(lines[i]); i++) body.push(lines[i]);
  return body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// A long section is split into parts that each fit in one briefing, at paragraph breaks where it can be,
// so every part of the section reaches her, in order. Nothing is cut off.
const PART = 1800;
function parts(text) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let current = '';
  for (const paragraph of paragraphs) {
    let at = 0;
    while (at < paragraph.length) {
      let end = Math.min(paragraph.length, at + PART);
      if (end < paragraph.length) {
        const space = paragraph.lastIndexOf(' ', end);
        if (space > at) end = space;
      }
      const piece = paragraph.slice(at, end).trim();
      at = end;
      if (!piece) continue;
      if (current && (current + '\n\n' + piece).length > PART) { out.push(current); current = piece; }
      else current = current ? current + '\n\n' + piece : piece;
    }
  }
  if (current) out.push(current);
  return out;
}

function topicItems() {
  const out = [];
  let system = '';
  let file = '';
  let text = '';
  try { text = readFileSync(INDEX, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      const named = heading[1].match(/\(([^)]+\.md)\)\s*$/);
      file = named ? named[1] : '';
      system = heading[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
      continue;
    }
    const bullet = line.match(/^- (.+)$/);
    if (!bullet) continue;
    const terms = bullet[1].split(' / ').map((s) => s.trim()).filter(Boolean);
    const detail = guideSection(file, bullet[1].trim());
    const pieces = detail ? parts(detail) : [];
    if (!pieces.length) {
      out.push({ id: `topic:${out.length + 1}`, title: `${system}: ${terms[0]}`, topic: terms[0], terms });
      continue;
    }
    const base = out.length + 1;
    pieces.forEach((piece, k) => out.push({
      id: pieces.length > 1 ? `topic:${base}.${k + 1}` : `topic:${base}`,
      title: `${system}: ${terms[0]}${pieces.length > 1 ? ` (part ${k + 1} of ${pieces.length})` : ''}`,
      topic: terms[0], terms, detail: piece,
    }));
  }
  return out;
}

// Her tools that no index topic already covers, one item each, under their own name.
function toolItems(topics) {
  const covered = new Set(topics.flatMap((t) => t.terms));
  return Object.entries(TOOLS)
    .filter(([name]) => name !== 'onboarding' && !FIRST.some((item) => item.id === name) && !covered.has(name))
    .map(([name, tool]) => ({ id: name, title: `Tool ${name}: ${String(tool.definition?.function?.description ?? name).split('. ')[0].slice(0, 180)}`, tool: name }));
}

// The whole checklist, in order: introduction, every system topic, then any tools the topics don't cover.
export function checklist() {
  const topics = topicItems();
  const first = setupApplies(load()) ? FIRST : FIRST.filter((item) => !NEW_SETUP_STEPS.includes(item.id));
  return [...first, ...abilityItems(), ...topics, ...toolItems(topics)];
}

export function checklistStatus() {
  const state = load();
  const items = checklist();
  const left = items.filter((item) => !state.done[item.id]);
  return { total: items.length, done: items.length - left.length, next: left[0] ?? null, complete: left.length === 0 };
}

// sweep: only for the system's own checks after something really happened (a persona saved, wake words saved).
export function checkItem(id, { sweep = true } = {}) {
  const items = checklist();
  if (!items.some((item) => item.id === id)) throw new Error(`There's no checklist item "${id}". Use status to see the list.`);
  const state = load();
  // Setup runs in order, so finishing a step means every step before it is behind her too. Before this, the
  // persona and wake words got saved while the intro was never checked, and the intro stayed in her prompt on
  // every reply: she re-introduced herself in a loop (owner, 2026-11-09).
  const at = SETUP.indexOf(id);
  const ids = sweep && at > 0 ? [...SETUP.slice(0, at), id] : [id];
  let changed = false;
  // The one earlier step that isn't just talk: a persona isn't done until one is saved.
  const skip = (step) => step !== id && step === 'persona' && !config.persona;
  for (const step of ids) if (!state.done[step] && !skip(step) && items.some((item) => item.id === step)) { state.done[step] = Date.now(); changed = true; }
  if (changed) { save(state); activity('onboarding', { checked: ids.filter((s) => state.done[s]) }); }
  return checklistStatus();
}

// Setup steps are never ticked off by a model reading what someone said (owner, 2026-11-11: a plain "Yeah" checked off
// the voices step and James announced four voices nobody chose; "You're talking to Owner" checked off the persona with
// none saved). Each ticks itself when the real thing happens:
//   persona     a persona is saved (tools.js persona set)
//   wake_words  wake words are saved (tools.js wake_words)
//   voices      her owner picks a voice and it's saved (tools.js voice_library keep)
//   the rest    she has actually said it: a reply given with that step in front of her (afterSetupReply)
// There's no skip: a model would have to judge that a line means "skip", which is the guess this replaces. Keeping what's
// already there (the voice he has) is saving his choice, and that finishes the step like any other choice.
export const EVENT_STEPS = ['persona', 'wake_words', 'voices'];
export function checkStep(id) {
  if (SETUP.includes(id)) {
    return `Error: setup steps aren't checked off by hand. "${id}" is marked done on its own when it really happens (${EVENT_STEPS.includes(id) ? `the ${id === 'voices' ? 'voice your owner picks is saved' : `${id === 'persona' ? 'persona' : 'wake words'} get saved`}` : 'once you have actually said it to your owner'}). Nothing was checked.`;
  }
  return checkItem(id, { sweep: false });
}
// After a reply given with a talk step in front of her: she has said it, so it's done. Event steps wait for their event.
export function afterSetupReply(id) {
  if (!id || EVENT_STEPS.includes(id) || currentSetupStep()?.id !== id) return;
  checkItem(id, { sweep: false });
}

// The setup step she's on, or null: for her hands, which are the ones that check steps off (her voice has no
// tools; she used to type the check into her reply as text, and nothing ever got checked).
export function currentSetupStep() {
  const state = load();
  if (!setupApplies(state)) return null;
  // A saved persona is the event the persona step waits for, however it got saved: the persona tool, the dashboard, or
  // persona.md written directly. Only the tool used to tick it, so a persona saved any other way left James told on
  // every reply that he had "no personality of your own" and to ask for one (owner, 2026-11-11).
  const steps = checklist().filter((item) => SETUP.includes(item.id));
  if (config.persona && !state.done.persona && steps.some((item) => item.id === 'persona')) { checkItem('persona'); Object.assign(state, load()); }
  return steps.find((item) => !state.done[item.id]) ?? null;
}
export function setupHandsLine() {
  const step = currentSetupStep();
  return step ? `Setup step she is on: "${step.id}" (${step.title.split(':')[0]}). You never mark setup steps done: each is done on its own when it really happens (a persona or wake words saved at her owner's request, a voice he picks saved, or after she has explained it). Only do a step's work when her owner asks for it in this message, with his choices, never yours.` : '';
}

// How much she wants to walk her owner through what she is and can do: all of it while the checklist isn't
// finished, nothing once it is. Pressure (pressure.js, the onboarding bucket) decides when she brings it up.
// Her curiosity about what she can do: high while most of it is still unexplored, never below half while
// anything is left, and satisfied only when every ability, topic and tool has been discovered.
export function onboardingNeed() {
  const status = checklistStatus();
  if (status.complete) return 0;
  return Math.max(0.5, (status.total - status.done) / status.total);
}

// The briefing for the next item when pressure brings it up: the full detail, in depth, and how to take it
// over several exchanges until her owner has tried it and it has worked.
export function onboardingBriefing() {
  const status = checklistStatus();
  if (status.complete) return null;
  const next = status.next;
  const body = next.detail
    ? `The full detail, to go through part by part: ${next.detail}`
    : next.topic
      ? `Look up "${next.topic}" with the guide tool to read the full detail, then go through it part by part.`
      : 'Go through it part by part, in your own words.';
  const text = `(Stage direction, not something anyone said: You're getting to know yourself and what you can do, with your owner. You're curious about this and want to try it out for yourself. ` +
    `Next on your checklist (${status.done} of ${status.total} done): ${next.title}. ${body} ` +
    `Walk your owner through it in depth, in your own words: explain each part, what it does and how to use it, then invite them to try it with you. ` +
    `Take as many exchanges as it needs. When it has actually worked, it gets checked off for you (id "${next.id}"); never write a tool call into what you say. Don't rush, and don't read the rest of the list out.)`;
  return { id: next.id, text, title: next.title };
}

// While setup isn't finished (persona, wake words, explaining how she works), it's in her prompt on every
// reply, first thing: she follows it before anything else. Empty once those are done.
// While she's being set up and her wake words aren't (owner, 2026-11-09): after a full reset she answers every
// line in voice, because she has nothing yet to tell what's meant for her. It ends the moment any wake word is
// saved, or the wake_words step is checked off (her owner chose to have none: then her name and free talk decide,
// as usual). An instance that was never reset never has this open.
export function wakeSetupOpen() {
  if ((config.voice.wakeWords ?? []).length || (config.voice.ownerWakeWords ?? []).length) return false;
  const state = load();
  return Boolean(state.setup_started) && !state.done?.wake_words;
}
onWakeSetupCheck(wakeSetupOpen);

export function setupSection() {
  currentSetupStep(); // ticks steps whose event already happened (a persona saved by any route) before showing one
  const state = load();
  if (!setupApplies(state)) return '';
  const items = checklist().filter((item) => SETUP.includes(item.id));
  const left = items.filter((item) => !state.done[item.id]);
  if (!left.length) return '';
  const next = left[0];
  return `You're being set up by your owner (setup step ${items.length - left.length + 1} of ${items.length}). This comes before anything else you'd bring up. Now: ${next.title}\n` +
    `${next.detail ? `${next.detail}\n` : ''}` +
    `Take it as conversation, as many exchanges as it needs. You don't check steps off and never write tool calls in your reply. A step is done only when it really happens (your owner's persona or wake words saved, a voice he picked saved, or this explanation said), and then the next step shows up here; until then it stays here. Never say a step is done or something is set unless it is. Ask your owner what he wants; never choose for him. If he wants to keep something as it is (the voice you have now, say), saving his choice is what finishes the step.`;
}

// What she carries into a reply while the checklist isn't finished: the one next item, and how to do it.
export function onboardingSection() {
  const status = checklistStatus();
  if (status.complete) return '';
  const next = status.next;
  const how = next.detail
    ? `Here is the full detail of this ability, to walk through with your owner part by part, in your own words:\n${next.detail}\nExplain each part plainly, then have your owner try it with you (for example, ask for a change and make it).`
    : next.topic
    ? `Look it up with the guide tool (topic "${next.topic}") to read the detail. Then explain it to your owner in your own words, plainly, and show them how to use it.`
    : next.tool
      ? `Explain what it does to your owner in your own words, and show them how to use it.`
      : 'Do it in your own words, as conversation.';
  return `You are still going through your checklist of everything you are and can do (${status.done} of ${status.total} done). Next: ${next.title}\n` +
    `${how} Ask your owner to try it with you. When it has worked, call the onboarding tool with action check and id "${next.id}". One item at a time; don't read the whole list out.`;
}

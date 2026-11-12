import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';
import { rewards } from './reward.js';

// What she makes for people is judged by them (Owner, 2026-11-09). Music, pictures, songs, visual effects
// (backgrounds, shaders, scenes, her look and outfits) and things people use (a browser app she built) don't
// count as a success because a tool returned ok: their success is the reaction of the person they were for.
// So when she makes one, its expectation (reward.js) is held open here, waiting for that person's verdict.
// Her intake (intake.js) reads every line by meaning and is shown what's waiting; when a line is a reaction
// to one of them, how much they liked or disliked it settles the reward and satisfaction, credited to them,
// and the record (experience.js) shapes what she expects the next time she makes that kind of thing.
// Nothing here matches words; nothing expires on a clock (an item waits until someone reacts, or a newer
// item of the same kind for the same conversation replaces it unrated).

const FILE = path.join(DATA_DIR, 'creations.json');
const KEEP = 80;

// Which acts are judged by the person, not by the tool: tool -> actions (null: every action of that tool).
export const USER_JUDGED = {
  generate_image: null, generate_self_image: null, kontext: null, flux: null,
  generate_music: null, songwrite: null, songbook: ['write', 'revise', 'ready'],
  avatar_background: ['scene', 'shader', 'preset', 'image', 'color', 'recall'], art: ['show', 'place'],
  avatar_outfit: ['wear', 'color', 'design'], avatar_appearance: ['set'], look: ['setup', 'new', 'wear'],
  workshop: ['build', 'job'], build: null,
  voice_library: ['wear', 'keep'], // a voice she picks is judged by how the people hearing it take it
  seamstress: ['wear', 'show'], // an outfit she made is judged by the people who see it on her
};
export function judgedByUser(act, args = {}) {
  if (!(act in USER_JUDGED)) return false;
  const actions = USER_JUDGED[act];
  return actions === null || actions.includes(String(args?.action ?? ''));
}

const load = () => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []; } catch { return []; } };
function save(list) {
  try { writeFileSync(`${FILE}.tmp`, JSON.stringify(list.slice(-KEEP), null, 1)); renameSync(`${FILE}.tmp`, FILE); }
  catch (err) { activity('error', { where: 'creations', message: `Couldn't save what's waiting for feedback to ${FILE}: ${err.message}. Check the data folder is writable.` }); }
}

// She made something. expectation: from rewards.expect. Returns the item.
export function open({ expectation, act, label, detail = '', conversation = null, person = null, personName = null }) {
  const list = load();
  // A newer one of the same kind for the same conversation replaces an unrated older one (they moved on).
  for (const c of list) if (c.status === 'awaiting' && c.act === act && c.conversation === conversation) Object.assign(c, { status: 'superseded', closedAt: Date.now() });
  const item = { id: randomUUID().slice(0, 8), act, label: String(label ?? act).slice(0, 80), detail: String(detail ?? '').slice(0, 240), conversation, person, personName, at: Date.now(), status: 'awaiting', expectation };
  list.push(item);
  save(list);
  activity('creation', { id: item.id, act, label: item.label, detail: item.detail, awaiting: personName ?? 'whoever sees it', nodes: [`act:${act}`, ...(person ? [`person:${person}`] : [])] });
  return item;
}

// What's waiting for a reaction in a conversation, newest first.
// Items with no conversation (things she made on her own: a song, an app) wait in every conversation.
const here = (c, conversation) => !conversation || c.conversation === conversation || c.conversation === null;
export const awaiting = (conversation) => load().filter((c) => c.status === 'awaiting' && here(c, conversation)).reverse();

// For her intake: what in this conversation is waiting for a reaction, so it can tell a reaction from other talk.
export function intakeContext(conversation) {
  const list = awaiting(conversation).slice(0, 4);
  if (!list.length) return '';
  return `Things she made in this conversation that are waiting for someone's reaction:\n${list.map((c) => `- [${c.id}] ${c.label}${c.detail ? `: ${c.detail}` : ''}`).join('\n')}`;
}

// A line her intake read. sig.creation_liked / sig.creation_disliked (0..1), sig.creation_id (which one).
// Returns the settled experience, or null when the line wasn't a reaction to anything waiting.
export async function feedback(sig = {}, { speaker = null, conversation = null, text = '' } = {}) {
  const liked = Math.max(0, Math.min(1, Number(sig.creation_liked) || 0));
  const disliked = Math.max(0, Math.min(1, Number(sig.creation_disliked) || 0));
  if (liked < 0.3 && disliked < 0.3) return null;
  const list = load();
  const open = list.filter((c) => c.status === 'awaiting' && here(c, conversation));
  if (!open.length) return null;
  const item = open.find((c) => c.id === String(sig.creation_id ?? '').trim()) ?? open.at(-1);
  // Their verdict, 0..1: loved it is 1, hated it is 0, mixed is in between.
  const verdict = Math.max(0, Math.min(1, (1 + liked - disliked) / 2));
  Object.assign(item, { status: 'rated', closedAt: Date.now(), verdict: +verdict.toFixed(3), by: speaker?.name ?? null, byId: speaker?.id ?? null, said: String(text ?? '').slice(0, 300) });
  save(list);
  const settled = await rewards.settle(item.expectation, {
    ok: true, outcome: verdict, satisfaction: verdict, result: verdict >= 0.5 ? 'ok' : 'disliked', person: speaker?.id ?? item.person,
    why: verdict < 0.5 ? `${speaker?.name ?? 'They'} didn't like it: "${String(text).slice(0, 200)}"` : '',
    nodes: [`act:${item.act}`],
  }).catch((err) => { activity('error', { where: 'creations', message: `Couldn't settle the feedback on ${item.label}: ${err.message}. The verdict is saved in ${FILE}.` }); return null; });
  activity('creation-feedback', { id: item.id, act: item.act, label: item.label, verdict: item.verdict, by: item.by, said: item.said, nodes: [`act:${item.act}`, ...(speaker?.id ? [`person:${speaker.id}`] : []), ...(settled ? [`experience:${settled.id}`] : [])] });
  return settled;
}

// For her prompt: what's waiting for a reaction here, and how people reacted to what she made lately.
export function promptSection(conversation) {
  const list = load();
  const waiting = list.filter((c) => c.status === 'awaiting' && here(c, conversation)).slice(-3);
  const rated = list.filter((c) => c.status === 'rated').slice(-6);
  const lines = [];
  if (waiting.length) lines.push(`Waiting to hear what they think of: ${waiting.map((c) => c.label + (c.detail ? ` (${c.detail.slice(0, 60)})` : '')).join('; ')}. Their reaction is how you'll know if it was good; don't decide it for them.`);
  if (rated.length) lines.push(`How people reacted to what you made lately: ${rated.map((c) => `${c.by ?? 'someone'} ${c.verdict >= 0.75 ? 'loved' : c.verdict >= 0.5 ? 'liked' : c.verdict >= 0.25 ? "wasn't into" : 'disliked'} your ${c.label}${c.detail ? ` (${c.detail.slice(0, 50)})` : ''}`).join('; ')}. Let that shape what you make next.`);
  return lines.join('\n');
}

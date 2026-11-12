import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR, updateSettings } from './config.js';
import { setPersona } from './persona.js';
import { activity } from './events.js';

// The avatar studio's cast. "main" is the bot itself: its name, persona and voice are the normal
// settings, so Discord and the dashboard stay in sync with it. Every other character lives in
// data/characters.json with its own name, persona, Fish voice and model (relative to data/).
const file = path.join(DATA_DIR, 'characters.json');
// The cast is her, Mateo the architect, Nova (the other companion's avatar) and Alex (her manager's
// avatar). Nova and Alex are peers: their own bots speak and post their avatar events here.
const DEFAULT_EXTRAS = [
  { id: 'architect', name: 'Mateo', persona: '', voiceId: '', model: 'rocketbox_male_adult_08/male_adult_08.glb', role: 'the architect of her home and world' },
  { id: 'nova', name: 'Nova', persona: '', voiceId: '', model: 'rocketbox_female_adult_04/female_adult_04.glb', role: 'Nova, the other companion', peer: true },
  { id: 'alex', name: 'Alex', persona: '', voiceId: '', model: 'rocketbox_male_adult_01/male_adult_01.glb', role: 'Alex, her manager (his own bot; this is his avatar on the stage)', peer: true, description: 'A heavyset young man with thick, shaggy dark brown hair, a cream polo shirt with thin brown stripes and a brown collar, khaki trousers and grey sneakers.' },
];

let extras = DEFAULT_EXTRAS;
try {
  if (existsSync(file)) extras = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.warn('Ignoring unreadable data/characters.json:', err.message);
}
const saveExtras = () => writeFileSync(file, JSON.stringify(extras, null, 2));

export function list() {
  return [
    { id: 'main', main: true, name: config.botName, persona: config.persona, voiceId: config.fish.voiceId || '', modelPath: config.avatar.path },
    ...extras.map((c) => ({ ...c, main: false, modelPath: path.join(DATA_DIR, c.model) })),
  ];
}

export const get = (id) => list().find((c) => c.id === id) ?? null;

export function update(id, { name, persona, voiceId, role, description }, changedBy = 'dashboard') {
  if (id === 'main') {
    setPersona({ name, persona, reason: 'Edited in avatar studio', changedBy });
    if (voiceId !== undefined) updateSettings({ fishVoiceId: voiceId });
    return get('main');
  }
  const c = extras.find((x) => x.id === id);
  if (!c) return null;
  if (typeof name === 'string' && name.trim()) c.name = name.trim();
  if (typeof persona === 'string') c.persona = persona.trim();
  if (typeof voiceId === 'string') c.voiceId = voiceId.trim();
  if (typeof role === 'string') c.role = role.trim();
  if (typeof description === 'string') c.description = description.trim();
  saveExtras();
  activity('persona', { reason: `${c.name} edited`, changedBy, name: c.name });
  return get(id);
}

// Who a message is for: the character named earliest in it ("Leo, what do you think?"),
// otherwise whoever the person was already talking to. Never a peer (Nova, Alex): those are other
// bots' avatars and their own bots answer for them, so a line for one of them stays with her here
// rather than her brain speaking as them.
export function addressee(text, fallbackId) {
  let best = null;
  for (const c of list()) {
    const name = c.name?.trim();
    if (!name || c.solo) continue; // solo characters are only talked to on their own page
    const m = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(text);
    if (m && (!best || m.index < best.index)) best = { id: c.id, index: m.index };
  }
  const answerable = (id) => { const c = get(id); return c && !c.peer ? id : null; };
  if (best) return answerable(best.id) ?? 'main';
  return answerable(fallbackId) ?? 'main';
}

// A guest in a voice call (the architect, brought in by the owner): which guest a line is for, if
// any. Named in the line, or the one the person was already talking to; "Amy" (or any line that
// calls the main character) hands it back to her. Null when the line is for her.
export function guestAddressed(text, guests, last = 'main', mainName = config.botName) {
  if (!guests?.size) return null;
  const who = addressee(text, last);
  if (who === 'main' || !guests.has(who) || get(who)?.peer) return null;
  // Her name anywhere in the line, ahead of the guest's, is for her.
  const mine = new RegExp(`\\b${String(mainName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(text);
  const theirs = new RegExp(`\\b${String(get(who)?.name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(text);
  if (mine && (!theirs || mine.index < theirs.index)) return null;
  return who;
}

// Cast members a line calls by name who can be brought into a call: not her, not a solo character,
// not another companion's avatar (peer: that bot answers for itself). Saying "Mateo" is how the
// architect gets pulled into the conversation; no other wake word.
export function castCalled(text) {
  const out = [];
  for (const c of list()) {
    if (c.main || c.solo || c.peer || !c.name?.trim()) continue;
    if (new RegExp(`\\b${c.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(text ?? ''))) out.push(c.id);
  }
  return out;
}

// Each character's emotional state is kept separately; "avatar" is the main one's (from before
// there was a cast) so her existing mood carries over.
export const emotionKey = (id) => (id === 'main' ? 'avatar' : `avatar:${id}`);

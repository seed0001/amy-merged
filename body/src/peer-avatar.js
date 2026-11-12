// Peer avatars on her stage: another companion bot running on this computer (Nova, Alex: their own
// Discord accounts, their own voices) drives ITS OWN avatar in Amy's cast with its own speech,
// feelings and moves, so the stage animates them the way it animates her.
//
// The contract (knowledge/systems/peer-avatars.md has the long version):
//   POST http://127.0.0.1:3000/api/avatar/peer   { character: '<cast id>', event: <avatar event> }
//   character  a cast member with peer: true (data/characters.json); a peer only ever moves its own avatar.
//   event      one of the live stream's own shapes:
//     { type:'discord-speech', speech:{ type:'start', id, text, conversation?, at?, frames?, frameMs?, durationMs?, articulation?, audio? } }
//     { type:'discord-speech', speech:{ type:'stop', id, reason?: 'ended'|'interrupted' } }
//     { type:'expression', feelings:{ joy:0.6, ... } }   (or expression:{ feelings:{...} })
//     { type:'play', name:'nod', ms? }                   (alias type:'gesture'; names: emotion.js GESTURES)
//     { type:'cue', kind:'thinking', strength? }          (kinds: avatar-cues.js CUES)
//   speech.audio is the line's own Ogg Opus clip, base64. When it comes, her server compiles the same
//   phoneme articulation her own Discord voice gets (prepareDiscordSpeech) and then DROPS the audio:
//   the peer's voice is already heard in the call, so the stage only moves the mouth, never plays it.
//   Only from this computer: proxied or remote callers are refused.
import { randomUUID } from 'node:crypto';
import * as characters from './characters.js';
import { selfName } from './config.js';
import { bus } from './events.js';
import { EMOTIONS, GESTURES } from './emotion.js';
import { CUES } from './avatar-cues.js';
import { prepareDiscordSpeech } from './discord-avatar.js';

export const PEER_EVENT_TYPES = ['discord-speech', 'expression', 'play', 'gesture', 'cue'];
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_SPEECH_MS = 180_000;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Why a request may not drive a peer avatar, or null when it may. Same-computer only: the caller's
// socket is local, nothing relayed it (a Cloudflare tunnel or proxy arrives from 127.0.0.1 too, with
// these headers), and the Host is a localhost name (no DNS rebinding).
export function peerRequestProblem(req) {
  const from = req?.socket?.remoteAddress;
  if (!LOCAL_ADDRESSES.has(from)) return `Peer avatar events are only taken from this computer, and this request came from ${from || 'an unknown address'}. Fix: run the peer bot on the same machine and post to http://127.0.0.1:<dashboard port>/api/avatar/peer.`;
  const relayed = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'].find((h) => req.headers?.[h]);
  if (relayed) return `Peer avatar events are only taken straight from this computer, and this one was relayed (it carried a ${relayed} header). Fix: post directly to http://127.0.0.1:<dashboard port>/api/avatar/peer, not through a tunnel or proxy.`;
  let host = '';
  try { host = new URL(`http://${req.headers?.host || ''}`).hostname; } catch {}
  if (!LOCAL_HOSTS.has(host)) return `Peer avatar events must be addressed to a localhost name, and this one was sent to "${req.headers?.host || 'no host'}". Fix: use http://127.0.0.1:<dashboard port>/api/avatar/peer.`;
  return null;
}

const num = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, Number(v))) : fallback);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const round3 = (v) => Math.round(v * 1000) / 1000;

function cleanFrames(frames, frameMs) {
  if (frames === undefined) return null;
  if (!Array.isArray(frames)) throw fail(400, 'speech.frames must be an array of mouth frames like {open, wide, round, bright} (each 0..1). Fix: send the frames your prepareDiscordSpeech made, or leave frames out and send the clip as speech.audio.');
  if (frames.length > Math.ceil(MAX_SPEECH_MS / frameMs)) throw fail(400, `speech.frames has ${frames.length} frames, more than three minutes of speech at ${frameMs} ms a frame. Fix: send one sentence per start packet.`);
  return frames.map((f) => Object.fromEntries(['open', 'wide', 'round', 'bright'].map((k) => [k, round3(num(f?.[k], 0, 1, 0))])));
}

function cleanArticulation(a) {
  if (a === undefined || a === null) return null;
  if (typeof a !== 'object' || a.version !== 2 || !Array.isArray(a.cues)) throw fail(400, 'speech.articulation must be the version-2 track her speech-articulation.js compiles ({version:2, cues:[...], timing:{...}}). Fix: leave it out and send speech.audio (base64 Ogg Opus) so her server compiles it, or send frames only.');
  return { version: 2, cues: a.cues.slice(0, 4000), timing: a.timing && typeof a.timing === 'object' ? a.timing : undefined };
}

// One peer's speech packets as her own stream carries them, kept so a page that opens mid-sentence
// still moves that mouth, and its last feelings, so a fresh page shows them.
const activeSpeech = new Map();
const lastExpression = new Map();
export function activePeerSpeech(now = Date.now()) {
  const live = [];
  for (const [who, p] of activeSpeech) {
    if (p.at + (p.durationMs || 0) + 1000 < now) activeSpeech.delete(who);
    else live.push(p);
  }
  return live;
}
export const peerExpressions = () => [...lastExpression.values()];

async function speech(character, raw, prepare) {
  if (!raw || typeof raw !== 'object') throw fail(400, 'A discord-speech event needs a speech object: {type:"start", id, text, ...} or {type:"stop", id}. Fix: send event.speech.');
  const now = Date.now();
  if (raw.type === 'stop') {
    const id = str(raw.id, 100);
    const was = activeSpeech.get(character);
    if (!id || was?.id === id) activeSpeech.delete(character);
    const packet = { type: 'stop', id: id || was?.id || null, conversation: str(raw.conversation, 200) || was?.conversation || `peer:${character}`, character, at: now, reason: raw.reason === 'interrupted' ? 'interrupted' : 'ended', peer: true };
    bus.emit('discord-avatar', packet);
    return { stopped: packet.id };
  }
  if (raw.type !== 'start') throw fail(400, `speech.type was "${String(raw.type).slice(0, 40)}", and only "start" and "stop" exist. Fix: send {type:"start", ...} when the line starts playing and {type:"stop", id} when it ends.`);
  const text = str(raw.text, 4000);
  const conversation = str(raw.conversation, 200) || `peer:${character}`;
  const id = str(raw.id, 100) || randomUUID();
  // The sender's own clock (same computer): the mouth stays in step with the voice even when compiling
  // the articulation here took a moment. Anything far off is treated as now.
  const at = Number.isFinite(raw.at) && Math.abs(now - raw.at) < 30_000 ? raw.at : now;
  let frameMs = num(raw.frameMs, 10, 200, 40);
  let frames = cleanFrames(raw.frames, frameMs);
  let articulation = cleanArticulation(raw.articulation);
  let durationMs = num(raw.durationMs, 0, MAX_SPEECH_MS, frames ? frames.length * frameMs : 0);
  let lips = articulation ? 'articulation' : frames ? 'frames' : null;
  let note;
  if (raw.audio !== undefined && !articulation) {
    const clip = typeof raw.audio === 'string' ? Buffer.from(raw.audio, 'base64') : null;
    try {
      if (!clip?.length) throw new Error('speech.audio was empty or not a base64 string');
      const made = await prepare(clip, text, conversation, character);
      frames = made.frames; frameMs = made.frameMs; durationMs = made.durationMs; articulation = made.articulation ?? null;
      lips = 'articulation';
    } catch (err) {
      note = `The clip couldn't be read for phonemes (${err.message}), so ${frames ? 'the frames you sent drive the mouth instead' : 'nothing could drive the mouth'}. Fix: send speech.audio as base64 of the exact Ogg Opus clip (48 kHz) being played.`;
      if (!frames) throw fail(400, note);
    }
  }
  if (!lips) throw fail(400, 'A speech start needs something to move the mouth: speech.audio (base64 Ogg Opus clip, best: her server compiles phonemes from it), speech.articulation, or speech.frames. Fix: send at least one of them.');
  const packet = { type: 'start', id, character, conversation, text, frames: frames ?? [], frameMs, durationMs, ...(articulation ? { articulation } : {}), at, peer: true };
  activeSpeech.set(character, packet);
  bus.emit('discord-avatar', packet);
  return { started: id, lips, ...(note ? { note } : {}) };
}

function expression(character, event) {
  const raw = event.feelings ?? event.expression?.feelings ?? event.expression;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(400, 'An expression event needs feelings: {type:"expression", feelings:{joy:0.6, curious:0.3}} (each 0..1). Fix: send event.feelings.');
  const feelings = {}, ignored = [];
  for (const [name, v] of Object.entries(raw)) {
    if (EMOTIONS[name] && Number.isFinite(Number(v))) feelings[name] = Math.round(num(v, 0, 1, 0) * 100) / 100;
    else ignored.push(name);
  }
  if (!Object.keys(feelings).length) throw fail(400, `None of these feelings exist on her stage: ${ignored.join(', ') || '(none given)'}. Fix: use names from ${Object.keys(EMOTIONS).join(', ')}, each with a number 0..1.`);
  const payload = { character, feelings, at: Date.now(), peer: true };
  lastExpression.set(character, payload);
  bus.emit('avatar-expression', payload);
  return { feelings, ...(ignored.length ? { ignored, note: `Not feelings her stage knows, so they were left out: ${ignored.join(', ')}.` } : {}) };
}

function play(character, event) {
  const names = Array.isArray(event.names) ? event.names : [event.name];
  const valid = names.filter((n) => typeof n === 'string' && GESTURES.includes(n)).slice(0, 5);
  const bad = names.filter((n) => !(typeof n === 'string' && GESTURES.includes(n)));
  if (!valid.length) throw fail(400, `No move her stage knows was named (${bad.map((n) => JSON.stringify(n)).join(', ') || 'none given'}). Fix: send {type:"play", name} with one of: ${GESTURES.join(', ')}.`);
  const ms = event.ms === undefined ? undefined : num(event.ms, 0, 60_000, undefined);
  for (const name of valid) bus.emit('avatar-play', { character, name, ...(ms ? { ms } : {}), at: Date.now(), peer: true });
  return { played: valid, ...(bad.length ? { ignored: bad, note: 'Moves her stage does not have were skipped.' } : {}) };
}

function cue(character, event) {
  if (!CUES.includes(event.kind)) throw fail(400, `Cue "${String(event.kind).slice(0, 40)}" doesn't exist. Fix: send {type:"cue", kind} with one of: ${CUES.join(', ')}.`);
  bus.emit('avatar-cue', { character, kind: event.kind, strength: num(event.strength, 0, 1, 1), at: Date.now(), peer: true });
  return { cue: event.kind };
}

// Each character's events run in order (a stop never overtakes the start it ends while that start's
// phonemes are still being compiled).
const queues = new Map();
export function relayPeerAvatar(body, { prepare = prepareDiscordSpeech } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Promise.reject(fail(400, 'The body must be JSON like {character:"nova", event:{type:"discord-speech", speech:{...}}}. Fix: send that shape with Content-Type: application/json.'));
  const character = str(body.character, 40);
  const who = character && characters.get(character);
  if (!who) return Promise.reject(fail(400, `"${character || '(no character)'}" isn't in ${selfName()}'s cast, so there's no avatar to move. Fix: send the cast id of your own avatar (cast: ${characters.list().filter((c) => c.peer).map((c) => c.id).join(', ') || 'no peers yet'}), or add yourself to data/characters.json with peer: true.`));
  if (!who.peer) return Promise.reject(fail(400, `"${character}" is in ${selfName()}'s cast but isn't a peer (another bot's avatar), and a peer can only move its own avatar. Fix: send your own cast id; if this really is your avatar, set peer: true on it in data/characters.json.`));
  const event = body.event;
  if (!event || typeof event !== 'object' || !PEER_EVENT_TYPES.includes(event.type)) {
    return Promise.reject(fail(400, `event.type was ${event && typeof event === 'object' ? JSON.stringify(String(event.type).slice(0, 40)) : 'missing'}; a peer can send ${PEER_EVENT_TYPES.join(', ')}. Blinks and glances are made by the stage itself for every avatar; the view, background and looks belong to ${selfName()}'s page. Fix: send one of those event types.`));
  }
  const run = () => {
    if (event.type === 'discord-speech') return speech(character, event.speech, prepare);
    if (event.type === 'expression') return expression(character, event);
    if (event.type === 'cue') return cue(character, event);
    return play(character, event);
  };
  const next = (queues.get(character) ?? Promise.resolve()).then(run);
  const tail = next.catch(() => {});
  queues.set(character, tail);
  tail.then(() => { if (queues.get(character) === tail) queues.delete(character); });
  return next.then((result) => ({ ok: true, character, type: event.type, ...result }));
}

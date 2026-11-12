import { config } from './config.js';

// Peer bots: other AI companions (PEER_BOTS, by Discord user ID or name) that share the server with
// him. He hears them in text and voice like anyone else and keeps what they say as context, but he
// only answers one when it calls him by name, and only for a few turns in a row without a person
// speaking, so two bots never talk each other into an endless loop.

// No limit unless PEER_MAX_EXCHANGES sets one: the owner wants the companions free to talk.
// The shared conversation budget owns counters and leases; this module only identifies peers.

const norm = (s) => String(s ?? '').trim().toLowerCase();

// Every other bot on the server counts as a peer: heard in text and voice like anyone else.
let selfId = null;
export function setSelf(id) { selfId = id; }

export function isPeer(user, member) {
  return Boolean(user?.bot) && user.id !== selfId;
}

// Peers with no limit on turns in a row (PEER_UNLIMITED, by ID or name): a bot she has long
// one-on-one conversations with, like a therapy session with Nova.
export function unlimitedPeer(user, member) {
  if (!user?.bot) return false;
  const names = [user.id, user.username, user.globalName, member?.displayName].map(norm);
  return config.peerUnlimited.some((p) => names.includes(norm(p)));
}

// Whether a peer's words are aimed at him: an @mention, or his name as a word.
export function calledByName(text, { mentioned = false, names = [] } = {}) {
  if (mentioned) return true;
  return names.filter(Boolean).some((n) => new RegExp(`\\b${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FILLER = /\b(thanks?|thank you|got it|gotcha|understood|i hear you|heard( you)?|fair( enough)?|good (point|call|stuff)|nice|cool|okay|ok|alright|all right|yeah|yep|yes|sure|noted|right|agreed|over to you|back to you|your (turn|call|floor|mic|go)|(the )?(floor|mic)( is|'s)? (all )?yours|you('ve| have)? got the (floor|mic)|you got the (floor|mic)|you('re| are) up|take it( away)?|go ahead|go for it|all yours|kick us off|floor|mic|you|i|and|so|well|man|buddy|mate|too|now|then)\b/g;
export function handoffOnly(text, { mine = [], others = [] } = {}) {
  const named = (s, names) => names.filter(Boolean).some((n) => new RegExp(`\\b${esc(n)}\\b`, 'i').test(s));
  const sentences = String(text ?? '').split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const mineHits = sentences.filter((s) => named(s, mine));
  if (!mineHits.length) return false;
  const strip = (s) => [...mine, ...others].filter(Boolean).reduce((t, n) => t.replace(new RegExp(`\\b${esc(n)}\\b`, 'gi'), ' '), s)
    .toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(FILLER, ' ').replace(/'s\b/g, ' ').trim();
  if (mineHits.some((s) => strip(s))) return false; // something real was said to him
  // Only acknowledged by name. If the rest of the line asks something and names nobody else, it's his.
  const rest = sentences.filter((s) => !named(s, mine));
  return named(rest.join(' '), others) || !rest.some((s) => s.includes('?'));
}

// Compatibility for callers outside the companion routers. Never keep per-bot counters here.
export function noteTurn() { return true; }

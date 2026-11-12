import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR, updateSettings } from '../config.js';
import { activity } from '../events.js';

// Fish Audio's public voice library, through the owner's FISH_API_KEY (owner, 2026-11-09: "query fish audio
// through my key to see their big voice library to choose different voices on the fly").
//   search   the library by words (name, style, accent...), tag, language; most-used first by default
//   lookup   one voice by its ID
//   wear     speak in a voice in one conversation until she takes it off, without changing her saved voices
//   keep     save a voice into one of her four slots (regular, strong, sensual, whisper); every change is in
//            data/voice-history.jsonl, so any of them can be put back
// Every Fish speech request names its voice, so a switch takes effect on her very next sentence.

const API = 'https://api.fish.audio';
export const SLOTS = { regular: 'fishVoiceId', strong: 'fishStrongVoiceId', sensual: 'fishSensualVoiceId', whisper: 'fishWhisperVoiceId' };
const SLOT_FIELD = { regular: 'voiceId', strong: 'strongVoiceId', sensual: 'sensualVoiceId', whisper: 'whisperVoiceId' };
export const HISTORY_FILE = () => path.join(DATA_DIR, 'voice-history.jsonl');
const SORTS = { popular: 'task_count', top: 'score', newest: 'created_at' };

function key() {
  if (!config.fish.apiKey) throw new Error('There is no FISH_API_KEY in .env, so the Fish Audio voice library can\'t be reached. Your owner adds the key to .env and restarts you.');
  return config.fish.apiKey;
}
async function get(url, fetchImpl) {
  let res;
  try { res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key()}` }, signal: AbortSignal.timeout(15_000) }); }
  catch (err) { throw new Error(`Fish Audio didn't answer (${err.name === 'TimeoutError' ? 'timed out after 15s' : err.message}). Try again in a bit.`); }
  if (res.status === 401 || res.status === 403) throw new Error(`Fish Audio refused the key (${res.status}). The FISH_API_KEY in .env may be wrong or expired; your owner checks it on fish.audio.`);
  if (res.status === 404) throw new Error('Fish Audio has no voice with that ID. Search for it again and use the id from the results.');
  if (!res.ok) throw new Error(`Fish Audio answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

// One voice, short enough for her to read and choose from.
export function brief(m = {}) {
  return {
    id: m._id ?? m.id,
    name: String(m.title ?? '').slice(0, 80),
    about: String(m.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    tags: (m.tags ?? []).slice(0, 80), // all of them: a matched tag can sit far down the list
    languages: m.languages ?? [],
    uses: m.task_count ?? 0,
    likes: m.like_count ?? 0,
    by: m.author?.nickname ?? '',
    sample: m.samples?.[0]?.audio ?? null,
  };
}

// The tags asked for, cleaned: a list or comma-separated text, each a lowercase word or two.
export const cleanTags = (tags = [], tag = '') => [...new Set([...(Array.isArray(tags) ? tags : String(tags ?? '').split(',')), ...String(tag ?? '').split(',')]
  .map((t) => String(t).trim().toLowerCase()).filter((t) => t && t.length <= 40))].slice(0, 6);

// tags: every one must be on the voice (Fish combines repeated tag filters with AND: female + whisper is
// only the female whispering voices). Tags are exact words; tagVocabulary shows which ones exist.
export async function search({ query = '', tag = '', tags = [], language = '', sort = 'popular', mine = false, limit = 8, page = 1 } = {}, { fetchImpl = fetch } = {}) {
  // With words to search for, Fish only honours them when sorting by best match (score): sorted by use or by
  // date it drops the words and returns its most popular voices (2026-11-10: "Friendly Australian" never came
  // back by name, so she couldn't find the ID of the voice Owner wanted kept).
  const words = String(query).trim().slice(0, 80);
  const q = new URLSearchParams({ page_size: String(Math.max(1, Math.min(20, Number(limit) || 8))), page_number: String(Math.max(1, Number(page) || 1)), sort_by: words ? 'score' : SORTS[sort] ?? 'task_count' });
  if (words) q.set('title', words);
  for (const t of cleanTags(tags, tag)) q.append('tag', t);
  if (String(language).trim()) q.set('language', String(language).trim().slice(0, 10));
  if (mine) q.set('self', 'true');
  const data = await get(`${API}/model?${q}`, fetchImpl);
  const voices = (data.items ?? []).filter((m) => (m.type ?? 'tts') === 'tts').map(brief);
  for (const v of voices) if (v.id && v.name) seen.set(v.name.trim().toLowerCase(), v.id);
  activity('voice-library', { what: 'search', query, tags: cleanTags(tags, tag), language, found: data.total ?? voices.length });
  return { total: data.total ?? voices.length, voices };
}

// Which tags are in use, and how often, among the most-used voices (optionally within tags or words already
// chosen): so she filters with tags that exist ("angry", "breathy", "dramatic") instead of guessing.
export async function tagVocabulary({ query = '', tags = [], tag = '', language = '', pages = 3 } = {}, { fetchImpl = fetch } = {}) {
  const counts = new Map(), within = cleanTags(tags, tag);
  let seen = 0;
  for (let page = 1; page <= Math.max(1, Math.min(5, pages)); page++) {
    const { voices } = await search({ query, tags: within, language, limit: 20, page }, { fetchImpl });
    for (const v of voices) for (const t of v.tags ?? []) { const k = String(t).toLowerCase(); if (!within.includes(k)) counts.set(k, (counts.get(k) ?? 0) + 1); }
    seen += voices.length;
    if (voices.length < 20) break;
  }
  return { looked_at: seen, tags: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([t, n]) => ({ tag: t, voices: n })) };
}

export async function lookup(id, { fetchImpl = fetch } = {}) {
  const clean = String(id ?? '').trim();
  if (!/^[a-f0-9]{32}$/i.test(clean)) throw new Error(`"${clean}" isn't a Fish Audio voice ID (32 letters and digits, from a search result's id).`);
  return brief(await get(`${API}/model/${clean}`, fetchImpl));
}

// Voices she has seen in search results, by name: so a voice she found can be named back to her.
const seen = new Map();

// The voice she means, from an id, from nothing (the one she's wearing here), or from a name: the voice she's
// wearing, one she saw in a search, one in her voice history, or else Fish's own best match for exactly that
// name. 2026-11-10: Owner liked the Australian voice she was wearing and asked her to keep it; she passed
// its name instead of its id and the save failed, though the id was right there in what she was wearing.
export async function resolve(input, { conversation = null, fetchImpl = fetch } = {}) {
  const asked = String(input ?? '').trim();
  if (/^[a-f0-9]{32}$/i.test(asked)) return lookup(asked, { fetchImpl });
  const w = conversation ? wornVoice(conversation) : null;
  if (!asked) {
    if (w) return lookup(w.id, { fetchImpl });
    throw new Error("Say which voice: its id from a search, or its name. You're not wearing one here to use instead.");
  }
  const name = asked.toLowerCase();
  if (w && w.name.trim().toLowerCase() === name) return lookup(w.id, { fetchImpl });
  if (seen.has(name)) return lookup(seen.get(name), { fetchImpl });
  const known = history(200).reverse().find((e) => /^[a-f0-9]{32}$/i.test(e.after ?? '') && String(e.name ?? '').trim().toLowerCase() === name);
  if (known) return lookup(known.after, { fetchImpl });
  const { voices } = await search({ query: asked, limit: 10 }, { fetchImpl });
  const exact = voices.filter((v) => v.name.trim().toLowerCase() === name);
  if (exact.length === 1) return lookup(exact[0].id, { fetchImpl });
  if (exact.length > 1) throw new Error(`Fish Audio has ${exact.length} voices called "${asked}": ${exact.map((v) => `${v.id} (used ${v.uses} times, by ${v.by || 'unknown'})`).join(', ')}. Use the id of the one you previewed.`);
  throw new Error(`No voice called exactly "${asked}" on Fish Audio${voices.length ? `; the closest: ${voices.slice(0, 5).map((v) => `${v.name} (id ${v.id})`).join(', ')}` : ''}. Use an id from a search.`);
}

// Every change to the voice she speaks in, with who made it and why, goes in one trail (data/voice-history.jsonl):
// wearing one, taking it off, keeping one in a slot, and her voice settings changed from the dashboard (owner,
// 2026-11-10: her voice changed while he was in the shower and nothing could say why; a worn voice had quietly
// run out after 30 minutes, which left no trace anywhere).
export function logChange(entry) {
  const row = { at: Date.now(), ...entry, reason: String(entry.reason ?? '').slice(0, 200) };
  try { appendFileSync(HISTORY_FILE(), JSON.stringify(row) + '\n'); }
  catch (err) { activity('error', { where: 'voice history', message: `Her voice changed (${row.what}) but the trail couldn't be written to ${HISTORY_FILE()}: ${err.message}. It was ${row.before || 'none'}, now ${row.after || 'none'}.` }); }
  activity('voice-library', { ...row, at: undefined });
  return row;
}

// Wearing a voice: per conversation, kept on disk, and it stays until she takes it off, wears another or keeps
// one in her regular slot. No clock takes it off (a 30-minute timer did, silently, mid-evening).
const WORN_FILE = () => path.join(DATA_DIR, 'voice-worn.json');
const readWorn = () => { try { return existsSync(WORN_FILE()) ? JSON.parse(readFileSync(WORN_FILE(), 'utf8')) : {}; } catch { return {}; } };
const writeWorn = (all) => { try { writeFileSync(WORN_FILE(), JSON.stringify(all, null, 2)); } catch (err) { activity('error', { where: 'voice worn', message: `The voice she's wearing couldn't be saved to ${WORN_FILE()}: ${err.message}. It holds until a restart.` }); } };
const worn = new Map(Object.entries(readWorn())); // conversation -> { id, name, since, reason, by }
export function wear(conversation, { id, name = '', reason = '', by = 'her' }, now = Date.now()) {
  const before = worn.get(conversation) ?? null;
  worn.set(conversation, { id, name, since: now, reason: String(reason).slice(0, 160), by });
  writeWorn(Object.fromEntries(worn));
  logChange({ what: 'wear', conversation, before: before?.id ?? config.fish.voiceId ?? '', before_name: before?.name ?? 'her own voice', after: id, name, by, reason });
  return worn.get(conversation);
}
export function takeOff(conversation, { reason = '', by = 'her' } = {}) {
  const had = worn.get(conversation);
  if (!had) return null;
  worn.delete(conversation);
  writeWorn(Object.fromEntries(worn));
  logChange({ what: 'take off', conversation, before: had.id, before_name: had.name, after: config.fish.voiceId ?? '', name: 'her own voice', by, reason });
  return had;
}
export function wornVoice(conversation) { return worn.get(conversation) ?? null; }
// For her prompt: which voice she's speaking in here, and why, so she never has to guess when someone asks.
export function voiceLine(conversation) {
  const w = conversation && wornVoice(conversation);
  const last = history(1)[0];
  return w
    ? `You're speaking in the voice "${w.name}" (worn since ${new Date(w.since).toLocaleTimeString()}${w.reason ? `, because: ${w.reason}` : ''}); your regular voice is underneath it until you take it off.`
    : `You're speaking in your regular voice${last ? ` (the last change to your voice: ${last.what ?? 'keep'} "${last.name ?? last.after}" at ${new Date(last.at).toLocaleString()} by ${last.by}${last.reason ? `, because: ${last.reason}` : ''})` : ''}.`;
}

export function history(limit = 15) {
  try { return existsSync(HISTORY_FILE()) ? readFileSync(HISTORY_FILE(), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).slice(-limit) : []; }
  catch { return []; }
}
// Save a voice into one of her slots. by: who asked. Returns the logged change.
export function keep(slot, { id, name = '', by = '', reason = '' }) {
  if (!SLOTS[slot]) throw new Error(`Choose a slot: ${Object.keys(SLOTS).join(', ')}.`);
  const before = config.fish[SLOT_FIELD[slot]] || '';
  updateSettings({ [SLOTS[slot]]: id });
  return logChange({ what: 'keep', slot, before, after: id, name, by, reason });
}
// Her voice settings changed some other way (the dashboard's settings form): each slot that actually changed is logged.
export function noteSettings(before = {}, after = {}, { by = 'dashboard', reason = 'saved in the dashboard settings' } = {}) {
  for (const [slot, key] of Object.entries(SLOTS)) {
    if ((before[key] ?? '') !== (after[key] ?? '')) logChange({ what: 'settings', slot, before: before[key] ?? '', after: after[key] ?? '', name: after[key] ? 'set by ID' : 'none', by, reason });
  }
  if ((before.ttsProvider ?? '') !== (after.ttsProvider ?? '')) logChange({ what: 'speech provider', before: before.ttsProvider ?? '', after: after.ttsProvider ?? '', name: after.ttsProvider, by, reason });
}

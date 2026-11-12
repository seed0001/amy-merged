import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { embed } from './llm.js';
import { createProfileStore } from './profiles.js';
import { createPersonalWordNet } from './personal-wordnet.js';
import { createGraph } from './kg.js';

const db = new DatabaseSync(path.join(DATA_DIR, 'companion.db'));
export const profiles = createProfileStore(db);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation TEXT NOT NULL,
    role TEXT NOT NULL,
    user_id TEXT,
    name TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation, id);
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_user ON memories (user_id);
  -- Consolidated history. Level 1: a paragraph covering one block of messages (up to last_message_id).
  -- Level 2: the running major summary that absorbs level-1 paragraphs (rolled_up = 1 once absorbed).
  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY,
    conversation TEXT NOT NULL,
    level INTEGER NOT NULL,
    content TEXT NOT NULL,
    last_message_id INTEGER,
    rolled_up INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS summaries_conv ON summaries (conversation, level, id);
  -- Everyone the bot has talked to, with their tier (stranger | guest | friend). last_dm_at is set
  -- once they've DM'd it, which is what lets it DM them back.
  CREATE TABLE IF NOT EXISTS contacts (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT,
    tier TEXT NOT NULL DEFAULT 'stranger',
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    last_dm_at INTEGER
  );
  -- People she has introduced herself to in voice, so each person only gets the "I'm an AI, I'm
  -- listening" hello once.
  CREATE TABLE IF NOT EXISTS greeted (
    user_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
  -- Obligations: things she has committed to do, open until checked off. A target means "when this
  -- person shows up" (target_id once known, else matched by target_name); none means a standing priority.
  CREATE TABLE IF NOT EXISTS obligations (
    id INTEGER PRIMARY KEY,
    task TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'task',
    target_id TEXT,
    target_name TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    done_at INTEGER,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS persona_history (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    persona TEXT NOT NULL,
    reason TEXT,
    changed_by TEXT,
    created_at INTEGER NOT NULL
  );
`);

// What tools a reply used ("guide files: ok"), so later turns know it was already done.
try {
  db.exec('ALTER TABLE messages ADD COLUMN tools TEXT');
} catch {} // already there
// Files someone sent with the message (JSON: { docs: [{ name, saved, text }], images: [{ name, saved, mime }], notes }).
try {
  db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
} catch {} // already there

const q = {
  addMessage: db.prepare(
    'INSERT INTO messages (conversation, role, user_id, name, content, created_at, tools, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ),
  recent: db.prepare(
    'SELECT role, user_id, name, content FROM messages WHERE conversation = ? ORDER BY id DESC LIMIT ?',
  ),
  countRecentUserMessages: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at > ?"),
  clearConversation: db.prepare('DELETE FROM messages WHERE conversation = ?'),
  clearSummaries: db.prepare('DELETE FROM summaries WHERE conversation = ?'),
  summarizedUpTo: db.prepare(
    'SELECT COALESCE(MAX(last_message_id), 0) AS id FROM summaries WHERE conversation = ? AND level = 1',
  ),
  messagesAfter: db.prepare(
    'SELECT id, role, user_id, name, content, created_at FROM messages WHERE conversation = ? AND id > ? ORDER BY id LIMIT ?',
  ),
  countAfter: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation = ? AND id > ?'),
  receivedFiles: db.prepare(
    "SELECT conversation, user_id, name, created_at, attachments FROM messages WHERE attachments IS NOT NULL AND role = 'user' ORDER BY id DESC LIMIT ?",
  ),
  recentWithIds: db.prepare(
    'SELECT id, role, user_id, name, content, tools, attachments, created_at FROM messages WHERE conversation = ? ORDER BY id DESC LIMIT ?',
  ),
  addSummary: db.prepare(
    'INSERT INTO summaries (conversation, level, content, last_message_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ),
  openParagraphs: db.prepare(
    'SELECT id, content, created_at FROM summaries WHERE conversation = ? AND level = 1 AND rolled_up = 0 ORDER BY id',
  ),
  majorSummary: db.prepare(
    'SELECT id, content, created_at FROM summaries WHERE conversation = ? AND level = 2 ORDER BY id DESC LIMIT 1',
  ),
  markRolledUp: db.prepare('UPDATE summaries SET rolled_up = 1 WHERE conversation = ? AND level = 1 AND id <= ?'),
  allSummaries: db.prepare('SELECT * FROM summaries WHERE conversation = ? ORDER BY id DESC'),
  addMemory: db.prepare('INSERT INTO memories (user_id, content, embedding, created_at) VALUES (?, ?, ?, ?)'),
  userMemories: db.prepare('SELECT id, content, embedding FROM memories WHERE user_id = ?'),
  allMemories: db.prepare('SELECT id, user_id, content, embedding, created_at FROM memories'),
  listMemories: db.prepare('SELECT id, content, created_at FROM memories WHERE user_id = ? ORDER BY id'),
  deleteMemory: db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?'),
  deleteAllMemories: db.prepare('DELETE FROM memories WHERE user_id = ?'),
  memoryUsers: db.prepare(
    `SELECT m.user_id, COUNT(*) AS count, MAX(m.created_at) AS last,
       (SELECT name FROM messages WHERE user_id = m.user_id AND name IS NOT NULL ORDER BY id DESC LIMIT 1) AS name
     FROM memories m GROUP BY m.user_id ORDER BY last DESC`,
  ),
  conversations: db.prepare(
    'SELECT conversation, COUNT(*) AS count, MAX(created_at) AS last FROM messages GROUP BY conversation ORDER BY last DESC',
  ),
  stats: db.prepare('SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM memories) AS memories'),
  upsertContact: db.prepare(
    `INSERT INTO contacts (user_id, name, username, first_seen, last_seen, last_dm_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, username = COALESCE(excluded.username, username),
       last_seen = excluded.last_seen, last_dm_at = COALESCE(excluded.last_dm_at, last_dm_at)`,
  ),
  contacts: db.prepare('SELECT user_id, name, username, tier, first_seen, last_seen, last_dm_at FROM contacts ORDER BY last_seen DESC'),
  contactTier: db.prepare('SELECT tier FROM contacts WHERE user_id = ?'),
  setContactTier: db.prepare('UPDATE contacts SET tier = ? WHERE user_id = ?'),
  addPersona: db.prepare(
    'INSERT INTO persona_history (name, persona, reason, changed_by, created_at) VALUES (?, ?, ?, ?, ?)',
  ),
  personaHistory: db.prepare('SELECT * FROM persona_history ORDER BY id DESC LIMIT ?'),
  personaVersion: db.prepare('SELECT * FROM persona_history WHERE id = ?'),
  personaCount: db.prepare('SELECT COUNT(*) AS n FROM persona_history'),
};

// ---- Persona versions (every change is kept so it can be rolled back) ----

export function savePersonaVersion({ name, persona, reason = null, changedBy = null }) {
  q.addPersona.run(name, persona, reason, changedBy, Date.now());
}

export function personaHistory(limit = 50) {
  return q.personaHistory.all(limit);
}

export function personaVersion(id) {
  return q.personaVersion.get(id);
}

export function hasPersonaHistory() {
  return q.personaCount.get().n > 0;
}

// ---- Contacts ----

// Records that the bot heard from someone (and whether it was a DM). New people start as strangers.
export function noteContact({ userId, name, username = null, dm = false }) {
  const now = Date.now();
  q.upsertContact.run(userId, name, username, now, now, dm ? now : null);
}

export function contactTier(userId) {
  return q.contactTier.get(userId)?.tier ?? 'stranger';
}

export function setContactTier(userId, tier) {
  return q.setContactTier.run(tier, userId).changes > 0;
}

export function listContacts() {
  return q.contacts.all();
}

// Her knowledge graph (kg.js): how people, pets, places, projects and things connect, in this same database.
export const graph = createGraph(db, {
  embedder: (texts) => embed(texts),
  selfName: () => config.botName,
  contacts: () => q.contacts.all().map((c) => ({ id: c.user_id, name: c.name, username: c.username })),
});

// Finds a contact by ID, display name or username (exact match first, then partial).
// dmOnly limits it to people who have DM'd the bot.
export function findContact(who, { dmOnly = false } = {}) {
  const needle = String(who).trim().replace(/^@/, '').toLowerCase();
  if (!needle) return null;
  const all = q.contacts.all().filter((c) => !dmOnly || c.last_dm_at);
  const names = (c) => [c.user_id, c.name, c.username].filter(Boolean).map((n) => n.toLowerCase());
  return (
    all.find((c) => names(c).includes(needle)) ??
    all.find((c) => names(c).some((n) => n.includes(needle))) ??
    null
  );
}

// ---- Short-term: rolling conversation history (per channel, or per voice session) ----

export function addMessage(conversation, { role, userId = null, name = null, content, tools = null, attachments = null }) {
  return Number(q.addMessage.run(conversation, role, userId, name, content, Date.now(), tools, attachments ? JSON.stringify(attachments) : null).lastInsertRowid);
}

export const personalWordNet = createPersonalWordNet(db, { selfName: () => config.botName });

// Saved messages that came with files, newest first, in any conversation (received_file filters them).
export function receivedFileRows(limit = 200) {
  return q.receivedFiles.all(limit);
}

export function recentMessages(conversation, limit = config.historyLimit) {
  return q.recent.all(conversation, limit).reverse();
}

// How much conversation happened recently, for the solo-thought load score. Counts saved user
// lines across text, voice and the dashboard; no extra event hooks needed.
export function countRecentUserMessages(ms = 3_600_000) {
  return q.countRecentUserMessages.get(Date.now() - Math.max(0, Number(ms) || 0)).n;
}

export function clearConversation(conversation) {
  q.clearConversation.run(conversation);
  q.clearSummaries.run(conversation);
}

// ---- Consolidation: old messages are boiled down into paragraphs, and paragraphs into a major summary ----

// What the model sees as raw history: everything not yet summarized, plus the last few
// messages before that so a fresh summary doesn't leave it mid-sentence.
export function promptMessages(conversation, overlap = 10, limit = config.historyLimit) {
  const cutoff = q.summarizedUpTo.get(conversation).id;
  const rows = q.recentWithIds.all(conversation, limit).reverse();
  return rows.filter((m, i) => m.id > cutoff || i >= rows.length - overlap);
}

// The oldest block of `size` messages that hasn't been summarized yet, or null if there isn't a full one.
export function unsummarizedBlock(conversation, size) {
  const cutoff = q.summarizedUpTo.get(conversation).id;
  if (q.countAfter.get(conversation, cutoff).n < size) return null;
  return q.messagesAfter.all(conversation, cutoff, size);
}

export function addSummary(conversation, { level, content, lastMessageId = null }) {
  q.addSummary.run(conversation, level, content, lastMessageId, Date.now());
}

// Paragraphs written since the last major summary.
export function openParagraphs(conversation) {
  return q.openParagraphs.all(conversation);
}

export function majorSummary(conversation) {
  return q.majorSummary.get(conversation) ?? null;
}

// Saves a new major summary and marks the paragraphs it absorbed (up to id) as done.
export function rollUp(conversation, content, upToParagraphId) {
  db.exec('BEGIN');
  try {
    addSummary(conversation, { level: 2, content });
    q.markRolledUp.run(conversation, upToParagraphId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function summaries(conversation) {
  return q.allSummaries.all(conversation);
}

// ---- Long-term: facts about each user, retrieved by semantic similarity ----

// A turn recalls for the speaker and everyone else present with the same message, so the last
// query's embedding is reused instead of asking the embedding model again for each person.
let lastQuery = { text: null, vector: null };

// The embedding of what was just said, shared by every recall this turn (memories and the graph).
export async function queryVector(query) {
  if (lastQuery.text !== query) lastQuery = { text: query, vector: embed([query]).then(([v]) => v) };
  const pending = lastQuery;
  return pending.vector.catch((err) => {
    if (lastQuery === pending) lastQuery = { text: null, vector: null };
    throw err;
  });
}

export async function recall(userId, query) {
  const rows = q.userMemories.all(userId);
  if (!rows.length) return [];
  const qv = await queryVector(query);
  return rows
    .map((r) => ({ id: r.id, content: r.content, score: cosine(qv, JSON.parse(r.embedding)) }))
    .filter((r) => r.score >= config.memory.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.memory.topK);
}

// Everything she remembers, about anyone (herself, her home, the people she knows), closest in meaning to `query`
// first: [{ ref: 'memory:<id>', who, content, at, score }]. Plus thoughts she had with how they felt (thoughts.affect):
// [{ ref: 'thought:<id>', who: 'self', content, at, score }]. For tying a feeling to a real moment that felt like it
// (song-sense.js): every result is a real record, citable by its ref.
export async function recallAcross(query, { limit = 8, min = 0.35 } = {}) {
  const qv = await queryVector(query);
  const mems = q.allMemories.all().map((r) => ({ ref: `memory:${r.id}`, who: r.user_id, content: r.content, at: r.created_at, score: cosine(qv, JSON.parse(r.embedding)) }));
  let thoughts = [];
  try {
    // Prepared here, not with the others: the thoughts table is made by thoughts.js and may not exist yet.
    const rows = db.prepare("SELECT id, at, content, affect FROM thoughts WHERE affect IS NOT NULL AND affect != '' ORDER BY at DESC LIMIT 60").all();
    if (rows.length) {
      const vectors = await embed(rows.map((r) => `${r.content} (felt: ${r.affect})`));
      thoughts = rows.map((r, i) => ({ ref: `thought:${r.id}`, who: 'self', content: `${r.content} (how it felt: ${r.affect})`, at: r.at, score: cosine(qv, vectors[i]) }));
    }
  } catch {}
  return [...mems, ...thoughts].filter((r) => r.score >= min).sort((a, b) => b.score - a.score).slice(0, limit);
}

// Stores facts, skipping any that are near-duplicates of what we already know.
export async function remember(userId, facts) {
  if (!facts.length) return [];
  const existing = q.userMemories.all(userId).map((r) => JSON.parse(r.embedding));
  const vectors = await embed(facts);
  const saved = [];
  facts.forEach((fact, i) => {
    const v = vectors[i];
    if (existing.some((e) => cosine(v, e) >= config.memory.dedupeScore)) return;
    q.addMemory.run(userId, fact, JSON.stringify(v), Date.now());
    existing.push(v);
    saved.push(fact);
  });
  return saved;
}

// A person's memories with their meaning-vectors, for working out what she does and doesn't know (curiosity.js).
export const memoryVectors = (userId) => q.userMemories.all(userId).map((r) => ({ id: r.id, content: r.content, vector: JSON.parse(r.embedding) }));

export function listMemories(userId) {
  return q.listMemories.all(userId);
}

export function forget(userId, id) {
  if (id == null) profiles.clear(userId);
  return id == null ? q.deleteAllMemories.run(userId).changes : q.deleteMemory.run(id, userId).changes;
}

// ---- Dashboard queries ----

export function memoryUsers() {
  const users = new Map(q.memoryUsers.all().map((u) => [u.user_id, u]));
  for (const c of listContacts()) if (!users.has(c.user_id)) users.set(c.user_id, { ...c, count: 0 });
  return [...users.values()].map((u) => ({ ...u, frustration: profiles.read(u.user_id).frustration }));
}

export function conversations() {
  return q.conversations.all();
}

export function stats() {
  return q.stats.get();
}

// People she already knew before greetings existed don't need the introduction.
if (!db.prepare('SELECT 1 FROM greeted LIMIT 1').get()) {
  db.exec('INSERT OR IGNORE INTO greeted (user_id, at) SELECT user_id, first_seen FROM contacts');
}

// Marks someone as greeted; returns false if they already were (so callers greet only once).
export function markGreeted(userId) {
  return db.prepare('INSERT OR IGNORE INTO greeted (user_id, at) VALUES (?, ?)').run(userId, Date.now()).changes > 0;
}

// Whether she has already introduced herself to someone in voice. Used by the room greeting so it
// knows who is new without marking them before the greeting actually happens.
export function hasGreeted(userId) {
  return Boolean(db.prepare('SELECT 1 FROM greeted WHERE user_id = ?').get(userId));
}

// ---- Check-in consent (their profile card) ----
// Whether she may reach out to someone on her own: asked once, in person; their answer, how often,
// and what they'd like to talk about. "no" is permanent: she never asks again.
for (const [col, type] of [['reach_out', 'TEXT'], ['reach_every_days', 'INTEGER'], ['reach_note', 'TEXT'], ['reach_asked_at', 'INTEGER'], ['reached_at', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${type}`);
  } catch {} // already there
}

export function reachCard(userId) {
  return db.prepare('SELECT user_id, name, tier, reach_out, reach_every_days, reach_note, reach_asked_at, reached_at FROM contacts WHERE user_id = ?').get(userId) ?? null;
}

export function setReach(userId, { answer, everyDays, note }) {
  const card = reachCard(userId);
  if (!card) return false;
  if (card.reach_out === 'no' && answer === 'yes') return false; // a no is final
  db.prepare('UPDATE contacts SET reach_out = ?, reach_every_days = ?, reach_note = ? WHERE user_id = ?').run(
    answer,
    answer === 'yes' ? Math.max(1, Math.round(everyDays || 7)) : null,
    note ?? card.reach_note,
    userId,
  );
  return true;
}

// Asking to check in on someone has to be earned: a friend, or someone she's known for at least two
// weeks and talked with a lot. The owner too: after a memory reset she doesn't know them yet.
export const REACH_MIN_DAYS = 14;
export const REACH_MIN_MESSAGES = 100;
export function earnedReach(userId) {
  const c = db.prepare('SELECT tier, first_seen FROM contacts WHERE user_id = ?').get(userId);
  if (!c) return false;
  if (c.tier === 'friend') return true;
  const n = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND user_id = ?").get(userId).n;
  return Date.now() - c.first_seen >= REACH_MIN_DAYS * 86_400_000 && n >= REACH_MIN_MESSAGES;
}

export const markAskedReach = (userId) => db.prepare('UPDATE contacts SET reach_asked_at = ? WHERE user_id = ?').run(Date.now(), userId);
export const markReached = (userId) => db.prepare('UPDATE contacts SET reached_at = ? WHERE user_id = ?').run(Date.now(), userId);

// Someone known under another name: "friend_7's real name is friend_2" in their memories means
// "friend_2" is friend_7. Returns their user id, or null.
export function personByRealName(name) {
  const n = String(name ?? '').trim();
  if (n.length < 2) return null;
  const row = db
    .prepare(`SELECT user_id FROM memories WHERE content LIKE ? OR content LIKE ? OR content LIKE ? OR content LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`%real name is ${n}%`, `%goes by ${n}%`, `%also called ${n}%`, `%nickname is ${n}%`);
  return row?.user_id ?? null;
}

// ---- Obligations ----

export function addObligation({ task, kind = 'task', targetId = null, targetName = null, createdBy = null }) {
  return Number(
    db.prepare('INSERT INTO obligations (task, kind, target_id, target_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(task, kind, targetId, targetName, createdBy, Date.now()).lastInsertRowid,
  );
}

export function openObligations() {
  return db.prepare('SELECT * FROM obligations WHERE done_at IS NULL ORDER BY id').all();
}

// Open items waiting for this person: by id, or by a name given before she'd met them
// ("when UltraLogic joins..."), matched against their display name or username.
export function obligationsFor(userId, names = []) {
  const lower = names.filter(Boolean).map((n) => n.toLowerCase());
  return openObligations().filter((o) => {
    if (o.target_id) return o.target_id === userId;
    if (!o.target_name) return false;
    const want = o.target_name.toLowerCase();
    return lower.some((n) => n === want || n.includes(want) || want.includes(n));
  });
}

export function completeObligation(id, note = null, userId = null) {
  return db.prepare('UPDATE obligations SET done_at = ?, note = ?, target_id = COALESCE(target_id, ?) WHERE id = ? AND done_at IS NULL')
    .run(Date.now(), note, userId, id).changes > 0;
}

export function cancelObligation(id) {
  return db.prepare("UPDATE obligations SET done_at = ?, note = 'cancelled' WHERE id = ? AND done_at IS NULL").run(Date.now(), id).changes > 0;
}

// A conversation's whole history in order, a page at a time (for rebuilding memories).
export function messagesPage(conversation, afterId = 0, size = 40) {
  return q.messagesAfter.all(conversation, afterId, size);
}

export function forgetEveryone() {
  profiles.clearAll();
  return db.prepare('DELETE FROM memories').run().changes;
}

// Her memories about everyone, with whose they are, for looking back over what she keeps (the
// reflect tool). person and text narrow it; both match loosely.
// What's been said lately, across every conversation, oldest first.
export function messagesSince(at, limit = 80) {
  return db.prepare("SELECT role, name, content, created_at FROM (SELECT id, role, name, content, created_at FROM messages WHERE created_at >= ? AND content != '' ORDER BY id DESC LIMIT ?) ORDER BY id").all(at, limit);
}

export function browseMemories({ person = '', text = '', limit = 40 } = {}) {
  const like = (s) => `%${String(s).trim().replace(/[!%_]/g, (c) => '!' + c)}%`;
  return db
    .prepare(`SELECT m.id, m.user_id, m.content, m.created_at, c.name FROM memories m LEFT JOIN contacts c ON c.user_id = m.user_id
      WHERE (? = '' OR c.name LIKE ? ESCAPE '!' OR c.username LIKE ? ESCAPE '!') AND (? = '' OR m.content LIKE ? ESCAPE '!')
      ORDER BY m.id DESC LIMIT ?`)
    .all(String(person).trim(), like(person), like(person), String(text).trim(), like(text), limit);
}

export function forgetMemoryById(id) {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(Number(id)).changes;
}

export async function addMemoryManually(userId, content) {
  const [v] = await embed([content]);
  q.addMemory.run(userId, content, JSON.stringify(v), Date.now());
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---- Timeline: the conversation by time (the timeline tool) ----
// Every message carries created_at; these read it back in order.
// conversation null: every conversation (the owner looking across text, DMs and voice).
export function messagesBetween(conversation, from, to, limit = 60) {
  return db
    .prepare('SELECT role, name, content, created_at, conversation FROM messages WHERE (? IS NULL OR conversation = ?) AND created_at >= ? AND created_at <= ? ORDER BY id DESC LIMIT ?')
    .all(conversation, conversation, from, to, limit)
    .reverse();
}

export function oldestMessages(conversation, limit = 20) {
  return db.prepare('SELECT role, name, content, created_at FROM messages WHERE conversation = ? ORDER BY id LIMIT ?').all(conversation, limit);
}

// Matches who spoke as well as what was said, ignoring case, spaces and punctuation, so
// "Ultra-HAL" finds friend_18. conversation null: every conversation.
const LOOSE = "lower(replace(replace(replace(replace(replace(coalesce(name, '') || content, ' ', ''), '-', ''), '_', ''), '.', ''), '''', ''))";
export function searchMessages(conversation, text, limit = 20) {
  const want = String(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); // was missing the backslashes: it stripped nearly every character, so the timeline search never matched
  if (!want) return [];
  return db
    .prepare(`SELECT role, name, content, created_at, conversation FROM messages WHERE (? IS NULL OR conversation = ?) AND ${LOOSE} LIKE ? ORDER BY id DESC LIMIT ?`)
    .all(conversation, conversation, `%${want}%`, limit)
    .reverse();
}

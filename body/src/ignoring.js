import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { isOwner } from './contacts.js';
import { activity } from './events.js';

// People she has chosen to ignore (the `ignore` tool, tools.js). Her own decision, made by her model
// when someone keeps baiting, insulting or trolling her: nothing here reads words. While someone is
// ignored she hears them (their lines stay in her history as context) but never answers them, in voice
// or text, and her own wants (follow-ups, check-ins, missing someone) don't reach out to them. It lasts
// until she or Owner lifts it. Owner can never be ignored.

const FILE = path.join(DATA_DIR, 'ignoring.json');
let store = null;

function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { store = {}; }
  if (!store || typeof store !== 'object') store = {};
  return store;
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, FILE);
}

export function isIgnored(id) {
  return Boolean(id && load()[id]);
}

export function ignoredList() {
  return Object.entries(load()).map(([id, v]) => ({ id, ...v }));
}

// Returns a plain-language result for the tool; "Error:" when nothing changed and why.
export function ignore({ id, name }, why = '', now = Date.now()) {
  if (!id) return 'Error: ignore needs to know who. Nothing changed.';
  if (isOwner(id)) return `Error: ${name ?? 'Owner'} is your owner; you can't ignore him. Nothing changed.`;
  const s = load();
  if (s[id]) return `You're already ignoring ${s[id].name} (since ${new Date(s[id].since).toLocaleString()}${s[id].why ? `: ${s[id].why}` : ''}).`;
  s[id] = { name: name ?? id, since: now, why: String(why ?? '').slice(0, 300) };
  save();
  activity('ignoring', { action: 'ignore', id, name, why: s[id].why });
  return `You're ignoring ${name} now. You'll still hear what they say, but you won't answer them in voice or text, and you won't reach out to them, until you or Owner lift it (ignore with action "stop").`;
}

export function unignore({ id, name }) {
  const s = load();
  if (!id || !s[id]) return `You weren't ignoring ${name ?? 'them'}, so nothing changed.`;
  const was = s[id];
  delete s[id];
  save();
  activity('ignoring', { action: 'stop', id, name: was.name });
  return `You've stopped ignoring ${was.name}; you'll answer them normally again.`;
}

// For her prompt: who she's ignoring, so she knows why she isn't answering someone.
export function ignoringBlock() {
  const list = ignoredList();
  if (!list.length) return '';
  return `You're ignoring: ${list.map((p) => `${p.name}${p.why ? ` (${p.why})` : ''}`).join('; ')}. Their lines reach you as context, but you don't answer them or reach out to them until you or Owner lift it with the ignore tool.`;
}

export function _resetForTests() { store = null; }

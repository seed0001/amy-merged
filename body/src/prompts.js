import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, DATA_DIR, updateSettings } from './config.js';
import { innerCore } from './inner-core.js';

export const PROMPTS = {
  inner_life: 'Local inner-life guidance', persona: 'Persona',
  intuition: 'Her intuition: what the always-listening local model is told to look for',
  self_dialogue_local: 'Private self-dialogue: local perspective', self_dialogue_cloud: 'Private self-dialogue: cloud perspective',
  conversation: 'Conversation', reply_planning: 'Reply planning',
  solo_thought: 'Solo thinking', research_plan: 'Research planning', journal: 'Research journal',
  brief: 'Scheduled briefs', helper: 'Background research and project worker',
  memory: 'Memory extraction', summary: 'Memory summaries', profile: 'Relationship learning',
  topics: 'Topic classification and summaries', voice_turn: 'Voice turn decisions',
  background_json: 'Other local JSON tasks', background_text: 'Other local text tasks',
  vision: 'Image descriptions', image: 'Image generation', music: 'Music generation',
};
const FILE = path.join(DATA_DIR, 'prompt-edits.json');
const load = () => existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
let snapshots;
function promptSnapshots() {
  if (!snapshots) {
    snapshots = new DatabaseSync(path.join(DATA_DIR, 'companion.db'));
    snapshots.exec('CREATE TABLE IF NOT EXISTS prompt_builtins (id TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL)');
  }
  return snapshots;
}
export function getPrompt(id) {
  const item = listPrompts().find((p) => p.id === id);
  if (!item) throw new Error('Choose a prompt ID from the list.');
  if (id === 'persona' || id === 'inner_life') return { ...item, builtin: item.template, builtin_at: null };
  const builtin = promptSnapshots().prepare('SELECT text, at FROM prompt_builtins WHERE id = ?').get(id);
  return { ...item, builtin: builtin?.text ?? null, builtin_at: builtin?.at ?? null,
    note: 'Latest built-in instructions before your saved edit. Variable context is regenerated on each call; it is never copied into the editable template.' };
}
export function listPrompts() {
  const edits = load();
  return Object.entries(PROMPTS).map(([id, label]) => ({ id, label,
    template: id === 'inner_life' ? innerCore.promptState('inner_life') : id === 'persona' ? config.persona : edits[id]?.template ?? '{{original}}',
    edited: id === 'inner_life' ? Boolean(innerCore.promptState('inner_life')) : id === 'persona' || Boolean(edits[id]),
  }));
}
export function editPrompt(id, template, reset = false) {
  if (!Object.hasOwn(PROMPTS, id)) throw new Error('Choose a prompt ID from the list.');
  if (typeof template !== 'string' || template.length > 24000) throw new Error('Prompt text must be at most 24000 characters.');
  // Her inner-life guidance is hers alone (owner, 2026-11-09): she writes it when she ponders herself
  // (self-work.js), and nobody edits it from here, the owner included.
  if (id === 'inner_life') throw new Error("Her inner-life guidance is hers: she writes it herself when she thinks about who she is, and nobody else can set it, her owner included. It can be read here, not edited.");
  else if (id === 'persona') {
    if (reset) throw new Error('Edit the persona or restore a version from persona history.');
    updateSettings({ persona: template });
  } else {
    if (!reset && !template.trim()) throw new Error('Give prompt text, or reset it.');
    const edits = load();
    if (reset) delete edits[id]; else edits[id] = { template: template.trim(), at: Date.now() };
    writeFileSync(`${FILE}.tmp`, JSON.stringify(edits, null, 2)); renameSync(`${FILE}.tmp`, FILE);
  }
  return getPrompt(id);
}
// Templates are saved separately from live context. {{original}} expands anew for every call.
export function promptText(id, original) {
  // Capture the built-in instruction block only, not user messages, tools or request payloads.
  promptSnapshots().prepare('INSERT INTO prompt_builtins (id, text, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, at = excluded.at')
    .run(id, String(original), Date.now());
  const template = load()[id]?.template ?? '{{original}}';
  return template.replaceAll('{{original}}', String(original));
}
export function promptMessages(id, messages) {
  let found = false;
  const out = messages.map((m) => {
    if (found || m.role !== 'system') return m;
    found = true;
    return { ...m, content: promptText(id, m.content) };
  });
  if (!found && load()[id]) out.unshift({ role: 'system', content: promptText(id, '') });
  return out;
}

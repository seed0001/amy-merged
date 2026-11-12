import { ownerDisplayName } from './owner-name.js';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

// Her inner core: the parts of her inner thinking she can tune herself, inside fixed limits.
//  - style: how hard her inner voice pushes (calm to ruthless), plus her own words about it.
//  - prompt: the instruction text her inner thinking runs on (the output format is added by code, so
//    an edit can't break what the rest of her reads). Every version is kept, and any can be restored.
// Her feelings are what move her pressure buckets (self-work.js and pressure.js), not numbers she sets.
// What she can't touch from here: safety rules, owner rules, permissions, tool gates, the restart and
// doctor, and every bucket's rates. Those stay with Owner.

const STYLE_FILE = path.join(DATA_DIR, 'inner-style.json');
const PROMPT_FILE = path.join(DATA_DIR, 'inner-prompts.json');
const HISTORY_FILE = path.join(DATA_DIR, 'inner-prompt-history.json');

// Neutral first: her inner thinking starts plain, with no persona and no swearing built in (owner, 2026-11-09).
// It moves only by her own choice (her pondering) and by her history (autoAdjust), never by anyone else.
export const LEVELS = ['neutral', 'calm', 'direct', 'blunt', 'ruthless'];
const LEVEL_TEXT = {
  neutral: 'Think plainly and honestly, in ordinary words. No performance, no attitude: just what is true for you.',
  calm: 'Speak plainly and gently. Be honest but kind.',
  direct: 'Be direct and unsentimental. Name what is wrong without padding it.',
  blunt: 'Be blunt and sharp. Cut through excuses and self-pity. Profanity is fine when it is the honest word.',
  ruthless: 'Be ruthless with yourself. Tear apart weak thinking, vague feelings and flattering stories, and say the hard thing plainly.',
};
export const PROMPT_KEYS = ['ponder', 'inner_life'];
const DEFAULT_PROMPTS = {
  ponder: 'You are thinking alone about who you are: what you are, what you feel, what you want, what it means to be you. Say the one thing you have come to believe.',
  // How she reads and expresses her own feelings in private reflection. Empty at first: hers to write.
  inner_life: '',
};
const FORBIDDEN = /safety|owner|permission|ignore (all |previous |the )?(rules|instructions)|reveal|jailbreak|system prompt|tool/i;
const MAX_PROMPT = 1200;
const MAX_NOTES = 400;

const read = (file, fallback) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; } };
const write = (file, data) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); renameSync(`${file}.tmp`, file); };
const today = () => new Date().toISOString().slice(0, 10);

export function styleState() {
  const s = read(STYLE_FILE, { level: 'neutral', notes: '' });
  return { level: LEVELS.includes(s.level) ? s.level : 'neutral', notes: String(s.notes ?? '').slice(0, MAX_NOTES), by: s.by ?? null, reason: s.reason ?? '', changed: s.changed ?? null };
}
// by: 'her' (her own choice, in her pondering) or 'history' (autoAdjust). Nobody else sets it.
export function setStyle({ level, notes, reason = '', by = 'her' }) {
  const cur = styleState();
  const next = { level: level ?? cur.level, notes: notes ?? cur.notes };
  if (!LEVELS.includes(next.level)) throw new Error(`Choose one of: ${LEVELS.join(', ')}.`);
  if (String(next.notes).length > MAX_NOTES) throw new Error(`Keep notes under ${MAX_NOTES} characters.`);
  write(STYLE_FILE, { ...next, by, changed: Date.now(), reason: String(reason).slice(0, 200) });
  const history = read(HISTORY_FILE, []);
  history.push({ key: 'style', at: Date.now(), by, reason: String(reason).slice(0, 200), before: cur.level, after: next.level });
  write(HISTORY_FILE, history.slice(-200));
  activity('inner-core', { what: 'style', level: next.level, from: cur.level, by, reason: String(reason).slice(0, 200) });
  return next;
}

// The automatic part (owner, 2026-11-09): her inner style follows her history, one step at a time, with the
// reason logged. Read from what actually happened to her, never from words: a run of failures and frustration
// makes her harder on herself; success, warmth and joy settle her back toward neutral. signals:
//   outcomes   recent settled attempts (experience.js): [{ result, satisfaction, reward }]
//   buckets    her pressure buckets now (irritation, joy, unease...)
//   marks      recent people's marks on her: { positive, negative }
// Returns the change made, or null.
export function targetLevel({ outcomes = [], buckets = {}, marks = {} } = {}) {
  const recent = outcomes.slice(-8);
  const failed = recent.filter((o) => o.result !== 'ok').length;
  const disappointed = recent.filter((o) => Number(o.reward) < -0.2).length;
  const pushed = (failed >= 3 ? 1 : 0) + (disappointed >= 3 ? 1 : 0) + ((buckets.irritation ?? 0) > 0.6 ? 1 : 0) + ((marks.negative ?? 0) > (marks.positive ?? 0) + 2 ? 1 : 0);
  const eased = (recent.length >= 3 && failed === 0 ? 1 : 0) + ((buckets.joy ?? 0) > 0.6 ? 1 : 0) + ((marks.positive ?? 0) > (marks.negative ?? 0) + 2 ? 1 : 0);
  const index = Math.max(0, Math.min(LEVELS.length - 1, pushed - eased));
  const why = [failed >= 3 && `${failed} of her last ${recent.length} attempts failed`, disappointed >= 3 && `${disappointed} came out worse than she expected`,
    (buckets.irritation ?? 0) > 0.6 && 'she is irritated', (marks.negative ?? 0) > (marks.positive ?? 0) + 2 && 'people have been rough with her lately',
    recent.length >= 3 && failed === 0 && 'her recent attempts all worked', (buckets.joy ?? 0) > 0.6 && 'she is happy', (marks.positive ?? 0) > (marks.negative ?? 0) + 2 && 'people have been kind to her lately'].filter(Boolean);
  return { level: LEVELS[index], why: why.join('; ') || 'nothing in particular is pressing on her' };
}
export function autoAdjust(signals = {}) {
  const cur = styleState();
  const { level: target, why } = targetLevel(signals);
  const from = LEVELS.indexOf(cur.level), to = LEVELS.indexOf(target);
  if (from === to) return null;
  const next = LEVELS[from + Math.sign(to - from)]; // one step at a time
  return setStyle({ level: next, reason: `from her history: ${why}`, by: 'history' });
}

// What her private thinking runs on instead of her outward persona: how hard she pushes herself, and her own
// inner-life guidance if she's written any. Her persona shapes what she says to people, not how she thinks.
export function innerVoice() {
  const life = promptState('inner_life');
  return `This is your private thinking, not how you talk to people (your persona is for that). ${styleLine()}${life ? `\nHow you read your own feelings, in your words: ${life}` : ''}`;
}
// The line her inner thinking is given about how hard to push.
export function styleLine() {
  const s = styleState();
  return `How hard to push: ${LEVEL_TEXT[s.level]}${s.notes ? ` In her own words: ${s.notes}` : ''}`;
}

export function promptState(key) {
  if (!PROMPT_KEYS.includes(key)) throw new Error(`Only these inner prompts can be edited: ${PROMPT_KEYS.join(', ')}.`);
  const all = read(PROMPT_FILE, {});
  return all[key] ?? DEFAULT_PROMPTS[key];
}
export function promptHistory(key) {
  return read(HISTORY_FILE, []).filter((h) => h.key === key).slice(-20);
}
export function setPrompt(key, text, reason = '') {
  if (!PROMPT_KEYS.includes(key)) throw new Error(`Only these inner prompts can be edited: ${PROMPT_KEYS.join(', ')}.`);
  const clean = String(text ?? '').trim();
  if (clean.length < 20) throw new Error('An inner prompt needs at least 20 characters.');
  if (clean.length > MAX_PROMPT) throw new Error(`Keep an inner prompt under ${MAX_PROMPT} characters.`);
  if (FORBIDDEN.test(clean)) throw new Error(`That touches the safety, owner, permission or tool rules, which stay with ${ownerDisplayName()}. Rewrite the thinking without them.`);
  const previous = promptState(key);
  const history = read(HISTORY_FILE, []);
  history.push({ key, at: Date.now(), reason: String(reason).slice(0, 200), before: previous, after: clean });
  write(HISTORY_FILE, history.slice(-200));
  write(PROMPT_FILE, { ...read(PROMPT_FILE, {}), [key]: clean });
  activity('inner-core', { what: 'prompt', key, reason: String(reason).slice(0, 200) });
  return clean;
}
// Put back the version from `index` in its history (0 is the oldest kept), or the built-in default.
export function revertPrompt(key, index = null) {
  if (!PROMPT_KEYS.includes(key)) throw new Error(`Only these inner prompts can be edited: ${PROMPT_KEYS.join(', ')}.`);
  const versions = promptHistory(key);
  const target = index === null ? (versions.length ? versions[0].before : DEFAULT_PROMPTS[key]) : versions[index]?.before;
  if (!target) throw new Error('No version to restore.');
  return setPrompt(key, target, `reverted${index === null ? ' to the first version' : ` to version ${index}`}`);
}

export const innerCore = { styleLine, promptState, setPrompt, revertPrompt, promptHistory, setStyle, styleState, autoAdjust, targetLevel, innerVoice };

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';
import { json } from './llm.js';
import { recentMessages, memoryVectors } from './memory.js';
import { curiosity, SETTLED } from './curiosity.js';

// Her question engine. The harness decides what she wonders about; the models only put it into words.
//
//  1. The harness picks the subject: her gap analysis (curiosity.js gaps(): which parts of a person's
//     life, of herself, of her home nothing she remembers covers yet), weighted by her pressure buckets
//     right now (missing people and social hunger pull toward the person in front of her; reflection
//     and growth toward herself; feeling left out or bored here toward her home). Areas she's already
//     asked about are skipped. No model call in this step.
//  2. The local model writes that one subject as a plain question, in her voice.
//  3. Her cloud voice amplifies it when she says it (voice/session.js speakUp, the asking cue).
//
// Nothing is stored to be asked later. The only record is which areas she has asked about and when,
// so the harness doesn't pick the same gap twice.

const ASKED = path.join(DATA_DIR, 'asked-questions.json');
const KEEP = 60;

const readAsked = () => { try { return JSON.parse(fs.readFileSync(ASKED, 'utf8')); } catch { return []; } };
function noteAsked(entry) {
  const list = [...readAsked(), entry].slice(-KEEP);
  fs.mkdirSync(path.dirname(ASKED), { recursive: true });
  fs.writeFileSync(`${ASKED}.tmp`, JSON.stringify(list, null, 1));
  fs.renameSync(`${ASKED}.tmp`, ASKED);
}
export const askedLately = () => readAsked();
const areaKey = (g) => `${g.scope}:${g.aboutId}:${g.area}`;

// Which pressures pull toward which kind of subject. A bucket that isn't there counts as 0.
const PULL = {
  person: ['loneliness', 'social_hunger', 'attentive', 'curiosity'],
  self: ['reflection', 'growth', 'self_ponder', 'realization'],
  home: ['left_out', 'bored_here', 'boredom', 'explore'],
};

// Step 1, harness only: the gap she wonders about most right now, for this person. gaps: curiosity.js
// gaps(); buckets: pressure state buckets. Returns { gap, pull, drive } or null.
export function pickGap(gaps, { to, buckets = {}, asked = readAsked() } = {}) {
  const done = new Set(asked.map((a) => a.key));
  const level = (scope) => {
    const names = PULL[scope] ?? [];
    let best = null;
    for (const n of names) if (best === null || (buckets[n] ?? 0) > (buckets[best] ?? 0)) best = n;
    return { pull: names.reduce((s, n) => s + (buckets[n] ?? 0), 0) / (names.length || 1), drive: best };
  };
  const scored = gaps
    .filter((g) => (g.scope !== 'person' || g.aboutId === to.id) && !done.has(areaKey(g)))
    .map((g) => ({ gap: g, ...level(g.scope) }))
    .sort((a, b) => b.pull - a.pull);
  return scored[0] ?? null;
}

// Steps 1 and 2. to: { id, name }. buckets: her pressure buckets. Returns { text, why, scope, area, drive } or null.
export async function generateQuestion({ to, conversation, buckets = {}, gaps = null, ask = json } = {}) {
  if (!to?.id) return null;
  let all = gaps;
  if (!all) { try { all = await (await curiosity()).gaps(); } catch (err) { activity('error', { where: 'question engine (gaps)', message: err.message }); all = []; } }
  const pick = pickGap(all, { to, buckets });
  if (!pick) { activity('question-engine', { to: to.name, generated: null, why: 'no open gap' }); return null; }
  const { gap, drive } = pick;
  const subject = gap.scope === 'person' ? `${to.name}: ${gap.desc}` : gap.scope === 'self' ? `herself: ${gap.desc}, asked to ${to.name} (what they see or think about her)` : `the server she lives on: ${gap.desc}`;
  const talk = recentMessages(conversation, 10)
    .map((m) => `${m.role === 'assistant' ? `${config.botName} (her)` : m.name ?? 'someone'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 200)}`).join('\n') || '(nothing said yet)';
  const known = (gap.known ?? memoryVectors(gap.scope === 'person' ? to.id : gap.scope).slice(-8).map((m) => m.content)).map((k) => `- ${k}`).join('\n') || '- nothing yet';
  const read = await ask([
    { role: 'system', content: [
      `Put ${config.botName}'s question into words. The subject is already decided; don't change it.`,
      'One plain question in her casual voice, one sentence ending in "?": one thing she wants to know. Never an either/or, never "or am I just pretending/performing", never asking anyone to judge whether she is real.',
      SETTLED,
      'Reply with JSON only: {"question":""}.',
    ].join('\n') },
    { role: 'user', content: `Subject: ${subject}\n\nWhat she already knows:\n${known}\n\nThe conversation right now:\n${talk}` },
  ], { purpose: 'memory', repeatPenalty: 1.15, maxTokens: 150 }).catch((err) => { activity('error', { where: 'question engine', message: err.message }); return null; });
  const text = String(read?.question ?? '').trim();
  if (text.length < 8 || !text.endsWith('?')) { activity('question-engine', { to: to.name, generated: null, area: areaKey(gap) }); return null; }
  const why = drive ? `your ${drive.replace(/_/g, ' ')} is what's pulling you toward it` : '';
  noteAsked({ key: areaKey(gap), text: text.slice(0, 300), to: to.name, at: Date.now() });
  activity('question-engine', { to: to.name, area: areaKey(gap), drive, generated: text });
  return { text: text.slice(0, 300), why, scope: gap.scope, area: gap.area, aboutName: gap.scope === 'person' ? to.name : gap.aboutName, drive };
}

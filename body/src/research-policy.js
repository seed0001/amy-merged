import { anchorText } from './goals.js';

export const questionText = (q) => typeof q === 'string' ? q : String(q?.text ?? '');
export const researchKey = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function localResearchTopic(text, botName = '') {
  const s = String(text ?? '');
  const own = /\b(your|my|her|our|you|yourself)\b/i.test(s) || (botName && new RegExp(`\\b${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s));
  return Boolean(own && /\b(provider|hosting|hosted|settings?|config(?:uration)?|persona|source code|cron|consent|check.ins?|profile card|voice id|memory|pipeline|dream cycle)\b/i.test(s));
}

export function selectResearch({ questions = [], names = [], threads = [], goals = [], interests = [], knownNames = [], attempts = [], answered = {}, now = Date.now(), botName = '', questionHours = 6, threadHours = 24, nameMinutes = 30, repeatHours = 72 } = {}) {
  const candidates = [
    ...goals.filter((g) => g.kind === 'goal' && !g.done && !g.dropped && (!g.activity || g.activity === 'research') && g.research?.enabled !== false).map((g) => ({
      kind: 'goal', goalId: g.id, text: `${g.text}${g.research?.next_question ? ` Next question: ${g.research.next_question}` : ''}`,
      // What the goal is for: every pass is held to it (goals.js anchorText), not just to the last thing it found.
      purpose: anchorText(g),
      at: g.at, conversation: '', lastWorked: g.research?.last_at ?? 0, goalScore: g.selectionScore ?? 0,
    })),
    ...questions.map((q) => ({ kind: 'question', text: questionText(q), at: q?.at ?? 0, conversation: q?.conversation ?? '', speaker: q?.speaker ?? null })),
    ...names.map((n) => ({ kind: 'name-question', text: n.snippet, at: n.at, conversation: n.conversation, name: n.name })),
    ...threads.map((t) => ({ kind: 'thread', text: `${t.label}: ${t.state}`, at: t.last_touched, conversation: '', threadId: t.id })),
    // Her own standing interests: always fresh, last in line, and the repeat cooldown keeps her from
    // looking up the same one over and over.
    ...interests.map((text) => ({ kind: 'interest', text, at: now, conversation: '' })),
  ];
  const known = new Set(knownNames.filter(Boolean).map((n) => n.toLowerCase()));
  const rank = { goal: 0, question: 1, 'name-question': 2, thread: 3, interest: 4 };
  for (const c of candidates) {
    c.key = researchKey(c.text);
    const ttl = c.kind === 'goal' ? Infinity : (c.kind === 'question' ? questionHours * 60 : c.kind === 'thread' ? threadHours * 60 : c.kind === 'interest' ? 1 : nameMinutes) * 60000;
    c.rejected = !Number.isFinite(c.at) || !c.at || c.at > now || now - c.at > ttl ? 'stale or missing source timestamp'
      : !c.text || c.text.trim().length < 15 ? 'too little context'
      : localResearchTopic(c.text, botName) ? 'about local/private runtime state; use settings or source instead of the web'
      : c.kind === 'name-question' && (known.has(String(c.name).toLowerCase()) || !/\?|^\s*(who|what|which|where|why|how)\b/i.test(c.text)) ? 'contact name or passing mention, not a public research question'
      : c.kind !== 'goal' && answered?.[c.key] ? 'already researched and written up'
      : attempts.some((a) => a.key === c.key && now - a.at < repeatHours * 3600000) ? 'already considered within the repeat cooldown'
      : null;
  }
  const eligible = candidates.filter((c) => !c.rejected).sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === 'goal' ? b.goalScore - a.goalScore || a.lastWorked - b.lastWorked : b.at - a.at));
  return { selected: eligible[0] ?? null, selectionRule: 'Prefer active research goals, then timestamped open questions, then recent name-questions, then recent active threads, then her own standing interests; newest first within each kind. A relevance check must still approve the selected candidate before searching.', candidates };
}

// Validate the planner's concise decision, never a private chain of thought.
export function validateResearchPlan(plan, candidate, recentQueries = []) {
  if (plan?.search !== true) return { search: false, reason: typeof plan?.reason === 'string' ? plan.reason.slice(0, 500) : 'No clear unanswered public question' };
  if (typeof plan.query !== 'string' || plan.query.trim().length < 12 || plan.query.length > 200 || typeof plan.reason !== 'string' || !plan.reason.trim()) return { search: false, reason: 'Planner did not provide a specific query and reason' };
  if (localResearchTopic(plan.query)) return { search: false, reason: 'Proposed query asks the public web about local/private state' };
  if (/\b(the context|the data|provided|mentioned|this conversation|the conversation|the transcript|the source|above)\b/i.test(plan.query)) return { search: false, retry: true, reason: 'The query refers to the chat ("the context", "the data") instead of standing alone. Write the full name of the subject and the question, with nothing about the chat.' };
  const grounds = Array.isArray(candidate.grounds) && candidate.grounds.length ? candidate.grounds : [candidate.text];
  const quote = typeof plan.evidence === 'string' ? plan.evidence.trim().toLowerCase() : '';
  if (quote.length < 8 || !grounds.some((g) => String(g ?? '').toLowerCase().includes(quote))) return { search: false, retry: true, reason: 'Planner did not ground the query in the source text' };
  if (typeof plan.confidence !== 'number' || plan.confidence < 0.8) return { search: false, reason: 'Topic or public relevance is uncertain' };
  if (recentQueries.some((q) => researchKey(q) === researchKey(plan.query))) return { search: false, reason: 'This query was already researched recently' };
  return { search: true, query: plan.query.trim(), reason: plan.reason.trim().slice(0, 500), evidence: plan.evidence.trim(), confidence: plan.confidence };
}

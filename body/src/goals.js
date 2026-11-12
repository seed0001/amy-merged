// Goal content is chosen at runtime. These are execution routes, never preset ambitions.
export const ACTIVITIES = ['research', 'writing', 'project'];
export const OPEN = (goal) => goal.kind === 'goal' && !goal.done && !goal.dropped;
const bounded = (value, min, max, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const words = (text) => new Set(String(text).toLowerCase().match(/[a-z]{4,}/g) || []);

export function goalOptions(options = {}) {
  const activity = options.activity ?? 'research';
  if (!ACTIVITIES.includes(activity)) throw new Error('Goal activity must be research, writing or project.');
  const bucket = options.bucket ?? ({ research: 'curiosity', writing: 'restlessness', project: 'usefulness' })[activity];
  if (!['boredom', 'curiosity', 'restlessness', 'usefulness', 'unease'].includes(bucket)) throw new Error('Unknown goal pressure bucket.');
  return { activity, bucket, criteria: String(options.criteria ?? '').trim().slice(0, 2000),
    reason: String(options.reason ?? '').trim().slice(0, 1000), fit: bounded(options.fit, 0, 1, 0.5),
    memoryIds: [...new Set((options.memoryIds ?? []).filter(Number.isSafeInteger))],
    ...(anchorOf(options) && { anchor: anchorOf(options) }) };
}

// What a goal is for, kept with it so every pass of work can be held to it (owner, 2026-11-11: "how do we make sure
// that he's on the right path and he's staying connected and not just pulling up random stuff?"). His grant goal had
// lost what it was for (AI/LLM experiments); its first search found athletic-training grants (NATA) and four more
// passes dug into NATA, each graded a success. purpose: what it's for, in the asker's words. fits / not: what counts
// and what doesn't. from: who asked (tagged). offTrack: passes that turned out not to serve it, and why (the lesson).
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/\n|;/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 12).map((s) => s.slice(0, 300));
export function anchorOf(options = {}) {
  const purpose = String(options.purpose ?? '').trim().slice(0, 1000);
  const fits = list(options.fits);
  const not = list(options.not ?? options.not_this);
  if (!purpose && !fits.length && !not.length) return null;
  return { purpose, fits, not, ...(options.from && { from: String(options.from).slice(0, 120) }), ...(options.quote && { quote: String(options.quote).slice(0, 600) }) };
}

// The anchor as the research and work prompts read it.
export function anchorText(goal) {
  const a = goal?.anchor;
  if (!a) return '';
  return [
    a.purpose && `What it's for${a.from ? ` (${a.from})` : ''}: ${a.purpose}`,
    a.quote && `In their words: "${a.quote}"`,
    a.fits?.length && `Counts: ${a.fits.join('; ')}`,
    a.not?.length && `Doesn't count: ${a.not.join('; ')}`,
    a.offTrack?.length && `Already found off track (don't go back there): ${a.offTrack.slice(-6).map((o) => `"${o.query}" (${o.why})`).join('; ')}`,
  ].filter(Boolean).join('\n');
}

export function learnedPreference(goal, experiences = []) {
  const relevant = experiences.filter((e) => Number.isFinite(e.satisfaction) && e.reviewed && e.activity === (goal.activity ?? 'research'));
  if (!relevant.length) return 0;
  const subject = words(goal.text);
  let total = 0, weight = 0;
  for (const experience of relevant) {
    const overlap = [...words(experience.goalText)].filter((word) => subject.has(word)).length;
    const w = 1 + overlap;
    total += experience.satisfaction * w; weight += w;
  }
  return total / weight;
}

export function selectGoal(items, experiences, { buckets = {}, now = Date.now(), gapMs = 45 * 60000 } = {}) {
  return items.filter((g) => OPEN(g) && g.research?.enabled !== false && !g.work?.running &&
    now - Math.max(g.work?.last_at ?? 0, g.research?.last_at ?? 0) >= gapMs)
    .map((goal) => ({ goal, preference: learnedPreference(goal, experiences),
      score: bounded(buckets[goal.bucket ?? 'curiosity'], 0, 1) + bounded(goal.fit, 0, 1, 0.5) + learnedPreference(goal, experiences) }))
    .sort((a, b) => b.score - a.score || (a.goal.work?.last_at ?? a.goal.research?.last_at ?? 0) - (b.goal.work?.last_at ?? b.goal.research?.last_at ?? 0) || a.goal.id - b.goal.id)[0] ?? null;
}

export const GOAL_DECISION_GUIDANCE = 'You may optionally make one goal_decision grounded in the supplied memory and experience context. Actions: none, adopt, pivot, pause, resume, drop, done, review. For adopt/pivot provide text, activity (research/writing/project), criteria, bucket, reason and an exact evidence excerpt from the context. Existing goals use their id and a reason; review uses experienceId, satisfaction (-1 to 1) and reason. Reconsider goals that no longer fit your interests, owner rules or available setup. Mark done only when saved work satisfies its completion criteria. Writing stays private; project goals never authorize a build, publication or contacting people. Existing project confirmation and permissions remain in force. Keep action none unless a concrete change is justified.';

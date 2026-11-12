import { goalOptions, OPEN, selectGoal, learnedPreference, anchorOf, anchorText } from './goals.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// What she has decided about herself and wants to do (the reflect tool), usually coming out of a
// session with Nova: insights ("I like making people laugh more than winning arguments") and goals
// ("learn to make better music"). Kept in data/reflections.json and shown in her prompt every turn,
// so they shape her from then on. She adds, finishes and drops them herself.

const FILE = path.join(DATA_DIR, 'reflections.json');
export const KINDS = ['insight', 'goal'];

// When she lets a goal go (drop or pivot), whoever listens hears what that goal was about, so things grown out of it
// (her interests) can let go too. Listeners get { goal, about: [texts it was about], held: [texts of goals still open] }.
const leftListeners = new Set();
export const onGoalLeft = (fn) => { leftListeners.add(fn); return () => leftListeners.delete(fn); };
const goalAbout = (state, goal) => [goal.text, ...(state.experiences ?? []).filter((e) => e.goalId === goal.id).map((e) => e.evidence?.query),
  ...(goal.progress ?? []).map((p) => p.query)].map((t) => String(t ?? '').trim()).filter(Boolean);
const leftNote = (state, goal) => ({ goal, about: [...new Set(goalAbout(state, goal))],
  held: [...new Set(state.items.filter((i) => OPEN(i)).flatMap((i) => goalAbout(state, i)))] });
const tellLeft = (state, goal) => { for (const fn of leftListeners) { try { fn(leftNote(state, goal)); } catch {} } };

// The experiences that belong to goals still open (what's shown to her each turn).
export const currentExperiences = (state) => {
  const open = new Set((state.items ?? []).filter((i) => OPEN(i)).map((i) => i.id));
  return (state.experiences ?? []).filter((e) => open.has(e.goalId));
};

export function createReflections(file = FILE, now = Date.now) {
  const load = () => {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { next: 1, items: [] }; } catch { return { next: 1, items: [] }; }
  };
  const save = (state) => { writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${file}.tmp`, file); };

  return {
    add(kind, text, options = {}) {
      if (!KINDS.includes(kind)) throw new Error(`kind must be ${KINDS.join(' or ')}`);
      const clean = String(text ?? '').trim();
      if (!clean) throw new Error('give the text to keep');
      const state = load();
      const item = { id: state.next++, kind, text: clean, at: now(), ...(kind === 'goal' ? goalOptions(options) : {}) };
      state.items.push(item);
      save(state);
      return item;
    },
    // Goals retain their outcomes and drop reasons as experience; insights can still be removed.
    finish(id) {
      const state = load();
      const item = state.items.find((i) => i.id === Number(id) && OPEN(i));
      if (!item) return null;
      // Choosing to call a goal done isn't work. Reward only an actual saved result.
      const evidence = [...(item.progress ?? [])].reverse().find((p) => p.experienceId && ['researched','written','done'].includes(p.status));
      if (!evidence) throw new Error('A goal needs a recorded successful result before completion. Drop it instead if it no longer fits.');
      item.done = now();
      if (evidence) {
        const experience = { id: randomUUID(), goalId: item.id, goalText: item.text, activity: item.activity ?? 'research',
          bucket: item.bucket ?? 'curiosity', outcome: 'completed', at: now(), evidence: evidence.experienceId,
          memoryIds: item.memoryIds ?? [], reward: 0.15, reason: item.criteria || item.text };
        (state.experiences ??= []).push(experience);
        item.completionExperience = experience;
      }
      save(state);
      return item;
    },
    drop(id, reason = '') {
      const state = load();
      const item = state.items.find((i) => i.id === Number(id));
      if (!item || item.dropped) return null;
      if (item.kind === 'goal') { item.dropped = now(); item.dropReason = String(reason || 'No longer chosen'); }
      else state.items = state.items.filter((i) => i !== item);
      save(state);
      if (item.kind === 'goal') tellLeft(state, item);
      return item;
    },
    // Goals let go before anything was listening (or while the bot was down): their notes, once each.
    leftUnheard() {
      const state = load();
      return state.items.filter((i) => i.kind === 'goal' && i.dropped && !i.leftHeard).map((g) => leftNote(state, g));
    },
    markLeftHeard(id) {
      const state = load();
      const item = state.items.find((i) => i.id === Number(id));
      if (!item) return;
      item.leftHeard = now();
      save(state);
    },
    configureGoal(id, enabled) {
      const state = load();
      const item = state.items.find((i) => i.id === Number(id) && OPEN(i));
      if (!item) throw new Error('No open goal with that ID');
      item.research = { ...item.research, enabled: Boolean(enabled) };
      save(state); return item;
    },
    // What the goal is for, set or corrected (goals tool steer): usually the owner saying what he meant. Answering a
    // check-in (the first lead, shown to the person who asked) is done here too.
    steer(id, options = {}) {
      const state = load();
      const item = state.items.find((i) => i.id === Number(id) && OPEN(i));
      if (!item) throw new Error('No open goal with that ID');
      const next = anchorOf(options);
      if (!next && options.answer == null) throw new Error('Say what the goal is for (purpose), what counts (fits) or what doesn\'t (not_this), or answer its check-in (answer).');
      const old = item.anchor ?? { purpose: '', fits: [], not: [] };
      item.anchor = { ...old, ...(next?.purpose && { purpose: next.purpose }), ...(next?.from && { from: next.from }), ...(next?.quote && { quote: next.quote }),
        fits: [...new Set([...(old.fits ?? []), ...(next?.fits ?? [])])].slice(-12), not: [...new Set([...(old.not ?? []), ...(next?.not ?? [])])].slice(-12) };
      if (options.answer != null && item.checkIn) item.checkIn = { ...item.checkIn, answered: now(), answer: String(options.answer).slice(0, 600) };
      // A new purpose means the old trail of next questions may be off: the next pass starts from the purpose.
      if (next?.purpose && next.purpose !== old.purpose && item.research) item.research = { ...item.research, next_question: '' };
      save(state); return item;
    },
    // A pass that turned out not to serve the goal: kept as the lesson, so the next pass doesn't go back there.
    noteOffTrack(id, { query, why }) {
      const state = load();
      const item = state.items.find((i) => i.id === Number(id) && OPEN(i));
      if (!item) return null;
      item.anchor ??= { purpose: '', fits: [], not: [] };
      item.anchor.offTrack = [...(item.anchor.offTrack ?? []), { query: String(query).slice(0, 200), why: String(why).slice(0, 300), at: now() }].slice(-10);
      if (item.research) item.research = { ...item.research, next_question: '' };
      save(state); return item;
    },
    // The first real lead on a goal someone gave him goes back to them ("is this what you meant?").
    leadForCheckIn(id, lead) {
      const state = load();
      const item = state.items.find((i) => i.id === Number(id) && OPEN(i));
      if (!item || item.checkIn || !item.anchor?.from) return null;
      item.checkIn = { lead: String(lead).slice(0, 400), at: now(), asked: false };
      save(state); return item;
    },
    recordResearch(id, progress) {
      const state = load();
      const item = state.items.find((i) => i.id === Number(id) && OPEN(i));
      if (!item || item.research?.enabled === false) return null;
      item.research = { ...item.research, last_at: now(),
        next_question: typeof progress.next_question === 'string' ? progress.next_question.slice(0, 600) : '' };
      const experienceId = progress.eventId || randomUUID();
      if ((state.experiences ?? []).some((e) => e.id === experienceId)) return item;
      (item.progress ??= []).push({ ...progress, at: now(), experienceId });
      (state.experiences ??= []).push({ id: experienceId, goalId: item.id, goalText: item.text,
        activity: 'research', bucket: item.bucket ?? 'curiosity', at: now(), outcome: progress.status,
        evidence: { file: progress.file, sources: progress.sources ?? [], query: progress.query },
        memoryIds: item.memoryIds ?? [], summary: progress.summary, reward: 0 });
      save(state); return item;
    },
    select(context) { const state = load(); return selectGoal(state.items, state.experiences ?? [], { ...context, now: context?.now ?? now() }); },
    experiences() { return load().experiences ?? []; },
    recordWork(id, result) {
      const state = load();
      const item = state.items.find((g) => g.id === Number(id) && OPEN(g));
      if (!item) return null;
      if (!result?.eventId || !result.evidence || !['written','done','failed','inconclusive','planned'].includes(result.status)) throw new Error('Work needs a unique event, evidence and outcome.');
      if ((state.experiences ?? []).some((e) => e.id === result.eventId)) return null;
      const experience = { id: result.eventId, goalId: item.id, goalText: item.text,
        activity: item.activity ?? 'research', bucket: item.bucket ?? 'curiosity', at: now(), outcome: result.status,
        evidence: result.evidence, summary: String(result.summary ?? '').slice(0,4000), memoryIds: [...new Set([...(item.memoryIds ?? []), ...(result.evidence.memoryIds ?? [])])], reward: 0 };
      (state.experiences ??= []).push(experience);
      (item.progress ??= []).push({ ...result, at: now(), experienceId: experience.id });
      item.work = { ...item.work, last_at: now(), running: false };
      save(state); return experience;
    },
    review(experienceId, satisfaction, reason) {
      if (!Number.isFinite(satisfaction) || satisfaction < -1 || satisfaction > 1 || !String(reason ?? '').trim()) throw new Error('Review needs satisfaction from -1 to 1 and a reason.');
      const state = load();
      const experience = state.experiences?.find((e) => e.id === experienceId);
      if (!experience) throw new Error('Review must refer to a recorded experience.');
      Object.assign(experience, { satisfaction, reviewReason: String(reason).slice(0,1000), reviewed: now() });
      save(state); return experience;
    },
    pivot(id, text, options = {}) {
      const clean = String(text ?? '').trim(); const settings = goalOptions(options);
      if (!clean || !settings.reason) throw new Error('Pivot needs a replacement goal and a reason.');
      const state = load(); const old = state.items.find((g) => g.id === Number(id) && OPEN(g));
      if (!old) throw new Error('No open goal to pivot from.');
      old.dropped = now(); old.dropReason = settings.reason;
      const replacement = { id: state.next++, kind: 'goal', text: clean, at: now(), ...settings, previousGoal: old.id, ...(!settings.anchor && old.anchor && { anchor: old.anchor }) };
      old.replacementGoal = replacement.id; state.items.push(replacement); save(state); tellLeft(state, old); return replacement;
    },
    decide(decision, { thoughtId, context } = {}) {
      if (!decision || decision.action === 'none') return null;
      if (!Number.isSafeInteger(thoughtId) || !decision.reason?.trim()) throw new Error('A self-directed choice needs its saved thought and reason.');
      if (['adopt','pivot'].includes(decision.action)) {
        if (typeof decision.evidence !== 'string' || decision.evidence.trim().length < 8 || !String(context).includes(decision.evidence.trim())) throw new Error('A new goal must be grounded in the supplied memory or experience context.');
      }
      const options = { ...decision, reason: decision.reason + ` (thought #${thoughtId})` };
      if (decision.action === 'adopt') return this.add('goal', decision.text, options);
      if (decision.action === 'pivot') return this.pivot(decision.id, decision.text, options);
      if (decision.action === 'drop') return this.drop(decision.id, options.reason);
      if (decision.action === 'pause' || decision.action === 'resume') return this.configureGoal(decision.id, decision.action === 'resume');
      if (decision.action === 'review') return this.review(decision.experienceId, decision.satisfaction, options.reason);
      if (decision.action === 'done') return this.finish(decision.id);
      throw new Error('Unknown self-directed goal decision.');
    },
    list() {
      return load().items;
    },
    promptBlock() {
      const state = load();
      const items = state.items;
      const insights = items.filter((i) => i.kind === 'insight');
      const goals = items.filter((i) => OPEN(i));
      if (!items.length) return '';
      return [
        insights.length && `What you've decided about yourself:\n${insights.map((i) => `- ${i.text}`).join('\n')}`,
        goals.length && `Your goals (you chose these; work toward them when it fits):\n${goals.map((i) => `- #${i.id} [${i.activity ?? 'research'}; pressure ${i.bucket ?? 'curiosity'}; learned preference ${learnedPreference(i,state.experiences ?? []).toFixed(2)}]: ${i.text}${i.criteria ? `; done means: ${i.criteria}` : ''}${i.research?.enabled === false ? ' (autonomous research paused)' : ''}${anchorText(i) ? `\n  ${anchorText(i).replace(/\n/g, '\n  ')}` : '\n  (No purpose saved for this goal: if you don\'t know exactly what it\'s for, ask whoever gave it to you and save it with goals steer.)'}${i.checkIn && !i.checkIn.answered ? `\n  First lead, not yet checked with ${i.anchor?.from ?? 'whoever asked'}: ${i.checkIn.lead}. Ask them whether this is the kind of thing they meant, and save their answer with goals steer (answer, and fits or not_this).` : ''}${i.progress?.length ? `\n  Latest work: ${i.progress.at(-1).summary}; next: ${i.research?.next_question || 'review what remains'}` : ''}`).join('\n')}`,
        // Only work on goals still held. Experiences from dropped goals stayed here every turn (2026-11-11: the NATA
        // athletic-trainer grants Owner told James to let go of filled 6 of the 8 lines), so he kept living in them.
        // They're still kept on file for learned preference and review; they just stop being shown.
        currentExperiences(state).length && `Recent goal experiences (persisted memories; reviews are subjective, not verified external facts):\n${currentExperiences(state).slice(-8).map((e) => `- ${e.id}: goal #${e.goalId}, ${e.outcome}: ${e.summary || e.reason || ''}${e.evidence?.sources?.length ? `; ${e.evidence.sources.length} source${e.evidence.sources.length === 1 ? '' : 's'}${e.evidence.file ? ` (in ${path.basename(e.evidence.file)})` : ''}` : ''}${e.reviewed ? `; satisfaction ${e.satisfaction}: ${e.reviewReason}` : '; not yet reviewed'}`).join('\n')}`,
        items.some((i) => i.dropped) && `Goals you left behind: ${items.filter((i) => i.dropped).slice(-4).map((i) => `#${i.id}: ${i.text} (${i.dropReason})`).join('; ')}`,
      ].filter(Boolean).join('\n');
    },
  };
}

let shared;
export const reflections = () => (shared ??= createReflections());

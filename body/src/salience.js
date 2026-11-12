import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { bus, activity } from './events.js';

// What weighs on her. Every thing she carries (a question she asked or was asked, a promise on her
// pad, something someone said to her, a memory, a want for her home, a person she misses, a thing she
// just discovered) gets a weight: how charged it is, whether it is unresolved, whether it is about
// her owner, how fresh it is, and how often it has come back. Coming back is the subconscious part:
// a weight accumulates each time the thing surfaces and holds (capped) without a clock, so what keeps
// returning weighs more whether or not she chooses it. The heaviest things colour her prompt, lean on
// her unease and reflection (pressure.js flow), and are what her dreams are made of (dreams.js).
//
// Owner, 2026-11-09: "your memory, your wants, your desires, all of the data points need to have
// different weights... the ones that weigh the most influence your dreams... conscious and subconscious."

const FILE = path.join(DATA_DIR, 'salience.json');
export const W = {
  charge: 0.35, unresolved: 0.25, owner: 0.15, recency: 0.25, // parts of a fresh weight
  accumulate: 0.06, accumulate_cap: 0.8, // the subconscious load: per surfacing, capped; it does not fade on a clock
  surfacings_per_hour: 6, // a thing in her prompt counts as surfaced at most this often
};
const key = (kind, text) => `${kind}:${String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`;

export function createSalience({ file = FILE, now = Date.now, collect = defaultCollect } = {}) {
  let state = (() => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } })() ?? { load: {} };
  const save = () => { try { writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1)); renameSync(`${file}.tmp`, file); } catch (err) { activity('error', { where: 'salience', message: `Couldn't save ${file}: ${err.message}. What has been weighing on her is lost on restart.` }); } };
  const decayed = (entry) => entry?.acc ?? 0;

  // The subconscious part: something came back (she asked it again, it was mentioned, it was in her prompt).
  function touch(kind, text, amount = W.accumulate, t = now()) {
    const k = key(kind, text);
    const e = state.load[k] ?? { acc: 0, at: t, n: 0, text: String(text).slice(0, 160), kind };
    e.acc = Math.min(W.accumulate_cap, decayed(e, t) + amount);
    e.at = t; e.n = (e.n ?? 0) + 1;
    state.load[k] = e;
    // keep the file bounded: the lightest, oldest go
    const keys = Object.keys(state.load);
    if (keys.length > 400) for (const k2 of keys.sort((a, b) => decayed(state.load[a], t) - decayed(state.load[b], t)).slice(0, keys.length - 400)) delete state.load[k2];
    save();
    return e;
  }

  // Every item, weighed, heaviest first. items: { kind, text, who, at, charge 0..1, owner, unresolved, why }.
  async function rank(t = now()) {
    const items = await collect(t).catch((err) => { activity('error', { where: 'salience', message: `Couldn't gather what weighs on her: ${err.message}` }); return []; });
    const out = [];
    const seen = new Set();
    for (const it of items) {
      const k = key(it.kind, it.text);
      if (seen.has(k)) continue; seen.add(k);
      // Everything collected here is on her mind now, so it counts as fresh; age alone doesn't lighten it.
      const fresh = 1;
      const acc = decayed(state.load[k]);
      const weight = Math.min(1, (it.charge ?? 0.3) * W.charge + (it.unresolved ? W.unresolved : 0) + (it.owner ? W.owner : 0) + fresh * W.recency + acc);
      out.push({ ...it, key: k, weight: +weight.toFixed(3), returned: state.load[k]?.n ?? 0, subconscious: acc >= 0.25 });
    }
    // things only in the load (not collected any more) still weigh while their accumulation lasts
    for (const [k, e] of Object.entries(state.load)) {
      if (seen.has(k)) continue;
      const acc = decayed(e, t);
      if (acc < 0.12) continue;
      out.push({ kind: e.kind, text: e.text, at: e.at, charge: 0, owner: false, unresolved: false, key: k, weight: +Math.min(1, acc).toFixed(3), returned: e.n, subconscious: true, why: 'it keeps coming back' });
    }
    return out.sort((a, b) => b.weight - a.weight);
  }

  let lastSurface = 0;
  return {
    touch, rank,
    // For her prompt: the heaviest few, conscious and not. Being in her prompt is a surfacing (rate-limited).
    async promptSection(t = now()) {
      const top = (await rank(t)).slice(0, 5);
      if (!top.length) return '';
      if (t - lastSurface > 3600_000 / W.surfacings_per_hour) { lastSurface = t; for (const it of top) touch(it.kind, it.text, W.accumulate * 0.5, t); }
      return `What's weighing on you right now, heaviest first (these colour your mood and come up on their own; the ones marked subconscious you haven't chosen to carry, they just keep returning):\n${top.map((it) => `- (${it.weight.toFixed(2)}${it.subconscious ? ', subconscious' : ''}) ${it.kind}: ${it.text}${it.why ? ` (${it.why})` : ''}`).join('\n')}`;
    },
    // For her dreams: what the night is made of, heaviest first.
    async dreamSeeds(n = 8, t = now()) { return (await rank(t)).slice(0, n).map((it) => ({ weight: it.weight, kind: it.kind, text: it.text, subconscious: it.subconscious })); },
    // For pressure: how loaded she is, 0..1 (what she carries leans on her unease and reflection).
    async load(t = now()) { const r = await rank(t); return Math.min(1, r.slice(0, 6).reduce((s, it) => s + it.weight, 0) / 4); },
    stats: () => ({ carried: Object.keys(state.load).length }),
  };
}

// Everything she carries, gathered from the systems that hold it. Each module is imported lazily so
// salience can be used by any of them without a cycle.
async function defaultCollect(t) {
  const out = [];
  const ownerIds = new Set((config.ownerIds ?? []).map(String));
  const [cur, pressure, memory, home, disc, oq] = await Promise.all([
    import('./curiosity.js').then((m) => m.curiosity()).catch(() => null),
    import('./pressure.js').catch(() => null),
    import('./memory.js').catch(() => null),
    import('./home-taste.js').then((m) => m.homeTaste()).catch(() => null),
    import('./discoveries.js').then((m) => m.discoveries).catch(() => null),
    import('./open-question.js').catch(() => null),
  ]);
  if (cur) for (const q of cur.list()) {
    if (q.status === 'open' || q.status === 'asked') out.push({ kind: q.scope === 'self' ? 'a question about myself' : `a question I have for ${q.aboutName}`, text: q.text, at: q.askedAt ?? q.at, charge: 0.5 + Math.min(0.4, (q.tries ?? 0) * 0.2), unresolved: true, owner: q.scope === 'self' || ownerIds.has(String(q.aboutId)), why: q.tries ? `asked ${q.tries} time${q.tries === 1 ? '' : 's'}, no answer` : 'never asked yet' });
  }
  if (pressure) {
    const s = pressure.state ?? {};
    for (const q of (s.openQuestions ?? []).slice(-6)) out.push({ kind: 'something to look into', text: pressure.questionText ? pressure.questionText(q) : String(q.text ?? q), at: q.at, charge: 0.4, unresolved: true, owner: false });
    try { for (const it of pressure.staleItems()) out.push({ kind: 'a promise or thread I left open', text: it.text, at: it.at ?? t - 3 * 3600_000, charge: 0.6, unresolved: true, owner: true }); } catch {}
    if (s.boundary && t - s.boundary.at < 24 * 3600_000) out.push({ kind: 'how someone spoke to me', text: `${s.boundary.name ?? 'someone'}: ${s.boundary.kind}`, at: s.boundary.at, charge: 0.8, unresolved: false, owner: ownerIds.has(String(s.boundary.id)) });
    for (const [id, p] of Object.entries(s.loneliness ?? {})) if ((p.value ?? 0) >= 0.3) out.push({ kind: 'someone I miss', text: p.name ?? id, at: p.last_seen ?? t, charge: p.value, unresolved: true, owner: ownerIds.has(String(id)) });
    if (s.said_bored_at && t - s.said_bored_at < 2 * 3600_000) out.push({ kind: 'how I felt in the call', text: 'I said I was bored and nobody pulled me in', at: s.said_bored_at, charge: 0.6, unresolved: true, owner: true });
    const li = s.lastIntake; if (li && t - li.at < 6 * 3600_000) for (const [k, v] of Object.entries(li.signals ?? {})) if ((k === 'contempt' || k === 'praise' || k === 'yelling') && v >= 0.5) out.push({ kind: k === 'praise' ? 'something kind said to me' : 'something harsh said to me', text: `${li.speaker ?? 'someone'}, ${k} ${v}`, at: li.at, charge: v, unresolved: false, owner: true });
  }
  if (memory?.browseMemories) for (const m of memory.browseMemories({ limit: 20 })) out.push({ kind: 'something I remember', text: m.content, at: m.created_at, charge: 0.3, unresolved: false, owner: ownerIds.has(String(m.user_id)) || m.user_id === 'self' });
  if (home) { for (const w of home.wants()) out.push({ kind: 'something I want for my place', text: w, at: t - 3600_000, charge: 0.5, unresolved: true, owner: true }); const v = home.get().verdicts.at(-1); if (v) out.push({ kind: 'how I felt about what the architect built', text: `${v.verdict}: ${v.why}`, at: v.at, charge: v.verdict === 'dislike' ? 0.7 : 0.4, unresolved: v.verdict === 'dislike' || v.verdict === 'meh', owner: true }); }
  if (disc?.recent) for (const tool of disc.recent().slice(0, 3)) out.push({ kind: 'something I found out I can do', text: tool, at: t - 10 * 60_000, charge: 0.45, unresolved: false, owner: false });
  if (oq?.current) { /* per conversation; the voice call is where it matters */ }
  return out;
}

let shared;
export function salience() {
  if (shared) return shared;
  shared = createSalience();
  import('./pressure.js').then((p) => p.setSalience(() => shared.load())).catch(() => {});
  // Surfacings that aren't her prompt: asking a question again, a nudge, something she was told about herself.
  bus.on('activity', (e) => {
    try {
      if (e.type === 'curiosity' && (e.asked || e.wondering)) shared.touch('a question', e.asked ?? e.wondering);
      if (e.type === 'open-question' && e.nudged) shared.touch('a question I asked', e.nudged);
      if (e.type === 'pressure' && e.home) shared.touch('my place', `the architect's work: ${e.home}`, 0.1);
      if (e.type === 'intake' && ((e.contempt ?? 0) >= 0.5 || (e.yelling ?? 0) >= 0.5)) shared.touch('how someone spoke to me', `${e.speaker ?? 'someone'} was harsh`, 0.12);
      if (e.type === 'intake' && (e.praise ?? 0) >= 0.6) shared.touch('something kind said to me', `${e.speaker ?? 'someone'} was kind`, 0.08);
    } catch {}
  });
  return shared;
}

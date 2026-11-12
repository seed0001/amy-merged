import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';

// Her life, all in one read-only view for the "Her life" dashboard (dashboard/public/life.html; owner, 2026-11-10:
// "who she knows, what she knows about them, how they make her feel, all her different subjects and wants and her
// goals, everything"). It only reads what the owning modules already keep; nothing here changes her. Each part is
// read on its own, so one that can't be read shows why instead of taking the whole page down.
//
// Not her life file (life-file.js, data/life.json): that one is off limits and isn't read or touched here.

const readJson = (file, fallback) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; } };
const pct = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);

async function part(name, fn, problems) {
  try { return await fn(); }
  catch (err) { problems.push({ part: name, why: err.message }); return null; }
}

export async function lifeView() {
  const problems = [];
  const memory = await import('./memory.js');

  // Everyone she knows: contacts plus anyone she has memories, a relationship or an aim with.
  const people = await part('people', async () => {
    const { relationships } = await import('./relationship.js');
    const { direction } = await import('./direction.js');
    const { snapshot } = await import('./pressure.js');
    const rel = Object.fromEntries(relationships().list().map((r) => [String(r.id), r]));
    const aims = Object.fromEntries(direction().list().map((d) => [String(d.id), d]));
    // Live when her pressure is running; her saved pressure state otherwise.
    const bonds = { ...(readJson(path.join(DATA_DIR, 'pressure-state.json'), {}).loneliness ?? {}), ...(snapshot().loneliness ?? {}) };
    const contacts = memory.listContacts();
    const ids = new Set([...contacts.map((c) => String(c.user_id)), ...Object.keys(rel), ...Object.keys(aims)]);
    const out = [];
    for (const id of ids) {
      const c = contacts.find((x) => String(x.user_id) === id) ?? {};
      const r = rel[id] ?? null, a = aims[id] ?? null, b = bonds[id] ?? null;
      const memories = (() => { try { return memory.listMemories(id).map((m) => ({ id: m.id, text: m.content, at: m.created_at })); } catch { return []; } })();
      let profile = null; try { profile = memory.profiles.read(id); } catch {}
      out.push({
        id,
        name: c.name || r?.name || a?.name || b?.name || id,
        username: c.username ?? null,
        // Her owner is her owner whatever his access tier says ('stranger' is the default tier, the owner included).
        tier: config.ownerIds.includes(id) ? 'owner' : c.tier ?? b?.tier ?? 'stranger',
        owner: config.ownerIds.includes(id),
        first_seen: c.first_seen ?? null,
        last_seen: c.last_seen ?? r?.last_seen ?? null,
        relationship: r && {
          stage: r.stage,
          feelings: { closeness: pct(r.closeness), attraction: pct(r.attraction), spark: pct(r.spark), rush: pct(r.rush), trust: pct(r.trust), commitment: pct(r.commitment), hurt: pct(r.hurt), resentment: pct(r.resentment), jealousy: pct(r.jealousy) },
          milestones: (r.milestones ?? []).slice(-8).map((m) => ({ at: m.at, from: m.from, to: m.to, why: m.why })),
        },
        missing_them: pct(b?.value), bond: pct(b?.bond),
        aim: a?.aim ? { aim: a.aim, why: a.why, since: a.since, progress: pct(a.progress) } : null,
        frustration: profile?.frustration ?? null,
        memories,
      });
    }
    // Owner first, then by how close she is, then most recently seen.
    const rank = (p) => (p.owner ? 3 : 0) + (p.relationship ? p.relationship.feelings.closeness / 100 : 0);
    return out.sort((x, y) => rank(y) - rank(x) || String(y.last_seen ?? '').localeCompare(String(x.last_seen ?? '')));
  }, problems);

  // What she's into, and her taste.
  const subjects = await part('subjects', async () => {
    const { interests } = await import('./interests.js');
    return interests.top(40).map((t) => ({ name: t.name, interest: pct(t.interest), mentions: t.mentions ?? 0, last: t.last ?? null, sources: t.sources ?? {}, people: t.people ?? {} }));
  }, problems);
  const taste = await part('taste', async () => { const { taste } = await import('./taste.js'); return String(taste.promptSection() ?? ''); }, problems);

  // What she wants right now (her pressure) and how she feels.
  const wants = await part('wants', async () => {
    const p = await import('./pressure.js');
    const s = p.snapshot();
    const feelings = new Set(s.feelings ?? []);
    const layerOf = Object.fromEntries(Object.entries(p.LAYER).flatMap(([layer, chs]) => chs.map((c) => [c, layer])));
    // Live when her pressure has ticked in this process; her saved pressure state otherwise.
    const buckets = p.state?.last_tick ? s.buckets : readJson(path.join(DATA_DIR, 'pressure-state.json'), {}).buckets ?? s.buckets;
    const all = Object.entries(buckets ?? {}).map(([k, v]) => ({ key: k, label: p.LABEL[k] ?? k, level: pct(v), threshold: s.thresholds?.[k] != null ? pct(s.thresholds[k]) : null, layer: layerOf[k] ?? (feelings.has(k) ? 'feeling' : 'other'), want: typeof p.WANTS[k] === 'function' ? (() => { try { return p.WANTS[k](p.state); } catch { return ''; } })() : '' }));
    return {
      wants: all.filter((x) => !feelings.has(x.key) && x.key !== 'energy').sort((a, b) => b.level - a.level),
      feelings: all.filter((x) => feelings.has(x.key) || x.key === 'energy').sort((a, b) => b.level - a.level),
      last_action: s.last_action ?? null,
      last_thought: s.last_thought ?? null,
    };
  }, problems);

  // Her goals and what she's decided about herself.
  const goals = await part('goals', async () => {
    const { reflections } = await import('./reflections.js');
    const items = reflections().list();
    const shape = (i) => ({ id: i.id, kind: i.kind, text: i.text, at: i.at, activity: i.activity ?? null, criteria: i.criteria ?? '', reason: i.reason ?? '', done: i.done ?? null, dropped: i.dropped ?? null, dropReason: i.dropReason ?? '', progress: (i.progress ?? []).length,
      // What it's for, the first lead checked with whoever asked, and each pass on or off track (goals.js anchor).
      anchor: i.anchor ?? null, checkIn: i.checkIn ?? null, nextQuestion: i.research?.next_question ?? '',
      trail: (i.progress ?? []).slice(-8).map((p) => ({ at: p.at, query: p.query ?? p.summary?.slice(0, 80) ?? '', status: p.status, why: p.offGoalWhy ?? '' })) });
    return {
      open: items.filter((i) => i.kind === 'goal' && !i.done && !i.dropped).map(shape),
      finished: items.filter((i) => i.kind === 'goal' && (i.done || i.dropped)).slice(-10).map(shape),
      insights: items.filter((i) => i.kind === 'insight').map(shape),
    };
  }, problems);
  const directions = await part('direction', async () => {
    const { direction } = await import('./direction.js');
    return { overall: direction().overall(), history: direction().history(12) };
  }, problems);

  // Who she is, as she's worked it out.
  const self = await part('self', async () => {
    const s = readJson(path.join(DATA_DIR, 'self-work.json'), {});
    let questions = {};
    try { const { SELF } = await import('./curiosity.js'); questions = Object.fromEntries(SELF.map(([id, desc]) => [id, desc])); } catch {}
    return {
      believes: s.lastReflection?.statement ?? null,
      believed_at: s.lastReflection?.at ?? null,
      aspects: Object.entries(questions).map(([id, desc]) => ({ id, question: desc, answer: s.aspects?.[id]?.answer ?? null, at: s.aspects?.[id]?.at ?? null })),
    };
  }, problems);

  // What she's been doing lately: her journal and what she's made.
  const lately = await part('lately', async () => {
    const out = {};
    try { const j = await import('./journal.js'); if (typeof j.journalEntries === 'function') out.journal = j.journalEntries().slice(-6).reverse().map((e) => ({ title: e.title, body: String(e.body ?? '').slice(0, 400), at: e.at ?? e.date ?? null })); } catch {}
    try { const s = await import('./songbook.js'); if (typeof s.list === 'function') out.songs = s.list({ all: true }).slice(-6).reverse().map((x) => ({ title: x.title, at: x.at ?? x.created ?? null })); } catch {}
    return out;
  }, problems);

  return { name: config.botName, at: Date.now(), people, subjects, taste, wants, goals, direction: directions, self, lately, problems };
}

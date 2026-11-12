import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { embed } from './llm.js';
import { activity } from './events.js';

// What happened when she tried something (Owner, 2026-11-09: close the feedback loops). Every effortful
// attempt she makes (her own research, goal work, a song, a build, a requested tool that costs energy) is
// kept here once it's settled: what she was after (objective), how she went about it (method), the energy
// it took, what came of it as the harness measured it, and, when it failed, why. Kept in
// data/experiences.jsonl, one line each, with a meaning-vector of the objective so a later attempt at
// something similar finds it by meaning (embeddings), never by keywords.
//
// Failure doesn't lower the want that drove it: it changes how she tries. Before a similar attempt the
// failures are put in front of the decision (the research planner in journal.js, her mood line in her reply
// prompt): "last time you went at this that way and got nothing, because...".

export const EXPERIENCE_FILE = path.join(DATA_DIR, 'experiences.jsonl');
const KEEP = 1500; // the file is trimmed to the newest this many when it grows past half again as many
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };
const round = (v) => v.map((n) => Math.round(n * 1e4) / 1e4);

export function createExperiences({ file = EXPERIENCE_FILE, embedder = embed, now = Date.now, log = activity } = {}) {
  let cache = null;
  const all = () => {
    if (cache) return cache;
    cache = [];
    try {
      if (existsSync(file)) cache = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    } catch {}
    return cache;
  };
  // The meaning of an objective, or null when her embedding model can't be reached (then nothing is
  // compared by meaning: an attempt is still recorded, it just can't be recalled as "similar").
  async function vectorOf(text) {
    const clean = String(text ?? '').trim();
    if (!clean) return null;
    try { const [v] = await embedder([clean.slice(0, 1000)]); return Array.isArray(v) && v.length ? round(v) : null; } catch { return null; }
  }

  // Settle one attempt: { act, objective, method, spent, result: 'ok'|'failed'|'inconclusive', why, person,
  // bucket, expected, outcome, satisfaction, reward, nodes }. Returns the stored record (without its vector).
  async function add(entry) {
    const vec = entry.vec !== undefined ? entry.vec : await vectorOf(entry.objective);
    const record = { id: randomUUID(), at: now(), ...entry, objective: String(entry.objective ?? '').slice(0, 600), method: String(entry.method ?? '').slice(0, 600), why: String(entry.why ?? '').slice(0, 600), vec };
    const list = all();
    list.push(record);
    try {
      appendFileSync(file, JSON.stringify(record) + '\n');
      if (list.length > KEEP * 1.5) {
        cache = list.slice(-KEEP);
        writeFileSync(`${file}.tmp`, cache.map((r) => JSON.stringify(r)).join('\n') + '\n');
        renameSync(`${file}.tmp`, file);
      }
    } catch (err) { log('error', { where: 'experiences', message: `Couldn't save an experience to ${file}: ${err.message}. It counts for now but won't survive a restart; check the data folder is writable.` }); }
    const { vec: _, ...out } = record;
    if (record.result !== 'ok') {
      log('experience', { id: record.id, act: record.act, objective: record.objective, method: record.method, spent: record.spent ?? 0, result: record.result, why: record.why, person: record.person ?? null,
        nodes: [`experience:${record.id}`, `act:${record.act}`, ...(record.bucket ? [`bucket:${record.bucket}`] : []), ...(record.person ? [`person:${record.person}`] : [])] });
    }
    return out;
  }

  // Past attempts like this objective, closest first: [{ ...record, similarity }]. act limits it to one kind of
  // act; failures: true keeps only the ones that didn't work. Without a vector for the objective (her
  // embedding model is down), nothing can be judged similar and the list is empty.
  async function similar(objective, { act = null, limit = 5, min = 0.6, failures = false } = {}) {
    const v = await vectorOf(objective);
    if (!v) return [];
    return all().filter((e) => e.vec && (!act || e.act === act) && (!failures || e.result !== 'ok'))
      .map((e) => ({ e, similarity: cosine(v, e.vec) })).filter((x) => x.similarity >= min)
      .sort((a, b) => b.similarity - a.similarity || b.e.at - a.e.at).slice(0, limit)
      .map(({ e, similarity }) => { const { vec: _, ...rest } = e; return { ...rest, similarity: +similarity.toFixed(3) }; });
  }

  // Everything settled with one person involved (their request, their question): for anticipation.
  const withPerson = (id) => all().filter((e) => id && e.person === id).map(({ vec: _, ...rest }) => rest);
  // The same kind of act, newest last: her track record at it.
  const ofAct = (act) => all().filter((e) => e.act === act).map(({ vec: _, ...rest }) => rest);
  // Failures not yet followed by a success at the same kind of act: what's still unresolved, newest first.
  function unresolvedFailures(limit = 2) {
    const list = all();
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
      const e = list[i];
      if (e.result === 'ok') continue;
      if (list.slice(i + 1).some((later) => later.act === e.act && later.result === 'ok')) continue;
      if (out.some((o) => o.act === e.act && o.objective === e.objective)) continue;
      const { vec: _, ...rest } = e;
      out.push(rest);
    }
    return out;
  }
  return { add, similar, withPerson, ofAct, unresolvedFailures, all: () => all().map(({ vec: _, ...rest }) => rest), reset: () => { cache = null; } };
}

// One line per past attempt, for a planner or prompt: what she tried, how, and what came of it.
export function attemptLines(list = []) {
  return list.map((e) => `- ${new Date(e.at).toISOString().slice(0, 10)}: you tried "${e.objective}"${e.method ? ` by ${e.method}` : ''}${e.spent ? ` (spent ${Number(e.spent).toFixed(2)} energy)` : ''}: ${e.result === 'ok' ? 'it worked' : `it ${e.result === 'inconclusive' ? 'came up inconclusive' : e.result === 'skipped' ? 'was dropped before anything ran' : 'failed'}${e.why ? ` because ${e.why}` : ''}`}.`);
}

export const experiences = createExperiences();

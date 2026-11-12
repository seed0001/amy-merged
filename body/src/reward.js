import { randomUUID } from 'node:crypto';
import { activity } from './events.js';
import { experiences } from './experience.js';
import * as pressure from './pressure.js';

// Expectation against outcome (Owner, 2026-11-09: close the feedback loops). Before she acts on a want of
// her own or a requested effortful act, the harness records what she's after and how well she expects it
// to go. Nobody asks her model to grade itself: the expectation comes from her own state (how strongly the
// driving channel is pushing) and her track record (how attempts at this kind of act, and at objectives like
// this one by meaning, actually turned out). After the act the outcome is measured from what the harness
// can verify (a journal entry written, a tool result that isn't an error, a goal step saved, new concepts
// actually stored), never from her saying it went well, so she can't farm reward by congratulating herself.
//
//   satisfaction  did she accomplish what she set out to (0..1), measured
//   reward        outcome minus expectation (prediction error, -1..1)
//
// Both feed the pressure system as transfers (pressure.onOutcome): satisfaction relieves the channel that
// drove the act, a positive surprise moves energy into thrill and joy (and raises her expectation of that
// kind of act next time, through the track record), a disappointment moves energy into restlessness and
// irritation, never out of the want that drove it. Every settled attempt is an experience (experience.js);
// every settlement is logged as a `reward` activity event.

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const r3 = (v) => +Number(v).toFixed(3);

export function createRewards({ store = experiences, apply = (r) => pressure.onOutcome(r), levelOf = (b) => pressure.state?.buckets?.[b] ?? 0, enabled = () => pressure.cfg?.feedback?.enabled !== false, now = Date.now, log = activity } = {}) {
  // How it went last time, 0..1: a recorded outcome, or for older records just whether it worked.
  const scoreOf = (e) => (Number.isFinite(e.outcome) ? e.outcome : e.result === 'ok' ? 1 : 0);

  // What she expects from this act: { id, act, objective, bucket, person, drive, track, expected, ... }.
  // level: the driving channel's level when the want fired (read now if not given).
  async function expect({ act, objective, bucket = null, level = null, person = null, method = '', spent = 0, nodes = [] } = {}) {
    if (!enabled() || !act) return null;
    const drive = clamp01(level ?? (bucket ? levelOf(bucket) : 0));
    // Her record at this kind of act (a half-and-half prior while she has none), then pulled toward how the
    // attempts most like this one (by meaning) went.
    const record = store.ofAct(act).slice(-30);
    const baseline = (record.reduce((n, e) => n + scoreOf(e), 0) + 0.5) / (record.length + 1);
    let like = [];
    try { like = await store.similar(objective, { act, limit: 8, min: 0.6 }); } catch {}
    let track = baseline;
    if (like.length) {
      const w = like.map((e) => (e.similarity - 0.5) * 2);
      track = (like.reduce((n, e, i) => n + w[i] * scoreOf(e), 0) + baseline) / (w.reduce((n, x) => n + x, 0) + 1);
    }
    // How strongly she wants it colours how much she expects from it.
    const expected = clamp01(0.75 * track + 0.25 * drive);
    return { id: randomUUID(), act, objective: String(objective ?? '').slice(0, 600), bucket, person, method, spent, nodes, drive: r3(drive), track: r3(track), similar: like.length, expected: r3(expected), at: now() };
  }

  // The act is over. ok: the harness verified it happened (an entry written, a tool result that isn't an
  // error...). outcome (0..1, default 1 when ok) can grade a verified success by what it measurably produced.
  // result: 'ok' | 'failed' | 'inconclusive'. why: what went wrong, for failures. Returns the experience.
  // satisfaction: given when it isn't simply "it happened" (a creation judged by the person it was for: their
  // verdict is the satisfaction, creations.js).
  async function settle(expectation, { ok = false, outcome = null, result = null, why = '', method = null, person = null, nodes = [], spent = null, satisfaction: given = null } = {}) {
    if (!expectation || !enabled()) return null;
    const e = expectation;
    const measured = ok ? clamp01(outcome ?? 1) : 0;
    const satisfaction = given !== null && Number.isFinite(+given) ? clamp01(given) : ok ? 1 : 0;
    const reward = measured - e.expected;
    const who = person ?? e.person ?? null;
    let moved = {};
    try { moved = apply({ bucket: e.bucket, satisfaction, reward, act: e.act, person: who }) ?? {}; }
    catch (err) { log('error', { where: 'reward', message: `Couldn't move energy for the outcome of ${e.act}: ${err.message}. The outcome is still recorded; check pressure.onOutcome.` }); }
    const settledAs = result ?? (ok ? 'ok' : 'failed');
    const record = await store.add({ act: e.act, objective: e.objective, method: method ?? e.method, spent: spent ?? e.spent, result: settledAs, why: settledAs === 'ok' ? '' : why,
      person: who, bucket: e.bucket, expected: e.expected, outcome: r3(measured), satisfaction, reward: r3(reward) });
    const touched = [`act:${e.act}`, ...(e.bucket ? [`bucket:${e.bucket}`] : []), ...Object.keys(moved).map((b) => `bucket:${b}`), ...(who ? [`person:${who}`] : []), `experience:${record.id}`, ...(e.nodes ?? []), ...nodes];
    log('reward', { act: e.act, objective: e.objective, expected: e.expected, outcome: r3(measured), satisfaction, reward: r3(reward), person: who, moved, nodes: [...new Set(touched)] });
    return { ...record, moved };
  }

  return { expect, settle };
}

export const rewards = createRewards();

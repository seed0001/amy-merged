import { avatarPerformance } from './avatar-performance.js';
import { FACE_PRESETS, MOTIONS } from './dashboard/public/avatar-performance.js';
import { STYLES, LADDER } from './dashboard/public/avatar-moments.js';
import { GESTURES } from './emotion.js';
import { CUES, avatarCue, avatarPlay, avatarViewers } from './avatar-cues.js';

// Her avatar self-test: plays every movement she has, one after another, on her live avatar, and
// reports what worked. Her avatar_expression tool runs it (action selftest). Groups can be run alone.
//
// What it can check from here: that each movement is accepted, and which face shapes her current
// model is missing for it (a missing shape means that part of the movement can't show). Whether it
// *looks* right is for whoever is watching the avatar page; the report says whether anyone is.

// Movements the avatar page performs on its own, not via the pose engine.
const PAGE_GESTURES = GESTURES.filter((g) => !STYLES[g] && !['nod', 'shake'].includes(g));
const QUIRKS = ['nose_scrunch', 'smirk_left', 'smirk_right', 'one_brow_up', 'tongue_out', 'puff_cheeks', 'pout', 'lip_bite', 'sneer', 'duck_face'];
const outburst = (name, rest = 0.8) => ({ kind: 'page', name, seconds: STYLES[name].ms / 1000 + (STYLES[name].tears ? 3 : rest) });

export const GROUPS = {
  faces: Object.keys(FACE_PRESETS).filter((n) => !QUIRKS.includes(n)).map((name) => ({ kind: 'pose', name, seconds: 2 })),
  quirks: QUIRKS.map((name) => ({ kind: 'pose', name, seconds: 2 })),
  gestures: MOTIONS.map((name) => ({ kind: 'gesture', name, seconds: name === 'nod' || name === 'shake' ? 2.2 : 3.6 })),
  expressions: PAGE_GESTURES.map((name) => ({ kind: 'page', name, seconds: 2 })),
  // Every outburst style, mildest to strongest, with a beat of rest after each (crying waits for its tears).
  laughing: LADDER.laugh.flat().map((name) => outburst(name)),
  crying: LADDER.cry.flat().map((name) => outburst(name, 1)),
  sympathy: [...new Set(LADDER.sympathy.flat())].map((name) => outburst(name)),
  frustrated: LADDER.frustrated.flat().map((name) => outburst(name)),
  thinking: CUES.map((name) => ({ kind: 'cue', name, seconds: 3.5 })),
};
const ORDER = ['faces', 'quirks', 'expressions', 'gestures', 'thinking', 'laughing', 'sympathy', 'frustrated', 'crying'];

let running = null;
let lastReport = null;
export const lastSelfTest = () => lastReport ?? { none: 'No self-test has finished since she started.' };

// Synchronous checks, before anything plays: which movements her model can't fully show.
function check(item, shapes) {
  if (item.kind !== 'pose') return null;
  const wanted = Object.keys(FACE_PRESETS[item.name] ?? {});
  const missing = wanted.filter((s) => !shapes.includes(s));
  if (missing.length === wanted.length) return `can't show at all (model lacks ${missing.join(', ')})`;
  return missing.length ? `partly: model lacks ${missing.join(', ')}` : null;
}

function perform(item) {
  if (item.kind === 'pose') avatarPerformance.command({ action: 'pose', expression: item.name, duration: Math.max(0.9, item.seconds - 0.4) }, 'tool');
  else if (item.kind === 'gesture') avatarPerformance.command({ action: 'gesture', gesture: item.name }, 'tool');
  else if (item.kind === 'cue') avatarCue(item.name);
  else if (item.kind === 'page') avatarPlay([item.name]);
}

// Starts the test and returns the plan and the checks at once; the movements play over the next
// minutes. The result is read afterwards with lastSelfTest().
export function selfTest({ groups = ['all'] } = {}) {
  if (running) return { started: false, reason: `A self-test is already running (${running.done}/${running.items.length} done).` };
  const names = groups.includes('all') ? ORDER : ORDER.filter((g) => groups.includes(g));
  if (!names.length) return { started: false, reason: `Unknown group. Use: all, ${ORDER.join(', ')}.` };
  const shapes = avatarPerformance.command({ action: 'get' }).shapes ?? [];
  const items = names.flatMap((g) => GROUPS[g].map((i) => ({ ...i, group: g })));
  const warnings = items.map((i) => ({ i, w: check(i, shapes) })).filter((x) => x.w).map(({ i, w }) => `${i.name}: ${w}`);
  const results = [];
  running = { items, done: 0 };
  const viewersAtStart = avatarViewers();
  (async () => {
    avatarPerformance.command({ action: 'reset' }, 'tool');
    for (const item of items) {
      let ok = true, error = null;
      try { perform(item); } catch (err) { ok = false; error = err.message; }
      results.push({ group: item.group, name: item.name, ok, error });
      running.done++;
      await new Promise((r) => setTimeout(r, item.seconds * 1000));
    }
    avatarPerformance.command({ action: 'reset' }, 'tool');
    running = null;
    const failed = results.filter((r) => !r.ok);
    lastReport = { finished: new Date().toISOString(), groups: names, total: results.length, passed: results.length - failed.length, failed, warnings, viewers: avatarViewers() };
  })().catch((err) => { running = null; lastReport = { error: err.message }; });
  return {
    started: true, groups: names, movements: items.length, seconds: Math.round(items.reduce((n, i) => n + i.seconds, 0)),
    watching: viewersAtStart ? `${viewersAtStart} avatar page(s) open` : 'no avatar page is open, so nobody will see it',
    warnings: warnings.length ? warnings : 'every movement can be shown on this model',
  };
}

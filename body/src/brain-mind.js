// What her own brain holds, for the mind view (cognitive-graph.js): the things she knows of, the facts linking
// them, and the rules she has learned, as the Python Amy reports them (brain/interfaces/service.py, op "mind").
//
// The mind view builds its graph in one go and can't wait on her brain, so the last report is kept here and
// refreshed behind it: once when her brain comes up, after every turn she takes (that is when her memory can
// change), and whenever the mind view asks and the report is more than a few seconds old. A report that can't be
// had says why, and the mind view lists her brain as unavailable with that reason instead of showing an empty mind.
import { config } from './config.js';
import { activity, bus } from './events.js';
import { brain } from './brain-client.js';

const STALE_MS = 5000;
let report = null, failed = null, at = 0, running = null;

export function refreshBrainMind({ mind = brain() } = {}) {
  if (config.brain !== 'amy') return Promise.resolve(null);
  return (running ??= mind.mind()
    .then((r) => { report = { self: r.self, things: r.things ?? [], facts: r.facts ?? [], rules: r.rules ?? [] }; failed = null; at = Date.now(); return report; })
    .catch((err) => {
      failed = `her brain couldn't report what it holds: ${err.message}`;
      activity('error', { where: 'mind view (brain)', message: failed });
      return null;
    })
    .finally(() => { running = null; }));
}

// For cognitive-graph.js sources.brain: the latest report, or null when no brain is in use. Throws the reason when
// her brain is in use but has never managed to report.
export function brainMindSnapshot() {
  if (config.brain !== 'amy') return null;
  if (Date.now() - at > STALE_MS) refreshBrainMind();
  if (!report && failed) throw new Error(failed);
  return report;
}

// Her brain has just come up: read what it holds, so the first look at her mind isn't empty. (After each turn,
// brain-reply.js reads it again itself, before it says which nodes the turn touched.)
bus.on('activity', (event) => { if (event.type === 'brain' && event.ready) refreshBrainMind(); });

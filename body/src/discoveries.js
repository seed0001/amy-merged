import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { bus, activity } from './events.js';
import { TOOLS } from './tools.js';
import * as pressure from './pressure.js';

// What she has discovered she can do. Every ability (tool) starts untried; the first time one
// succeeds it's a discovery, and that thrill is pressure (pressure.js: the `discovered` impulse on
// the thrill feeling). While abilities are still untried and someone is around, the discovery want
// fills; when it fires she realizes one out loud, excited, and says what it opens up. Nothing here
// writes a line of her prompt on its own: pressure.excitementLine() reads it.
//
// A memory wipe clears this file, so a fresh install discovers everything again, with its owner.

const FILE = path.join(DATA_DIR, 'discoveries.json');
// Plumbing, not abilities: nothing to be thrilled about.
const SKIP = new Set(['guide', 'read_source', 'knowledge', 'request_tool', 'owner_rules', 'doctor', 'restart', 'bot_control', 'free_talk', 'wake_words', 'turn_classifier', 'onboarding', 'timeline', 'memories', 'forget', 'notes', 'topics', 'status', 'self_check', 'presence_note']);
const RECENT_MS = 30 * 60_000;

export function createDiscoveries({ file = FILE, tools = () => Object.keys(TOOLS), describe = (name) => TOOLS[name]?.definition?.function?.description ?? '', now = Date.now, onDiscovered = () => {} } = {}) {
  let state = (() => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } })() ?? { tried: {}, shown: {} };
  // A failed save is logged (it reaches "What broke lately", awareness.js), never swallowed: otherwise a
  // restart would make her "discover" the same abilities again with no record of why.
  const save = () => { try { writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1)); renameSync(`${file}.tmp`, file); } catch (err) { activity('error', { where: 'discoveries', message: `Couldn't save ${file}: ${err.message}. First uses since the last good save will count as new again after a restart.` }); } };
  const abilities = () => tools().filter((t) => !SKIP.has(t) && !t.startsWith('_'));
  const firstSentence = (text) => String(text).split(/(?<=[.!?])\s/)[0].slice(0, 160);

  return {
    // A tool just succeeded. The first time ever is a discovery.
    tried(tool) {
      if (SKIP.has(tool) || state.tried[tool]) return false;
      state.tried[tool] = now();
      save();
      activity('discovery', { tool, first: true });
      try { onDiscovered(tool); } catch (err) { activity('error', { where: 'discoveries', message: `The first use of ${tool} was recorded, but the thrill didn't reach pressure: ${err.message}` }); }
      return true;
    },
    untried: () => abilities().filter((t) => !state.tried[t]),
    // Tools first used lately: what she's buzzing about.
    recent: () => Object.entries(state.tried).filter(([, at]) => now() - at < RECENT_MS).sort((a, b) => b[1] - a[1]).map(([t]) => t),
    // For pressure: how much there is left to discover, 0..1. Falls as she tries things.
    need() {
      const all = abilities().length;
      if (!all) return 0;
      return Math.min(1, this.untried().length / all * 1.5);
    },
    // The discovery want fired: one untried ability she hasn't been shown yet, with what it does.
    pick() {
      const fresh = this.untried().filter((t) => !state.shown[t]);
      const pool = fresh.length ? fresh : this.untried();
      if (!pool.length) return null;
      const tool = pool[Math.floor(Math.random() * pool.length)];
      state.shown[tool] = now();
      save();
      return { tool, text: firstSentence(describe(tool)) || tool };
    },
    stats: () => ({ tried: Object.keys(state.tried).length, untried: this.untried().length }),
  };
}

export const discoveries = createDiscoveries({ onDiscovered: (tool) => pressure.onDiscovered(tool) });
pressure.setDiscoverer(discoveries);
// Every tool call she makes is logged (tools.js runTool); a success is a try.
bus.on('activity', (e) => { if (e.type === 'tool-call' && e.ok && e.tool) discoveries.tried(e.tool); });

import { ownerDisplayName } from './owner-name.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, selfName } from './config.js';
import { runCoder } from './doctor.js';
import { resolve as resolvePath, show } from './files.js';
import { activity } from './events.js';

// Finds an installed Steam game by the name Owner gave, so she can aim at its real folder without a path.
export function findInstalledApp(name) {
  const want = String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!want) return [];
  const hits = [];
  for (const steam of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter((p) => existsSync(p))) {
    const libraries = new Set([path.join(steam, 'steamapps')]);
    try {
      for (const m of readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) {
        libraries.add(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps'));
      }
    } catch {}
    for (const lib of libraries) {
      let files = [];
      try { files = readdirSync(lib).filter((f) => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
      for (const f of files) {
        const text = readFileSync(path.join(lib, f), 'utf8');
        const game = text.match(/"name"\s+"([^"]+)"/)?.[1];
        const dir = text.match(/"installdir"\s+"([^"]+)"/)?.[1];
        if (game && dir && game.toLowerCase().replace(/[^a-z0-9]/g, '').includes(want)) {
          hits.push({ name: game, path: path.join(lib, 'common', dir) });
        }
      }
    }
  }
  return hits;
}

// Reverse engineering with REA (Reverse Engineer Anything, github.com/morluto/rea): working out how
// an app, a program, a website or a file works from the shipped thing itself, without its source.
// REA is installed for Claude Code (an MCP server with ~230 tools, plus its reverse-engineer-anything
// skill), so an investigation is a Claude Code run, in the background, the same way her workshop
// jobs are. Each one gets its own folder for notes and evidence, and its report comes back to the
// conversation that asked. One at a time; the owner only.

const JOB_TIMEOUT_MS = 45 * 60_000;
const REA_ENTRY = 'C:\\Tools\\rea\\node_modules\\rea-agents\\scripts\\rea.mjs';

// Is REA really there for Claude Code? Says exactly what's missing, so she never claims a run she can't do.
export function reaReady({ entry = REA_ENTRY, claudeConfig = path.join(os.homedir(), '.claude.json') } = {}) {
  if (!existsSync(entry)) return `REA isn't installed (${entry} is missing). ${ownerDisplayName()} needs to reinstall it (npm install --prefix C:\\Tools\\rea rea-agents with Node 24.22+).`;
  try {
    if (!JSON.parse(readFileSync(claudeConfig, 'utf8')).mcpServers?.rea) return `REA is installed but not registered with Claude Code (no "rea" entry in .claude.json). ${ownerDisplayName()} needs to run REA setup for Claude Code again.`;
  } catch (e) { return `Claude Code's config couldn't be read (${e.message}), so it isn't clear REA is registered.`; }
  return null;
}

const RULES = (job) => `You are investigating something for ${ownerDisplayName()}, the owner of this PC, using REA (Reverse Engineer Anything): the rea MCP tools and the reverse-engineer-anything skill. ${selfName()} (his companion bot) relays what he asked; you do the investigation. Rules:
- Use REA's tools for the analysis: static inspection first (files, packages, JavaScript/Electron, .NET, native binaries, websites); runtime tools (Frida, browser capture) only when the question needs live behavior.
- Only inspect. Never modify, patch, crack or redistribute the target, never bypass licensing, DRM or anti-cheat, and never pull out passwords, keys, tokens or other people's private data. If the question asks for that, say so and stop.
- Work in your folder, ${job.folder}: save your notes and the evidence there as report.md (findings, the evidence behind each one, and limitations). Don't change anything outside it.
- Do the whole job without asking for confirmation; ${ownerDisplayName()} is often away from the keyboard. If a REA tool fails, read why, fix what you can and keep going; if something can't be done (for example native decompiling with no Ghidra, IDA, Hopper or Kuna installed), say exactly that.
- Finish with a short, plain-language report ${selfName()} can read out loud: what you found, how sure you are and why, and what you couldn't determine. Three to eight sentences, no code blocks.`;

export function createReverse({
  dir = path.join(DATA_DIR, 'reverse'),
  workRoot = () => path.join(resolvePath('Desktop'), 'REA investigations'),
  coder = runCoder,
  ready = reaReady,
  now = Date.now,
} = {}) {
  mkdirSync(dir, { recursive: true });
  const file = (id) => path.join(dir, `${id}.json`);
  const all = () => readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'))).sort((a, b) => a.id - b.id);
  const save = (job) => writeFileSync(file(job.id), JSON.stringify(job, null, 2));
  let running = null; // { job, child, cancelled }

  return {
    // Starts an investigation in the background; notify(text) gets the report.
    start({ target, question }, notify = async () => {}) {
      let t = String(target ?? '').trim();
      const q = String(question ?? '').trim();
      if (!t) throw new Error('Nothing was started: say what to investigate (a program or app path, a file, a folder, or a website URL).');
      if (!q) throw new Error(`Nothing was started: say what ${ownerDisplayName()} wants to know about it (e.g. "how does its search work").`);
      const missing = ready();
      if (missing) throw new Error(`Nothing was started: ${missing}`);
      if (running) throw new Error(`Investigation #${running.job.id} ("${running.job.title}") is still running; one at a time. Wait for it or cancel it.`);
      // A local target has to exist; a URL is checked by the run itself.
      if (!/^https?:\/\//i.test(t)) {
        let full = null;
        try { full = resolvePath(t); } catch {}
        if (!full || !existsSync(full)) {
          // Not a path: maybe the name of an installed game or app ("AION 2").
          const apps = findInstalledApp(t);
          if (apps.length === 1) t = apps[0].path;
          else if (apps.length > 1) throw new Error(`Nothing was started: "${t}" matches more than one installed app: ${apps.map((a) => a.name).join(', ')}. Ask ${ownerDisplayName()} which one.`);
          else throw new Error(`Nothing was started: ${show(full ?? t)} doesn't exist, and no installed app matches "${t}". Ask ${ownerDisplayName()} for the install folder.`);
        }
      }
      const id = all().reduce((n, j) => Math.max(n, j.id), 0) + 1;
      const title = q.length > 70 ? `${q.slice(0, 67)}...` : q;
      const slug = `${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
      const folder = path.join(workRoot(), slug);
      mkdirSync(folder, { recursive: true });
      const job = { id, target: t, question: q, title, folder, status: 'running', started: now() };
      save(job);
      running = { job, child: null, cancelled: false };
      activity('reverse', { job: id, status: 'started', target: t, question: title });
      const slot = running;
      (async () => {
        const result = await coder({ prompt: `Target: ${t}\nWhat ${ownerDisplayName()} wants to know: ${q}`, rules: RULES(job), cwd: folder, timeoutMs: JOB_TIMEOUT_MS, onChild: (c) => { slot.child = c; } });
        // REA lives in Claude Code; if it fell back to another engine, REA wasn't there for it.
        const noRea = result.engine && result.engine !== 'claude';
        Object.assign(job, {
          status: slot.cancelled ? 'cancelled' : result.ok && !noRea ? 'done' : 'failed', finished: now(), engine: result.engine,
          report: noRea ? `Claude Code couldn't run, so it fell back to ${result.engine}, which doesn't have REA; the investigation wasn't done with REA. ${result.report}` : result.report,
          saved: existsSync(path.join(folder, 'report.md')),
        });
        save(job);
        running = null;
        activity('reverse', { job: id, status: job.status, report: String(job.report).slice(0, 400) });
        await notify(`Investigation #${id} "${title}" ${job.status}:\n${job.report}\n${job.saved ? `Full notes and evidence: ${show(path.join(folder, 'report.md'))}` : `Its folder: ${show(folder)} (no report.md was written).`}`).catch(() => {});
      })();
      return `Investigation #${id} started on ${t}: "${title}". It runs in the background with REA and can take a while (up to 45 minutes); the report comes here when it's done. Notes go in ${show(folder)}.`;
    },

    list() {
      const jobs = all().slice(-10).reverse();
      return jobs.length ? jobs.map((j) => `#${j.id} ${j.title} (${j.target}): ${j.status}${j.finished ? `, ${new Date(j.finished).toLocaleString()}` : `, running ${Math.round((now() - j.started) / 60_000)} min`}`).join('\n') : 'No investigations yet.';
    },

    report(id) {
      if (!existsSync(file(Number(id)))) throw new Error(`There's no investigation #${id}. ${all().length ? `There are #1 to #${all().at(-1).id}.` : 'There are none yet.'}`);
      const j = JSON.parse(readFileSync(file(Number(id)), 'utf8'));
      return `Investigation #${j.id}: ${j.status}.\nTarget: ${j.target}\nAsked: ${j.question}\n${j.report ? `Report: ${j.report}\n` : ''}Folder: ${show(j.folder)}${j.saved ? ' (report.md has the full notes and evidence)' : ''}`;
    },

    cancel() {
      if (!running) return 'No investigation is running.';
      running.cancelled = true;
      running.child?.kill();
      return `Stopping investigation #${running.job.id}. Whatever notes it wrote stay in its folder.`;
    },

    status: () => (running ? `#${running.job.id} "${running.job.title}", ${Math.round((now() - running.job.started) / 60_000)} min in` : null),
  };
}

let shared = null;
export const reverse = () => (shared ??= createReverse());

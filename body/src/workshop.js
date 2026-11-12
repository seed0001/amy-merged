import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, config, selfName } from './config.js';
import { activity } from './events.js';
import { resolve as resolvePath, show } from './files.js';
import { runCoder } from './doctor.js';
import { openRouterCoder } from './project-coder.js';
import { serveFolder, verifyBrowserApp } from './webapp.js';
import { browser } from './browser.js';

// A project is either a browser app (a folder with index.html: it opens in one of her browser tabs,
// nothing to install or run) or a program with a run command (the older kind). Coding jobs run on
// OpenRouter when a key is set, and fall back to the Claude Code / OpenCode CLI otherwise.
const defaultCoder = (args) => (config.openrouter.apiKey ? openRouterCoder(args) : runCoder(args));
const defaultOpenTab = async (url) => { await browser().open(url); };
const isBrowserApp = (p) => !p.run && existsSync(path.join(p.path, 'index.html'));
// The build guide every browser app folder carries. It was "AMY-BUILD-GUIDE.md" until 2026-11-11, which put Amy's
// name in every app James built; folders made before that still have the old name and are still recognised.
export const BUILD_GUIDE = 'BUILD-GUIDE.md';
const GUIDE_NAMES = [BUILD_GUIDE, 'AMY-BUILD-GUIDE.md'];
const buildGuide = BUILD_GUIDE;
const isBrowserProject = (p) => !p.run && (isBrowserApp(p) || GUIDE_NAMES.some((g) => existsSync(path.join(p.path, g))));

// Her workshop: the owner's projects she helps build (a game, a site, anything with a folder). She
// keeps each one's details, can tell you anything about it, runs it, and sends coding jobs to Claude
// Code working inside that project. Every job is bracketed by git commits, so it can be undone, and
// nothing is pushed: on most of these projects a push is a public deploy, and that's the owner's call.
//
// Nothing about any one project is written here: the owner tells her about a project and she saves it.

const execute = promisify(execFile);
const JOB_TIMEOUT_MS = 30 * 60_000;

export function createWorkshop({
  dir = path.join(DATA_DIR, 'workshop'),
  resolve = resolvePath,
  coder = defaultCoder,
  openTab = defaultOpenTab,
  git = (cwd, ...args) => execute('git', ['-c', `user.name=${selfName()}`, '-c', `user.email=${selfName().toLowerCase()}@localhost`, ...args], { cwd, maxBuffer: 16 << 20, windowsHide: true }).then((r) => r.stdout),
  now = Date.now,
} = {}) {
  const FILE = path.join(dir, 'projects.json');
  const JOBS = path.join(dir, 'jobs');
  const active = new Map(); // project key -> { job, child }
  const starting = new Set();
  const servers = new Map(); // project key -> child process
  const sites = new Map(); // project key -> { url, close } for browser apps being served
  mkdirSync(JOBS, { recursive: true });

  const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
  const save = (all) => writeFileSync(FILE, JSON.stringify(all, null, 2));
  const keyOf = (name) => String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function project(name) {
    const all = load(), key = keyOf(name);
    if (!key) throw new Error(`Which project? ${Object.values(all).map((p) => p.name).join(', ') || 'None saved yet.'}`);
    const matches = Object.entries(all).filter(([k]) => k.includes(key));
    if (!all[key] && matches.length > 1) throw new Error(`Which project? ${matches.map(([, p]) => p.name).join(', ')}.`);
    const found = all[key] ?? matches[0]?.[1];
    if (!found) throw new Error(`No project called "${name}". ${Object.keys(all).length ? `Yours: ${Object.values(all).map((p) => p.name).join(', ')}.` : 'None saved yet: add one with its folder.'}`);
    return { ...found, key: keyOf(found.name) };
  }

  const jobFile = (id) => path.join(JOBS, `${id}.json`);
  const jobs = () => readdirSync(JOBS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(JOBS, f), 'utf8'))).sort((a, b) => a.id - b.id);
  const saveJob = (job) => writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
  // A job still marked running when she starts up was cut off by her restart (its coder process died
  // with her): say so, instead of it reading as "running" forever.
  try {
    for (const j of jobs()) if (j.status === 'running') {
      Object.assign(j, { status: 'interrupted', finished: now(), report: `Cut off when ${selfName()} restarted before the coder finished. Nothing was saved as a commit; any half-made edits would show in git status of the project folder.` });
      saveJob(j);
      activity('workshop', { project: j.projectName, job: j.id, status: 'interrupted' });
    }
  } catch {}

  const RULES = (p) => `You are working on ${p.name}, one of your owner's projects, in ${p.path}. ${selfName()} (his companion bot) relays what he asked for; you do the coding. Rules:
- Do the whole job without asking for permission or confirmation; the owner is often away from the keyboard. If something fails, fix it and keep going until it works.
- Stay inside this project's folder.
${p.build ? `- After changing source, rebuild it: ${p.build}.\n` : ''}${p.run ? `- Check your change really works: run it (${p.run}${p.url ? `, at ${p.url}` : ''}), load it, look for errors, and stop anything you started.\n` : isBrowserProject(p) ? `- This is a browser app: plain HTML, CSS and JavaScript that opens straight in one of the owner's browser tabs, with index.html at the top of the folder. No build step, no npm, no dev server, no install. Read ${BUILD_GUIDE} first. Check your files for errors; ${selfName()} verifies the app over HTTP before reporting it ready.\n` : ''}- Never push, deploy or publish: ${p.deploy ? `here that's ${p.deploy}, and ` : ''}going live is the owner's decision. Don't commit either; ${selfName()} saves your work as one commit.
${p.notes ? `- About this project: ${p.notes}\n` : ''}- Finish with a short, plain-language report she can read out loud: what you changed and why, which files, and whether you saw it working. Two to six sentences, no code blocks.`;

  return {
    add({ name, folder, run, url, build, deploy, notes, browserApp = !run }) {
      if (!String(name ?? '').trim()) throw new Error('Give the project a name.');
      const full = resolve(folder);
      const all = load(), key = keyOf(name), old = all[key] ?? {};
      if (!key) throw new Error('Use a project name containing letters or numbers.');
      if (old.path && path.relative(old.path, full)) throw new Error(`${old.name} is already registered at ${show(old.path)}. Use a different project name for another folder.`);
      if (!existsSync(full)) mkdirSync(full, { recursive: true });
      if (!statSync(full).isDirectory()) throw new Error(`${show(full)} is a file, not a project folder.`);
      const pick = (v, was) => (typeof v === 'string' && v.trim() ? v.trim() : was);
      all[key] = { name: String(name).trim(), path: full, run: pick(run, old.run), url: pick(url, old.url), build: pick(build, old.build), deploy: pick(deploy, old.deploy), notes: pick(notes, old.notes), added: old.added ?? now() };
      save(all);
      // A browser app's folder carries its own build guide, so whoever works in it knows how it's built.
      if (browserApp && !all[key].run) {
        const guide = path.join(full, buildGuide);
        if (!existsSync(guide)) { try { writeFileSync(guide, readFileSync(path.join(ROOT, 'knowledge', 'systems', 'browser-apps.md'), 'utf8')); } catch {} }
      }
      activity('workshop', { project: all[key].name, saved: show(full) });
      return `Saved ${all[key].name} at ${show(full)}.`;
    },

    // Her projects as she should know them every turn: what each is, whether it's running, jobs in flight.
    snapshot() {
      return Object.values(load()).map((p) => {
        const key = keyOf(p.name), job = active.get(key)?.job;
        return { name: p.name, folder: show(p.path), url: sites.get(key)?.url ?? p.url, running: servers.has(key) || sites.has(key), notes: p.notes, job: job ? `#${job.id} "${job.title}", ${Math.round((now() - job.started) / 60_000)} min in` : null };
      });
    },

    list() {
      const all = Object.values(load());
      return all.length ? all.map((p) => `${p.name}: ${show(p.path)}${active.has(keyOf(p.name)) ? ' (a coding job is running)' : ''}`).join('\n') : 'No projects saved yet.';
    },

    project,

    // Everything worth knowing at a glance, fresh from disk and git.
    async overview(name) {
      const p = project(name);
      const g = (...a) => git(p.path, ...a).then((s) => s.trim()).catch(() => '');
      const [branch, status, log, ahead] = await Promise.all([g('branch', '--show-current'), g('status', '--short'), g('log', '--format=%h %ad %s', '--date=short', '-n', '10'), g('rev-list', '--left-right', '--count', '@{upstream}...HEAD')]);
      const [behind = '0', unpushed = '0'] = ahead.split(/\s+/);
      const top = readdirSync(p.path, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).map((d) => d.name + (d.isDirectory() ? '/' : ''));
      const docs = ['README.md', ...(existsSync(path.join(p.path, 'docs')) ? readdirSync(path.join(p.path, 'docs')).map((f) => `docs/${f}`) : [])].filter((f) => existsSync(path.join(p.path, f)));
      const recent = jobs().filter((j) => j.project === p.key).slice(-5).reverse();
      const changed = status ? status.split('\n') : [];
      return [
        `${p.name} at ${show(p.path)}${branch ? `, branch ${branch}` : ''}.`,
        p.run && `Run: ${p.run}${p.url ? ` (${p.url})` : ''}${servers.has(p.key) ? ', running now' : ''}.`,
        p.build && `Build: ${p.build}.`,
        p.deploy && `Deploy: ${p.deploy}.`,
        p.notes && `Notes: ${p.notes}`,
        `Uncommitted changes: ${changed.length ? `${changed.length}\n${changed.slice(0, 20).join('\n')}` : 'none'}.`,
        ahead && `Commits not pushed: ${unpushed}; behind the last fetch: ${behind}.`,
        log && `Recent commits:\n${log}`,
        `Top level: ${top.join(', ')}`,
        docs.length && `Docs: ${docs.join(', ')}`,
        active.has(p.key) ? `A coding job is running: #${active.get(p.key).job.id} "${active.get(p.key).job.title}".` : null,
        recent.length && `Recent jobs:\n${recent.map((j) => `#${j.id} ${j.title}: ${j.status}${j.changed?.length ? ` (${j.changed.length} files)` : ''}`).join('\n')}`,
      ].filter(Boolean).join('\n');
    },

    // Starts a coding job in the background; notify(text) gets the report.
    async start(name, task, notify = async () => {}) {
      const p = project(name);
      task = String(task ?? '').trim();
      if (!task) throw new Error('Describe the change in full: what, where, and what done looks like.');
      if (active.has(p.key)) throw new Error(`Job #${active.get(p.key).job.id} "${active.get(p.key).job.title}" is still running on ${p.name}. Wait for it or cancel it.`);
      if (starting.has(p.key)) throw new Error(`A job is already starting on ${p.name}.`);
      const title = task.length > 70 ? `${task.slice(0, 67)}...` : task;
      starting.add(p.key);
      let before;
      try {
        if (!existsSync(path.join(p.path, '.git'))) {
          if (!isBrowserProject(p) || readdirSync(p.path).some((name) => !GUIDE_NAMES.includes(name))) {
            throw new Error(`${p.name} isn't a git repository, so a job couldn't be undone. Make it one first.`);
          }
          await git(p.path, 'init', '-q');
        }
        // Save the owner's work first, including the initial state of a new browser app.
        const head = await git(p.path, 'rev-parse', '--verify', 'HEAD').catch(() => '');
        if (!head || (await git(p.path, 'status', '--porcelain')).trim()) {
          await git(p.path, 'add', '-A');
          await git(p.path, 'commit', '-q', '--allow-empty', '-m', `Before ${selfName()}'s job: ${title}`);
        }
        before = (await git(p.path, 'rev-parse', 'HEAD')).trim();
      } finally {
        starting.delete(p.key);
      }
      const job = { id: jobs().reduce((n, j) => Math.max(n, j.id), 0) + 1, project: p.key, projectName: p.name, title, task, status: 'running', started: now(), before };
      saveJob(job);
      const slot = { job, child: null };
      active.set(p.key, slot);
      activity('workshop', { project: p.name, job: job.id, status: 'started', task: title });

      (async () => {
        let result;
        try {
          result = await coder({ prompt: task, rules: RULES(p), cwd: p.path, timeoutMs: JOB_TIMEOUT_MS, onChild: (c) => { slot.child = c; if (slot.cancelled) c.kill(); } });
          if (!slot.cancelled && result.ok && isBrowserProject(p)) {
            const verified = await verifyBrowserApp(p.path);
            result = { ...result, report: `${result.report}\nVerified: index.html served over HTTP (${verified} bytes).` };
          }
        } catch (error) {
          result = { ok: false, report: error.message, engine: result?.engine };
        }
        let changed = [];
        try {
          if ((await git(p.path, 'status', '--porcelain')).trim()) {
            await git(p.path, 'add', '-A');
            changed = (await git(p.path, 'diff', '--cached', '--name-only')).trim().split('\n').filter(Boolean);
            await git(p.path, 'commit', '-q', '-m', `${selfName()}'s job #${job.id}: ${title}`);
          }
        } catch (err) {
          result = { ...result, ok: false, report: `${result.report} (Saving the work failed: ${err.message})` };
        }
        Object.assign(job, { status: slot.cancelled ? 'cancelled' : result.ok ? 'done' : 'failed', finished: now(), engine: result.engine, report: result.report, changed, after: (await git(p.path, 'rev-parse', 'HEAD').catch(() => before)).trim() });
        saveJob(job);
        active.delete(p.key);
        activity('workshop', { project: p.name, job: job.id, status: job.status, changed: changed.length, report: job.report.slice(0, 400) });
        const files = changed.length ? `Changed: ${changed.slice(0, 15).join(', ')}.${job.after !== before ? ' Saved as a commit, not pushed.' : ''}` : 'No files changed.';
        await notify(`${p.name} job #${job.id} "${title}" ${job.status}:\n${job.report}\n${files}`).catch(() => {});
      })();
      return `Job #${job.id} on ${p.name} started: "${title}". It runs in the background and can take several minutes; the report comes here when it's done.`;
    },

    jobs(name) {
      const key = name ? project(name).key : null;
      const list = jobs().filter((j) => !key || j.project === key).slice(-10).reverse();
      return list.length ? list.map((j) => `#${j.id} ${j.projectName}: ${j.title} — ${j.status}${j.finished ? `, ${new Date(j.finished).toLocaleString()}` : `, running ${Math.round((now() - j.started) / 60_000)} min`}`).join('\n') : 'No jobs yet.';
    },

    report(id) {
      const file = jobFile(Number(id));
      if (!existsSync(file)) throw new Error(`There's no job #${id}.`);
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return `Job #${j.id} on ${j.projectName}: ${j.status}.\nAsked: ${j.task}\n${j.report ? `Report: ${j.report}\n` : ''}${j.changed?.length ? `Files: ${j.changed.join(', ')}` : ''}`;
    },

    cancel(name) {
      const p = project(name), slot = active.get(p.key);
      if (!slot) return `Nothing is running on ${p.name}.`;
      slot.cancelled = true;
      slot.child?.kill();
      return `Stopping job #${slot.job.id}. Whatever it already changed is saved, so it can be undone.`;
    },

    // Rolls back the most recent finished job, only if nothing has been committed on top of it.
    async undo(name) {
      const p = project(name);
      if (active.has(p.key)) throw new Error(`Job #${active.get(p.key).job.id} is still running. Cancel it first.`);
      const last = jobs().filter((j) => j.project === p.key && j.status !== 'running' && j.status !== 'undone').at(-1);
      if (!last) return `There's no job on ${p.name} to undo.`;
      const head = (await git(p.path, 'rev-parse', 'HEAD')).trim();
      if (head !== last.after) throw new Error(`Something was committed after job #${last.id}, so undoing it would lose that too. Ask for a job to revert it instead.`);
      if ((await git(p.path, 'status', '--porcelain')).trim()) throw new Error(`${p.name} has uncommitted changes since job #${last.id}; undoing would throw them away.`);
      await git(p.path, 'reset', '--hard', last.before);
      Object.assign(last, { status: 'undone', undone: now() });
      saveJob(last);
      activity('workshop', { project: p.name, job: last.id, status: 'undone' });
      return `Undid job #${last.id} "${last.title}" on ${p.name}.`;
    },

    // The project's build step, for after she edits a file herself.
    async build(name) {
      const p = project(name);
      if (!p.build) throw new Error(`${p.name} has no build step saved. Add one (e.g. "npm run build in build/").`);
      return command(p, p.build, 300_000);
    },

    // A browser app is served from its folder and opened in one of her tabs. Anything else is shown
    // through its run command, then opened at its url if it has one.
    async open(name) {
      const p = project(name);
      if (!p.run && !isBrowserApp(p)) throw new Error(`${p.name} isn't a browser app yet: it needs an index.html at the top of its folder.`);
      if (p.run && !p.url) throw new Error(`${p.name} has no browser URL saved. Use run to start it.`);
      if (p.run) await this.run(name);
      let url = p.url;
      if (!p.run) {
        if (!sites.has(p.key)) sites.set(p.key, await serveFolder(p.path));
        url = sites.get(p.key).url;
      }
      if (!await up(url)) throw new Error(`${p.name} isn't responding successfully at ${url}.`);
      await openTab(url);
      activity('workshop', { project: p.name, opened: url });
      return `${p.name} is open in your browser tab at ${url}.`;
    },

    // Starts the project's run command and keeps it going until stopped (or she restarts).
    async run(name) {
      const p = project(name);
      if (!p.run) {
        if (!isBrowserApp(p)) throw new Error(`${p.name} has no run command saved.`);
        return this.open(name);
      }
      if (servers.has(p.key)) {
        if (p.url && !await up(p.url)) throw new Error(`${p.name} has started but is not responding at ${p.url} yet.`);
        return `${p.name} is already running${p.url ? ` at ${p.url}` : ''}.`;
      }
      if (p.url && await up(p.url)) throw new Error(`${p.url} already responds from a server the workshop didn't start. Confirm the address or free the port before starting ${p.name}.`);
      const { program, args, cwd } = parse(p, p.run);
      const child = spawn(program, args, { cwd, windowsHide: true, shell: false });
      let output = '', spawnError;
      child.stdout?.on('data', (d) => { output = (output + d).slice(-4000); });
      child.stderr?.on('data', (d) => { output = (output + d).slice(-4000); });
      child.on('error', (err) => { spawnError = err; servers.delete(p.key); });
      child.on('exit', () => { if (servers.get(p.key) === child) servers.delete(p.key); });
      servers.set(p.key, child);
      await new Promise((resolve) => { child.once('spawn', resolve); child.once('error', resolve); });
      let ready = !p.url;
      for (let i = 0; !ready && !spawnError && child.exitCode === null && child.signalCode === null && i < 40; i++) {
        ready = await up(p.url);
        if (!ready) await new Promise((r) => setTimeout(r, 250));
      }
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error(`${p.name} stopped right away: ${spawnError?.message ?? output.trim().slice(-500)}`);
      if (!ready) {
        this.stop(name);
        throw new Error(`${p.name} did not become ready at ${p.url}: ${output.trim().slice(-500)}`);
      }
      activity('workshop', { project: p.name, running: p.url ?? true });
      return `${p.name} is running${p.url ? ` at ${p.url}` : ''}.`;
    },

    stop(name) {
      const p = project(name), child = servers.get(p.key), site = sites.get(p.key);
      if (site) { site.close().catch(() => {}); sites.delete(p.key); }
      if (!child) return site ? `Stopped serving ${p.name}.` : `${p.name} isn't running (not by me, anyway).`;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
      servers.delete(p.key);
      return `Stopped ${p.name}.`;
    },
  };

  // "npm run build in build/" or "python serve.py": a program, its arguments, and where.
  function parse(p, text) {
    const [cmd, where] = String(text).split(/\s+in\s+/i);
    const [program, ...args] = cmd.trim().split(/\s+/);
    const isWin = process.platform === 'win32';
    const cwd = where ? path.resolve(p.path, where.trim()) : p.path;
    const relative = path.relative(p.path, cwd);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('The command must run inside the project folder.');
    if (isWin && ['npm', 'npx'].includes(program)) {
      const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${program}-cli.js`);
      if (!existsSync(cli)) throw new Error(`${program} was not found beside Node.js.`);
      return { program: process.execPath, args: [cli, ...args], cwd };
    }
    return { program, args, cwd };
  }

  async function command(p, text, timeout) {
    const { program, args, cwd } = parse(p, text);
    try {
      const out = await execute(program, args, { cwd, timeout, maxBuffer: 8 << 20, windowsHide: true, shell: false });
      return `Done: ${text}.\n${String(out.stdout + out.stderr).trim().slice(-1500)}`;
    } catch (err) {
      return `Error: ${text} failed.\n${String((err.stdout ?? '') + (err.stderr ?? '') || err.message).trim().slice(-2000)}`;
    }
  }
}

async function up(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

let shared;
export const workshop = () => (shared ??= createWorkshop());

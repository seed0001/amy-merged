import { spawn, execFile } from 'node:child_process';
import { existsSync, writeFileSync, rmSync, readdirSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { ROOT, DATA_DIR, config, updateSettings, selfName } from './config.js';
import { activity } from './events.js';

// The doctor: Claude Code run headless on her own project with the owner's own Claude login, to
// fix or adjust her code when the owner asks (never on her own, never for anyone else, and never
// as a way to chat). When Claude Code isn't installed or signed in, the same job automatically
// falls back to OpenCode (the owner's other coding agent, `opencode run`). Every visit is
// bracketed by git commits so it can be undone, and tests run after. She never restarts herself
// to apply a fix: the owner decides when.
const run = promisify(execFile);
const git = (...args) => run('git', ['-c', `user.name=${selfName()}`, '-c', `user.email=${selfName().toLowerCase()}@localhost`, ...args], { cwd: ROOT, maxBuffer: 8 << 20 });
const TIMEOUT_MS = 20 * 60000;
const FIX_ROUNDS = 3; // times failing tests go back to the doctor before it reports
let visit = null; // { task, started, child }
// A persisted visit lets the next startup report a repair that was interrupted.
const LOCK = path.join(DATA_DIR, 'doctor.lock');

// Finished visits, newest first, kept on disk: a spoken report can be lost to a text-to-speech
// timeout, and she is restarted to apply every fix, so "any word from the doctor?" must still have
// an answer afterwards. Each entry: { at, title, ok, report, changed, tests, engine }.
const REPORTS = path.join(DATA_DIR, 'doctor-reports.json');
const KEEP_REPORTS = 10;
let reports = (() => {
  try {
    const list = JSON.parse(readFileSync(REPORTS, 'utf8'));
    return Array.isArray(list) ? list.filter((r) => r && typeof r.at === 'number') : [];
  } catch { return []; }
})();
let last = reports[0] ?? null; // the most recent finished visit
export const lastVisit = () => last;
export const doctorBusy = () => Boolean(visit);
export const recentReports = () => reports.slice();
function saveReport(entry) {
  last = entry;
  reports = [entry, ...reports].slice(0, KEEP_REPORTS);
  try { mkdirSync(path.dirname(REPORTS), { recursive: true }); writeFileSync(REPORTS, JSON.stringify(reports, null, 1)); } catch {}
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

// True means the lock still belongs to a live visit. Older installs wrote only a timestamp.
export function doctorLocked(now = Date.now()) {
  let lock;
  try { lock = JSON.parse(readFileSync(LOCK, 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') return false;
    if (!(err instanceof SyntaxError)) return true;
    try { lock = statSync(LOCK).mtimeMs; }
    catch { return true; }
  }
  if (lock?.pid ? pidAlive(lock.pid) || pidAlive(lock.childPid) : now - Number(lock) < TIMEOUT_MS + 60_000) return true;
  try { rmSync(LOCK, { force: true }); } catch { return true; }
  if (last?.started === (lock?.started ?? Number(lock))) return false;
  const title = lock?.task ?? 'Interrupted doctor visit';
  const report = 'The repair stopped before it could report. Its file changes and tests were not verified.';
  saveReport({ at: now, started: lock?.started ?? Number(lock), title, ok: false, report, changed: 'unverified', tests: 'not verified', engine: '' });
  activity('doctor', { status: 'interrupted', task: title, report });
  return false;
}

// "3:34 PM, 12 minute(s) ago": a time she can repeat to the owner.
export function describeWhen(at, now = Date.now()) {
  const clock = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const mins = Math.floor((now - at) / 60000);
  return `${clock}, ${mins < 1 ? 'less than a minute ago' : mins === 1 ? '1 minute ago' : `${mins} minutes ago`}`;
}

// The sentence for "the doctor is busy", true to what is running and since when.
function busySentence(now = Date.now()) {
  return `The doctor is already working on "${visit.task}" (started at ${describeWhen(visit.started, now)}) and has not finished yet.`;
}

// Minimum task length (characters) for a doctor call: anything shorter is a slip, not a job.
const MIN_TASK = 15;

// The doctor's prompt: the owner's own words are the authority, verbatim; the task text her hands
// model wrote is a paraphrase that has been known to come out backwards.
export function buildDoctorPrompt(task, ownerText = '') {
  const quote = String(ownerText ?? '').trim();
  const parts = [];
  if (quote) parts.push(`Owner said (verbatim, the authority on what he wants):\n"${quote.replace(/"/g, '”')}"`);
  parts.push(`${quote ? 'Her paraphrase of the request' : 'The request as she relayed it'} (written by her hands model, which can get the meaning backwards${quote ? '; where it disagrees with the quote above, trust the quote and do NOT trust the paraphrase' : '; check it against the recent logs before acting on it'}):\n${task}`);
  parts.push('(Recent context is in her logs; read them first.)');
  return parts.join('\n\n');
}

function findClaude() {
  const candidates = [
    process.env.CLAUDE_PATH,
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'claude.cmd'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? 'claude'; // else hope it's on PATH
}

function findOpenCode() {
  const candidates = [
    config.doctorOpenCode.path.trim() || process.env.OPENCODE_PATH,
    // The OpenCode desktop app ships a CLI in two places, the second of which is versioned.
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe'),
    ...(() => {
      const cli = path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'cli');
      if (!existsSync(cli)) return [];
      let versions = [];
      try { versions = readdirSync(cli); } catch { return []; }
      return versions.map((v) => path.join(cli, v, 'opencode-cli.exe'));
    })(),
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'opencode.cmd'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

// Ordered candidate doctors: Claude Code first (the owner's pull request rule), OpenCode second.
function doctorCandidates() {
  const list = [{ kind: 'claude', bin: findClaude() }];
  const opencode = findOpenCode();
  if (opencode) list.push({ kind: 'opencode', bin: opencode });
  return list;
}

const RULES = `You are the doctor for ${config.botName}, a Discord companion bot whose code is in this folder. Her owner asked for the fix or change below; she is relaying it. Rules:
- You have full access: every tool, any command (node, npm, npx, pip, python, PowerShell, git, scripts), the whole bots folder (${path.resolve(ROOT, '..')}) (every bot, including their data/, .env and models/), installing packages, committing, and restarting or starting bots. Use whatever the job needs.
- Read the relevant code and the recent logs (data/activity.jsonl, data/tool-failures.jsonl, data/bot.err.log) first, then do the job completely. Never stop to ask the owner for permission or confirmation, and never finish by asking him what to do: if something fails, fix it and keep going until it works.
- Run \`npm test\` after changing code and keep fixing until it passes, including tests an earlier change broke or that are out of date.
- The owner runs everything by voice and is not at the keyboard. Never leave him a step to do by hand (run a script, type a command, edit a file, sign in, close a window): do it yourself, all the way to the finished result. If you build a script to make something, run it and report where the result is.
- Finish with a short plain-language report for the owner: what was wrong, what you changed (files), and whether tests pass. Two to five sentences, no code blocks: she may read it out loud.`;

export function doctorStatus(now = Date.now()) {
  if (visit) return `${busySentence(now)} It will report when it finishes.`;
  if (doctorLocked(now)) return 'A doctor visit still holds the repair lock.';
  // Idle, but the last visit's report is the answer to "any word from the doctor?": a spoken report
  // can be lost to a text-to-speech failure, so it's here (from disk, so a restart keeps it) to say again.
  if (!last) return 'The doctor is not working on anything right now, and there is no report from an earlier visit on record.';
  return `The doctor is not working on anything right now. The last visit, "${last.title}", finished at ${describeWhen(last.at, now)} and ${last.ok ? 'went fine' : 'FAILED'}${last.changed ? ` (changed: ${last.changed}; tests ${last.tests})` : ' (no files changed)'}. Its report: ${last.report}`;
}

// A finished visit as a verified tool result for her history ("doctor <title>: ok, tests pass"), so
// later turns see what really happened instead of an unbacked claim she might take back.
export const visitResult = (v) => `doctor ${v.title}: ${v.ok ? 'ok' : 'failed'}, ${v.changed ? `tests ${v.tests}` : 'no files changed'}`;

// Build the spawn args for one doctor engine (claude or opencode). rules/extraDir: the doctor's own
// unless another job (the workshop, on the owner's other projects) brings its own.
function doctorArgs(kind, bin, prompt, resume, rules = RULES, extraDir = path.resolve(ROOT, '..')) {
  if (kind === 'claude') {
    return {
      args: ['-p', prompt, '--output-format', 'json', ...(resume ? ['--resume', resume] : []),
        '--append-system-prompt', rules, '--dangerously-skip-permissions', ...(extraDir ? ['--add-dir', extraDir] : [])],
      shell: bin.endsWith('.cmd'),
    };
  }
  // OpenCode has no --append-system-prompt flag, so the rules ride along in the prompt itself.
  // A saved doctor model (settings/van .env, e.g. openrouter/~openai/gpt-sol-latest) steers the
  // account to a specific model; blank lets OpenCode pick its configured default.
  const full = `${rules}\n\n${prompt}`;
  const model = config.doctorOpenCode.model.trim();
  return {
    args: ['run', full, '--format', 'json', '--auto', ...(model ? ['--model', model] : []),
      ...(resume ? ['--session', resume] : [])],
    shell: bin.endsWith('.cmd'),
  };
}

// One coding run outside her own folder (the workshop): Claude Code in `cwd`, falling back to
// OpenCode only if Claude Code can't run at all. Resolves to { ok, report, sessionId, engine } and
// never throws. onChild(child) lets the caller cancel it.
export async function runCoder({ prompt, rules, cwd, resume = null, timeoutMs = TIMEOUT_MS, onChild = () => {}, engineKind = null }) {
  const candidates = doctorCandidates();
  let engine = (engineKind && candidates.find((c) => c.kind === engineKind)) || candidates[0];
  const once = (e) => new Promise((resolve) => {
    const { args, shell } = doctorArgs(e.kind, e.bin, prompt, resume, rules, null);
    const child = spawn(e.bin, args, { cwd, shell, windowsHide: true });
    onChild(child);
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (x) => { clearTimeout(timer); resolve({ failure: x.code === 'ENOENT' ? 'ENOENT' : x.message, out, err }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  let attempt = await once(engine);
  if (engine.kind === 'claude' && !resume && candidates.length > 1 && engineUnavailable('claude', attempt)) {
    engine = candidates[1];
    attempt = await once(engine);
  }
  const { code, out = '', err = '', failure = null } = attempt;
  const parsed = parseDoctorOutput(engine.kind, out);
  let report = failure === 'ENOENT' ? 'No coding agent is installed here: neither Claude Code nor OpenCode could be found.' : failure;
  if (!report) {
    report = parsed.result ?? (out || err).trim().slice(-1500);
    if (code !== 0) report = `It stopped early (exit ${code}). ${report || err.slice(-500)}`;
    if ((parsed.isError || code !== 0) && /not logged in|\/login/i.test(report)) report = `${engine.kind === 'claude' ? 'Claude Code' : 'OpenCode'} isn't signed in on this computer: open a terminal, run \`${engine.kind} auth login\`, sign in, then ask again.`;
  }
  return { ok: !failure && code === 0 && !parsed.isError, report: String(report || 'No report.'), sessionId: parsed.sessionId, engine: engine.kind };
}

// Turn a doctor's raw stdout into { result, isError, sessionId }. Claude Code prints one JSON
// object; OpenCode prints NDJSON events with text parts.
function parseDoctorOutput(kind, out) {
  if (kind === 'claude') {
    try {
      const parsed = JSON.parse(out);
      return { result: parsed.result ?? null, isError: Boolean(parsed.is_error), sessionId: parsed.session_id ?? null };
    } catch {
      return { result: null, isError: false, sessionId: null };
    }
  }
  let text = '', sessionId = null, sawError = false;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.sessionID && !sessionId) sessionId = event.sessionID;
      if (event.type === 'text' && event.part && typeof event.part.text === 'string') text += (text ? '\n' : '') + event.part.text;
      if (event.type === 'error') sawError = true;
    } catch {}
  }
  return { result: text.trim() || null, isError: sawError, sessionId };
}

// Does this failed attempt mean the engine itself is unavailable (missing, not signed in, or out of
// usage), rather than the work failing? Only those cases trigger the OpenCode fallback.
function engineUnavailable(kind, { failure, code, out = '', err = '' }) {
  if (failure === 'ENOENT') return true;
  if (kind === 'claude' && (failure || code !== 0) && /not logged in|\/login|auth|hit your .{0,30}limit|usage limit/i.test(out + err)) return true;
  if (kind === 'claude' && /Claude Code isn't installed/i.test(String(failure || ''))) return true;
  return false;
}

// Models available on the signed-in OpenCode account (`opencode models`), for the dashboard's
// doctor settings and for switching the doctor's OpenCode model by voice. Returns a plain list of
// model IDs, or an error string when the CLI can't be reached.
export async function openCodeModels() {
  const bin = doctorCandidates().find((c) => c.kind === 'opencode')?.bin;
  if (!bin) return { available: false, models: [], error: "OpenCode isn't installed: no opencode-cli binary was found." };
  try {
    const { stdout } = await run(bin, ['models'], { cwd: ROOT, shell: bin.endsWith('.cmd'), timeout: 60000, maxBuffer: 8 << 20 });
    const models = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { available: true, models, error: null };
  } catch (e) {
    return { available: false, models: [], error: String(e.stderr || e.message).slice(0, 300) };
  }
}

// The doctor's current fallback configuration, for settings and reporting.
export function doctorConfig() {
  return {
    claude: { found: true }, // claude req is always present (falls back to PATH); reported separately
    openCode: {
      found: Boolean(findOpenCode()),
      path: config.doctorOpenCode.path || process.env.OPENCODE_PATH || '(auto)',
      model: config.doctorOpenCode.model || '(OpenCode default)',
    },
  };
}

// Set/report the OpenCode doctor model. An empty/blank value clears it back to OpenCode's default.
export async function doctorModel(value) {
  if (typeof value === 'string' && value.trim()) {
    const list = await openCodeModels();
    if (list.available && !list.models.includes(value.trim())) {
      return `That model isn't in OpenCode's list. Run "opencode models" to see what's available, e.g. openrouter/~openai/gpt-sol-latest or openrouter/~anthropic/claude-sonnet-latest.`;
    }
    updateSettings({ doctorOpenCodeModel: value.trim() });
    return `The OpenCode doctor will use ${value.trim()}. It takes effect on the next doctor visit.`;
  }
  updateSettings({ doctorOpenCodeModel: '' });
  return 'The OpenCode doctor is back on its default model (cleared the custom choice).';
}

// A copy of the report by Discord DM to the owner(s), so it is readable even when speech fails and
// the voice session has no text channel. Resolves to the number of owners reached; throws if none.
async function dmOwners(text) {
  const ids = config.ownerIds.filter((id) => id && id !== 'dashboard');
  if (!ids.length) throw new Error('no owner Discord id is configured');
  const { bot } = await import('./bot.js');
  const client = bot.client;
  if (!client?.isReady?.()) throw new Error('Discord is offline');
  let sent = 0, lastError = null;
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id);
      const dm = await user.createDM();
      for (let i = 0; i < text.length; i += 1900) await dm.send({ content: text.slice(i, i + 1900), allowedMentions: { parse: [] } });
      sent++;
    } catch (e) { lastError = e; }
  }
  if (!sent) throw lastError ?? new Error('no owner could be reached');
  return sent;
}

// Starts a visit in the background and returns at once ("dispatched, not done"); notify(text) gets
// the report when it ends. Options:
//   ownerText    the owner's own words that led to this call, quoted verbatim in the doctor's task
//   deliverText  async (text): a text channel to post the report to, as the fallback if the owner
//                can't be reached by DM (the report always lands in text, besides being spoken)
//   spawnImpl, gitImpl, npmTestImpl, dmImpl, candidates, now: test seams
export async function callDoctor(task, notify, opts = {}) {
  task = String(task ?? '').trim();
  if (task.length < MIN_TASK) return `Error: the doctor needs a real task (at least ${MIN_TASK} characters): say what is wrong or what to change, in full. Nothing was dispatched.`;
  const now = opts.now ?? Date.now;
  if (visit) return `Error: ${busySentence(now())} Nothing new was dispatched: wait for it to finish, or cancel it.`;
  const gitCmd = opts.gitImpl ?? git;
  const spawnFn = opts.spawnImpl ?? spawn;
  const dm = opts.dmImpl ?? dmOwners;
  const ownerText = String(opts.ownerText ?? '').trim();
  const title = task.length > 60 ? `${task.slice(0, 57)}...` : task;
  visit = { task: title, started: now() };
  const lock = { pid: process.pid, task: title, started: visit.started };
  try {
    if (doctorLocked(now())) throw new Error('Another doctor visit holds the repair lock.');
    writeFileSync(LOCK, JSON.stringify(lock), { flag: 'wx' });
  } catch (err) {
    visit = null;
    return `Error: Could not reserve a doctor visit. ${err.message}`;
  }
  // Snapshot first, so this visit (and only this visit) can be undone.
  try {
    await gitCmd('add', '-A');
    await gitCmd('commit', '-q', '--allow-empty', '-m', `Before doctor: ${task.slice(0, 60)}`);
  } catch (err) {
    rmSync(LOCK, { force: true });
    visit = null;
    return `Error: Could not snapshot the workspace for the doctor. ${err.message}`;
  }
  activity('doctor', { status: 'started', task, ownerText: ownerText.slice(0, 500) });

  const started = visit.started;
  const candidates = opts.candidates ?? doctorCandidates();
  let engine = candidates[0] ?? null;
  let fellBack = false;

  const runOnce = (prompt, resume) => new Promise((resolve) => {
    const { args, shell } = doctorArgs(engine.kind, engine.bin, prompt, resume);
    const child = spawnFn(engine.bin, args, { cwd: ROOT, shell, windowsHide: true });
    visit.child = child;
    if (child.pid) {
      try { writeFileSync(LOCK, JSON.stringify({ ...lock, childPid: child.pid })); } catch {}
    }
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), Math.max(1000, TIMEOUT_MS - (now() - started)));
    child.on('error', (e) => { clearTimeout(timer); resolve({ failure: e.code === 'ENOENT' ? 'ENOENT' : e.message, out, err }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });

  // One doctor run; on the very first run, if Claude Code itself can't run, retry the same job
  // with OpenCode.
  const visitRun = async (prompt, resume) => {
    if (!engine) return { failure: 'No doctor is installed here: neither Claude Code nor OpenCode could be found.' };
    let attempt = await runOnce(prompt, resume);
    if (!fellBack && engine.kind === 'claude' && candidates.length > 1 && engineUnavailable('claude', attempt)) {
      engine = candidates[1];
      fellBack = true;
      visit.child = null;
      activity('doctor', { status: 'fallback', task: title, from: 'claude', to: engine.kind });
      attempt = await runOnce(prompt, resume);
    }
    return attempt;
  };

  const npmTest = opts.npmTestImpl ?? (() => run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: ROOT, shell: process.platform === 'win32', timeout: 300000, maxBuffer: 8 << 20 })
    .then(() => ({ ok: true }), (e) => ({ ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` })));

  (async () => {
    let { code, out = '', err = '', failure = null } = await visitRun(buildDoctorPrompt(task, ownerText));
    // Failing tests go straight back to the doctor (same session) to fix, not to the owner.
    for (let round = 0; round < FIX_ROUNDS && !failure && code === 0 && visit && now() - started < TIMEOUT_MS; round++) {
      const changed = (await gitCmd('diff', '--stat', 'HEAD').catch(() => ({ stdout: '' }))).stdout.trim();
      if (!changed) break;
      const t = await npmTest();
      if (t.ok) break;
      const parsed = parseDoctorOutput(engine?.kind, out);
      activity('doctor', { status: 'fixing tests', task: title, round: round + 1 });
      ({ code, out = '', err = '', failure = null } = await visitRun(`npm test fails after your change. Fix it now (your code, or tests that are wrong or out of date), run npm test until it passes, then give the owner your final report. Don't ask him what to do.\n\nTest output (end):\n${t.output.slice(-6000)}`, parsed.sessionId));
    }
    await finish(code, failure, out, err).catch((e) => activity('error', { where: 'doctor finish', message: e.message }));
  })();

  async function finish(code, failure, out, err) {
    let report = failure, isError = false;
    const kind = engine?.kind ?? 'claude';
    const parsed = parseDoctorOutput(kind, out);
    if (!report) {
      // The doctor exits 0 even when the run fails; the payload says so in its own way.
      report = parsed.result ?? (out || err).trim().slice(-1500);
      isError = Boolean(parsed.isError);
      if (code !== 0) report = `The doctor stopped early (exit ${code}). ${report || err.slice(-500)}`;
      if (kind === 'claude') {
        // Claude Code keeps its own login, separate from the Claude desktop app's. Only a failed run is
        // a login problem; a finished report may just mention logging in.
        if ((isError || code !== 0) && /not logged in|\/login/i.test(report)) report = "Claude Code isn't signed in on this computer. Its login is separate from the Claude desktop app: open a terminal, run `claude auth login`, sign in with your Claude account, then ask me again.";
      } else if ((isError || code !== 0) && /login|auth|sign in/i.test(report)) {
        report = "OpenCode isn't signed in on this computer: open a terminal, run `opencode auth login`, sign in, then ask me again.";
      }
    }
    let summary = '', tests = 'not run';
    try {
      summary = (await gitCmd('diff', '--stat', 'HEAD')).stdout.trim();
      if (summary) {
        tests = (await npmTest()).ok ? 'pass' : 'FAIL';
        await gitCmd('add', '-A');
        await gitCmd('commit', '-q', '-m', `Doctor: ${title}`);
      }
    } catch (e) { report += ` (Saving the change failed: ${e.message})`; }
    const ok2 = !failure && code === 0 && !isError && tests !== 'FAIL';
    const who = fellBack ? ' (OpenCode fallback)' : kind === 'claude' ? '' : ' (OpenCode)';
    activity('doctor', { status: ok2 ? 'done' : 'failed', task: title, changed: Boolean(summary), tests, report: String(report).slice(0, 500), engine: String(kind).concat(fellBack ? ':fallback' : '') });
    // On disk first: whatever happens to speech and Discord below, `status` can repeat this.
    saveReport({ at: now(), started, title, ok: ok2, report: String(report || '').slice(0, 800), changed: summary.split('\n').slice(0, -1).map((l) => l.split('|')[0].trim()).join(', '), tests, engine: who });
    try { rmSync(LOCK, { force: true }); }
    catch (err) { activity('error', { where: 'doctor lock cleanup', message: err.message }); }
    visit = null;
    const text = `Doctor visit "${title}" ${ok2 ? 'done' : 'failed'}${who}:\n${report || 'No report.'}\n` +
      (summary ? `Changed:\n${summary}\nTests: ${tests}.${tests === 'FAIL' ? ' Say "undo the doctor" to roll it back.' : ''} Restart me when you want the fix to take effect.` : 'No files were changed.');
    // Delivery, each leg on its own: the caller's notify (speech, in voice), then unconditionally a
    // text copy, by DM to the owner or, failing that, to the text channel the call came from.
    const delivered = [];
    try { await notify?.(text); delivered.push('notify'); } catch (e) { delivered.push(`notify failed: ${e.message}`); }
    let inText = false;
    try { await dm(text); delivered.push('dm'); inText = true; } catch (e) { delivered.push(`dm failed: ${e.message}`); }
    if (!inText && opts.deliverText) {
      try { await opts.deliverText(text); delivered.push('channel'); inText = true; } catch (e) { delivered.push(`channel failed: ${e.message}`); }
    }
    activity('doctor', { status: 'reported', task: title, delivered, inText });
    opts.onFinished?.({ text, delivered, inText });
  }
  return `Dispatched, not done: the doctor has started on "${title}" (${ownerText ? 'with your owner\'s exact words attached' : 'without a quote of your owner\'s words'}). It works in the background for a few minutes and the report comes when it finishes; nothing is fixed yet. Tell your owner briefly that it has been sent, not that it is done.`;
}

export function cancelDoctor() {
  if (!visit?.child) return 'The doctor is not working on anything.';
  visit.child.kill();
  return 'Told the doctor to stop. Anything it already changed is kept until you undo it.';
}

// Rolls back the most recent doctor visit (its commit and anything uncommitted after it).
export async function undoDoctor() {
  if (visit) return `Error: ${doctorStatus()} Cancel it first.`;
  const log = (await git('log', '--format=%H %s', '-n', '50')).stdout.trim().split('\n');
  const before = log.find((l) => l.split(' ').slice(1).join(' ').startsWith('Before doctor:'));
  if (!before) return 'There is no doctor visit to undo.';
  const [hash, ...subject] = before.split(' ');
  await git('reset', '--hard', hash);
  activity('doctor', { status: 'undone', task: subject.join(' ') });
  return `Rolled back the doctor's last visit (${subject.join(' ').replace('Before doctor: ', '')}). Restart me to load the old code.`;
}

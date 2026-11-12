import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

// The other companion bots on this PC (PEER_APPS in .env), so each one can start the others and bring
// them into a call: "Alex=C:\...\Alex@3001,Howard|Gramps|Grandpa=C:\...\Gramps@3002". Names before
// the = are what people call them; the first is their own name.
//  - Not running: leave a restart.json note in their data folder (where we are: guild, voice and text
//    channel), then run their start.bat in its own window. On startup they read the note
//    (restart.js), join that call and say hello.
//  - Already running: ask their dashboard to join the voice channel.

export function parsePeerApps(value) {
  return String(value ?? '').split(',').map((entry) => {
    const m = entry.trim().match(/^([^=]+)=(.+)@(\d+)$/);
    if (!m) return null;
    const names = m[1].split('|').map((n) => n.trim()).filter(Boolean);
    return { name: names[0], names, dir: m[2].trim(), port: Number(m[3]) };
  }).filter(Boolean);
}

export function findPeerApp(apps, name) {
  const want = String(name ?? '').trim().toLowerCase();
  return apps.find((a) => a.names.some((n) => n.toLowerCase() === want)) ?? null;
}

// Any other bot dropped into the bots folder with a start file (not in PEER_APPS, so no dashboard port):
// she can still start it, matched by its folder name ("HalMini", "hal mini", "mini hal") or the name it
// goes by. The start file is start.bat, else one named start*.bat (HalMini's is start_halmini.bat).
const FOLDER_BOT_NAMES = { halmini: ['Adam'] };

function launcher(dir) {
  if (existsSync(path.join(dir, 'start.bat'))) return 'start.bat';
  try { return readdirSync(dir).filter((f) => /^start.*\.bat$/i.test(f)).sort()[0] ?? null; } catch { return null; }
}

export function folderBots(botsDir, { skip = [] } = {}) {
  const skipped = skip.map((d) => path.resolve(d).toLowerCase());
  let entries = [];
  try { entries = readdirSync(botsDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ e, bat: launcher(path.join(botsDir, e.name)) }))
    .filter(({ bat }) => bat)
    .map(({ e, bat }) => ({ name: e.name, names: [e.name, ...(FOLDER_BOT_NAMES[e.name.toLowerCase()] ?? [])], dir: path.join(botsDir, e.name), port: null, bat }))
    .filter((a) => !skipped.includes(path.resolve(a.dir).toLowerCase()));
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const wordsOf = (s) => String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(' ');

export function findFolderBot(bots, name) {
  const want = squash(name);
  if (!want) return null;
  return bots.find((b) => b.names.some((n) => squash(n) === want || wordsOf(n) === wordsOf(name))) ?? null;
}

// Use the installation folder to disambiguate display names shared by several copies.
export function peerInstallation(app) {
  let identity = {};
  try { identity = parse(readFileSync(path.join(app.dir, '.env'))); } catch {}
  const folder = path.basename(app.dir);
  return { ...app, folder, names: [...new Set([...app.names, identity.BOT_NAME, folder].filter(Boolean))], discordId: identity.CLIENT_ID || null };
}

export function peerTargets(apps, name) {
  const raw = String(name ?? '').trim();
  if (path.isAbsolute(raw)) return apps.filter((app) => path.resolve(app.dir).toLowerCase() === path.resolve(raw).toLowerCase());
  const folder = /^folder:\s*(.+)$/i.exec(raw);
  if (folder) return apps.filter((app) => squash(app.folder) === squash(folder[1]));
  return apps.filter((app) => findFolderBot([app], raw));
}

// Whether a Discord member looks like this bot (by any of its names), for "is it already in the call".
export function isFolderBotMember(bot, member) {
  return Boolean(member?.user?.bot) && [member.displayName, member.user.username, member.user.globalName]
    .some((n) => n && bot.names.some((b) => squash(b) === squash(n)));
}

// A folder bot has no dashboard to ask, so she types its join command in the text chat while she's in
// the call (HalMini's sidecar joins whoever typed !join). It may still be loading, so she repeats it
// until a new bot turns up in the call, deleting each one after. Returns that member, or null.
export async function callIntoVoice({ textChannel, voiceChannel, command = '!join', tries = 1, every = 20000, firstWait = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const botsInCall = () => [...voiceChannel.members.values()].filter((m) => m.user?.bot);
  const there = new Set(botsInCall().map((m) => m.id));
  if (firstWait) await sleep(firstWait);
  for (let i = 0; i < tries; i++) {
    const sent = await textChannel.send(command).catch(() => null);
    for (let waited = 0; waited < every; waited += 1000) {
      await sleep(1000);
      const arrived = botsInCall().find((m) => !there.has(m.id));
      if (arrived) { sent?.delete().catch(() => {}); return arrived; }
    }
    sent?.delete().catch(() => {});
  }
  return null;
}

const dashboard = (app, route) => `http://127.0.0.1:${app.port}${route}`;

export async function isRunning(app, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(dashboard(app, '/api/settings'), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// The environment to start another bot with: ours, minus everything our own .env set. Values already
// in the environment win over a bot's .env, so without this the other bot ran with our name, IDs,
// voices and peer list (it started up calling itself Amy).
export function cleanEnv(env = process.env, ownEnvFile = fileURLToPath(new URL('../.env', import.meta.url))) {
  const own = existsSync(ownEnvFile) ? Object.keys(parse(readFileSync(ownEnvFile))) : [];
  const clean = { ...env };
  for (const key of [...own, 'CHAMP_SUPERVISED']) delete clean[key];
  return clean;
}

// marker: { guildId, voiceChannelId, textChannelId, by: { id, name }, startedBy }.
export function start(app, marker, { spawnImpl = spawn, now = Date.now, env = cleanEnv() } = {}) {
  const bat = app.bat ?? 'start.bat';
  if (!existsSync(path.join(app.dir, bat))) throw new Error(`${app.name}'s ${bat} isn't at ${app.dir}`);
  if (marker?.guildId) {
    mkdirSync(path.join(app.dir, 'data'), { recursive: true });
    writeFileSync(path.join(app.dir, 'data', 'restart.json'), JSON.stringify({ at: now(), reason: '', doctor: null, ...marker }, null, 2));
  }
  // The full path to the start file, so the window's command line names the folder and stopBot finds it.
  const child = spawnImpl('cmd.exe', ['/c', `start "${app.name}" /D "${app.dir}" "${path.join(app.dir, bat)}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', env });
  child.unref?.();
}

const psJson = async (script) => {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 32 << 20, timeout: 30000 });
  const out = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(out) ? out : [out];
};

// What a start file runs: "-m interfaces.dashboard", "src\bot.js", "app.py" (lowercase).
function startCommands(app) {
  let bat = '';
  try { bat = readFileSync(path.join(app.dir, app.bat ?? 'start.bat'), 'utf8'); } catch { return []; }
  const found = new Set();
  for (const m of bat.matchAll(/-m\s+([\w.]+)/g)) found.add(`-m ${m[1]}`.toLowerCase());
  for (const m of bat.matchAll(/(?:^|[\s"])([\w.\\/-]+\.(?:js|mjs|py))\b/gim)) found.add(m[1].toLowerCase());
  return [...found];
}

// The windows a bot runs in: every process whose command line names its folder (how its start file was
// run, by double-click or by us) or that listens on its dashboard port, climbed up to the window it runs
// under. Never this bot's own process or its parents. Returns the top process IDs.
export async function botWindows(app, { self = process.pid } = {}) {
  const procs = await psJson('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress');
  const byId = new Map(procs.map((p) => [p.ProcessId, p]));
  const mine = new Set();
  for (let p = byId.get(self); p && !mine.has(p.ProcessId); p = byId.get(p.ParentProcessId)) mine.add(p.ProcessId);
  const dir = path.resolve(app.dir).toLowerCase();
  const names = (c) => { const s = String(c ?? '').toLowerCase(); const i = s.indexOf(dir); return i >= 0 && /^($|[\\"' ])/.test(s.slice(i + dir.length)); };
  const RUNNERS = /^(cmd|node|python\d*|pythonw|py)\.exe$/i;
  const hits = procs.filter((p) => RUNNERS.test(p.Name) && names(p.CommandLine)).map((p) => p.ProcessId);
  if (app.port) {
    const listeners = await psJson(`Get-NetTCPConnection -State Listen -LocalPort ${Number(app.port)} -ErrorAction SilentlyContinue | Select-Object OwningProcess | ConvertTo-Json -Compress`).catch(() => []);
    const runs = startCommands(app).map((run) => run.replaceAll('/', '\\'));
    for (const listener of listeners) {
      const proc = byId.get(listener.OwningProcess);
      const command = String(proc?.CommandLine ?? '').toLowerCase().replaceAll('/', '\\');
      if (RUNNERS.test(proc?.Name) && runs.some((run) => command.includes(run))) hits.push(proc.ProcessId);
    }
  }
  const tops = new Set();
  for (const id of hits) {
    let p = byId.get(id);
    if (!p || mine.has(p.ProcessId)) continue;
    let parent = byId.get(p.ParentProcessId);
    while (parent && RUNNERS.test(parent.Name) && !mine.has(parent.ProcessId) && names(parent.CommandLine)) {
      p = parent;
      parent = byId.get(p.ParentProcessId);
    }
    tops.add(p.ProcessId);
  }
  return [...tops];
}

// Turns a bot off: closes its windows and everything started from them (life support included, so it
// doesn't come back). Returns how many windows were closed.
export async function stopBot(app) {
  const tops = await botWindows(app);
  const stopped = await Promise.allSettled(tops.map((pid) => promisify(execFile)('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })));
  if (stopped.some((result) => result.status === 'rejected')) throw new Error('Windows could not confirm every bot process stopped.');
  return tops.length;
}

// Asks a running companion to leave the voice call it's in.
export async function leaveVoice(app, guildId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(dashboard(app, `/api/voice/${guildId}/leave`), { method: 'POST', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${app.name}'s dashboard answered ${res.status}`);
  return Boolean((await res.json().catch(() => ({}))).left);
}

export async function joinVoice(app, channelId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(dashboard(app, '/api/voice/join'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId }), signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${app.name}'s dashboard answered ${res.status}`);
}

// Changes settings on a running peer, the same way its dashboard's Save does.
export async function setPeerSettings(app, patch, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(dashboard(app, '/api/settings'), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${app.name}'s dashboard answered ${res.status}`);
}

// Starts the peer or brings it into the voice channel; returns what happened, for the tool result.
export async function bringPeer(app, { guildId, voiceChannelId, textChannelId, by, startedBy }, deps = {}) {
  if (await isRunning(app, deps)) {
    if (!voiceChannelId) return `${app.name} is already running.`;
    await joinVoice(app, voiceChannelId, deps);
    return `${app.name} was already running and is joining the voice call now.`;
  }
  start(app, { guildId, voiceChannelId, textChannelId, by, startedBy }, deps);
  return `Started ${app.name} in a new window. ${voiceChannelId ? `${app.name} joins this voice call once up (about half a minute) and says hello.` : `${app.name} comes online in Discord in about half a minute.`}`;
}

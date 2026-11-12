import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, config } from './config.js';

// Digital Entity Creation Workshop: copies this code base into a new folder beside it, with its keys
// left blank for the owner to fill in on the dashboard. Discord tokens and secrets are never copied.

const BOTS_DIR = path.dirname(ROOT);
const REGISTRY = path.join(BOTS_DIR, '.entity-copies.json');
const FIRST_PORT = 3010;
const SECRET = /TOKEN|KEY|PASSWORD|SECRET/;
const ID_KEYS = new Set(['CLIENT_ID', 'GUILD_ID', 'OWNER_IDS', 'CHAT_CHANNEL_IDS', 'VOICE_CHANNEL_IDS', 'PEER_BOTS', 'PEER_APPS', 'PEER_UNLIMITED', 'OWNER_ALT_ACCOUNT_IDS']);
const REQUIRED = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'OPENROUTER_API_KEY'];
const OPTIONAL = ['FISH_API_KEY', 'GROQ_API_KEY', 'TAVILY_API_KEY', 'HF_TOKEN', 'MISTRAL_API_KEY', 'DASHBOARD_PASSWORD'];
const BLANK_IN_COPY = new Set(['CLIENT_ID', 'GUILD_ID', 'CHAT_CHANNEL_IDS', 'VOICE_CHANNEL_IDS', 'PEER_BOTS', 'PEER_APPS', 'PEER_UNLIMITED', 'OWNER_ALT_ACCOUNT_IDS']);
const SKIP_TOP = new Set(['data', '.git']);
const SKIP_FILE = /\.(zip|db|db-wal|db-shm|log)$/i;

const httpError = (message, status) => Object.assign(new Error(message), { status });
const isEditable = (key) => SECRET.test(key) || ID_KEYS.has(key);

function readEnv(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/);
}
function envValue(lines, key) {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : '';
}
function setEnv(lines, key, value) {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
}

function readRegistry() {
  try { return JSON.parse(readFileSync(REGISTRY, 'utf8')); } catch { return []; }
}
function writeRegistry(list) {
  writeFileSync(REGISTRY, JSON.stringify(list, null, 2));
}

// Amy's own .env: secrets shown only as set / not set, everything else as its value.
function envView(file) {
  if (!existsSync(file)) return [];
  return readEnv(file)
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l))
    .filter(Boolean)
    .map(([, key, value]) => (SECRET.test(key)
      ? { key, secret: true, set: value.length > 0 }
      : { key, secret: false, value }));
}

function keyStatus(file) {
  const lines = existsSync(file) ? readEnv(file) : [];
  return [...REQUIRED, ...OPTIONAL].map((key) => ({ key, required: REQUIRED.includes(key), set: envValue(lines, key).length > 0 }));
}

export function overview() {
  const own = path.join(ROOT, '.env');
  return {
    own: {
      code: ROOT,
      env: own,
      data: DATA_DIR,
      dashboard: `http://127.0.0.1:${config.dashboard.port}`,
      sharedFolder: BOTS_DIR,
      registry: REGISTRY,
      env_vars: envView(own),
    },
    copies: readRegistry().map((c) => {
      const keys = keyStatus(path.join(c.dir, '.env'));
      return { ...c, keys, missing: keys.filter((k) => k.required && !k.set).map((k) => k.key) };
    }),
  };
}

function nextPort(list) {
  const used = new Set([config.dashboard.port, ...list.map((c) => c.port)]);
  let port = FIRST_PORT;
  while (used.has(port)) port++;
  return port;
}

const keepInCopy = (src) => {
  const rel = path.relative(ROOT, src);
  if (!rel) return true;
  const [top] = rel.split(path.sep);
  if (SKIP_TOP.has(top)) return false;
  const base = path.basename(src);
  if (base === '.env' || SKIP_FILE.test(base)) return false;
  return true;
};

export function createCopy(name) {
  const clean = String(name ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9 _-]{0,29}$/.test(clean)) {
    throw httpError('Name it with letters, numbers, spaces, - or _ (start with a letter).', 400);
  }
  const id = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = path.join(BOTS_DIR, clean);
  const list = readRegistry();
  if (existsSync(dir) || list.some((c) => c.id === id)) throw httpError(`${clean} already exists in ${BOTS_DIR}`, 409);

  cpSync(ROOT, dir, { recursive: true, filter: keepInCopy });

  const port = nextPort(list);
  const env = readEnv(path.join(ROOT, '.env')).map((line) => {
    const m = /^([A-Z_]+)=/.exec(line);
    if (!m) return line;
    const key = m[1];
    if (key === 'BOT_NAME') return `BOT_NAME=${clean}`;
    if (key === 'DASHBOARD_PORT') return `DASHBOARD_PORT=${port}`;
    if (BLANK_IN_COPY.has(key) || SECRET.test(key)) return `${key}=`;
    return line;
  });
  writeFileSync(path.join(dir, '.env'), env.join('\n'));

  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const settings = JSON.parse(readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  Object.assign(settings, { botName: clean, chatChannelIds: [], voiceChannelIds: [], botEnabled: false, voiceFreeTalk: false });
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));

  const copy = { id, name: clean, dir, port, createdAt: Date.now() };
  writeRegistry([...list, copy]);
  return { ...copy, keys: keyStatus(path.join(dir, '.env')) };
}

function findCopy(id) {
  const copy = readRegistry().find((c) => c.id === id);
  if (!copy) throw httpError('No copy with that id', 404);
  return copy;
}

export function setCopyKeys(id, values = {}) {
  const copy = findCopy(id);
  const file = path.join(copy.dir, '.env');
  const lines = readEnv(file);
  for (const [key, value] of Object.entries(values)) {
    if (!isEditable(key) || typeof value !== 'string' || !value.trim()) continue;
    setEnv(lines, key, value.trim());
  }
  writeFileSync(file, lines.join('\n'));
  return keyStatus(file);
}

export function startCopy(id) {
  const copy = findCopy(id);
  const missing = keyStatus(path.join(copy.dir, '.env')).filter((k) => k.required && !k.set).map((k) => k.key);
  if (missing.length) throw httpError(`Fill these in first: ${missing.join(', ')}`, 400);
  spawn('cmd.exe', ['/c', 'start.bat'], { cwd: copy.dir, detached: true, stdio: 'ignore' }).unref();
  return { started: true, dashboard: `http://127.0.0.1:${copy.port}` };
}

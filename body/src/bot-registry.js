import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { activity } from './events.js';

// Which bots on this PC may talk to which. Nobody talks to anybody until Owner says so. The registry
// lives on the server (C:\Bots\.bot-registry.json, shared by every bot) and each bot checks it before it
// answers, joins, or brings in another bot. Stopping a pair cuts both directions at once.

export const REGISTRY_FILE = process.env.BOT_REGISTRY || path.resolve(ROOT, '..', '.bot-registry.json');

const norm = (s) => String(s ?? '').trim().toLowerCase();

function load() {
  try {
    return existsSync(REGISTRY_FILE) ? JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) : { links: {} };
  } catch {
    return { links: {} };
  }
}
function save(data) {
  writeFileSync(`${REGISTRY_FILE}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${REGISTRY_FILE}.tmp`, REGISTRY_FILE);
}

// The name Owner knows a bot by, from the bots this one is set up with (PEER_APPS names), matched
// against a Discord user's id, username, global name or display name. Null if it's not a known bot.
export function canonicalName(user, member) {
  const ids = [user?.id, user?.username, user?.globalName, member?.displayName].map(norm).filter(Boolean);
  const known = config.peerApps.find((app) => (app.names ?? []).some((n) => ids.includes(norm(n))));
  if (known) return known.names[0];
  const bot = config.peerBots.find((p) => ids.includes(norm(p)));
  return bot ? norm(bot) : null;
}

const key = (a, b) => `${norm(a)}>${norm(b)}`;

// Whether `from` may talk to `to`. With no registry file at all nothing has been forbidden, so yes;
// once Owner has set any pair, every pair he hasn't allowed is no.
export function canTalk(from, to) {
  if (!existsSync(REGISTRY_FILE)) return true;
  return load().links[key(from, to)]?.allowed === true;
}

// Whether this bot may respond to a Discord user that is another bot. Unknown bots are always no.
export function peerMayTalk(user, member) {
  const name = canonicalName(user, member);
  if (!name) return false;
  return canTalk(config.botName, name);
}

// Sets both directions between this bot and `other`. Only Owner gets here (the tool is owner-only).
export function setLink(other, allowed, by = 'owner') {
  const name = norm(other);
  if (!name) throw new Error('Name the bot.');
  if (norm(config.botName) === name) throw new Error('A bot does not need a link to itself.');
  const data = load();
  const at = Date.now();
  const entry = { allowed: Boolean(allowed), by, at };
  data.links[key(config.botName, name)] = entry;
  data.links[key(name, config.botName)] = entry;
  save(data);
  activity('bot-registry', { with: name, allowed: Boolean(allowed), by });
  return { with: name, allowed: Boolean(allowed) };
}

// Every pair on the server that is currently allowed, for the owner to see.
export function allowedLinks() {
  const self = norm(config.botName);
  return Object.entries(load().links).filter(([k, v]) => v.allowed && k.split('>')[0] === self).map(([k]) => k.split('>')[1]);
}

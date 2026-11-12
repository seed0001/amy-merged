import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../..', import.meta.url));
const readEnv = file => { try { return parseEnv(readFileSync(file, 'utf8')); } catch { return {}; } };
const normalize = value => String(value || '').trim().toLowerCase();
export function peerConfiguration() {
  const reference = readEnv(path.join(root, 'new champ', '.env'));
  const specifications = [
    ['Amy', ['Amy', 'New Champ', 'newchamp'], 'new champ', 3000],
    ['Alex', ['Alex'], 'Alex', 3001],
    ['Gramps', ['Gramps', 'Howard', 'Grandpa'], 'Gramps', 3002],
    ['Nova', ['Nova'], 'Nova', 3003],
  ];
  return {
    ownerIds: String(process.env.OWNER_IDS || reference.OWNER_IDS || '').split(',').map(v => v.trim()).filter(Boolean),
    apps: specifications.map(([name, names, folder, port]) => {
      const dir = path.join(root, folder), env = readEnv(path.join(dir, '.env'));
      let id = '';
      try { id = Buffer.from(String(env.DISCORD_TOKEN || '').split('.')[0], 'base64').toString('utf8'); } catch {}
      return { name, names, dir, port: Number(env.DASHBOARD_PORT || port), id: /^\d+$/.test(id) ? id : '' };
    }),
  };
}
export function findPeer(apps, name) {
  return apps.find(app => app.names.some(alias => normalize(alias) === normalize(name)));
}
export function peerMention(apps, name, text) {
  const peer = findPeer(apps, name);
  if (!peer?.id) throw new Error('Unknown Discord companion');
  if (!String(text || '').trim()) throw new Error('No message provided');
  return { content: `<@${peer.id}> ${text}`, allowedMentions: { users: [peer.id], roles: [], repliedUser: false } };
}
export async function bringPeer(app, marker, { fetchImpl = fetch, spawnImpl = spawn, ownEnv = process.env } = {}) {
  let running = false;
  try { running = (await fetchImpl(`http://127.0.0.1:${app.port}/api/settings`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  if (running) {
    if (!marker.voiceChannelId) return `${app.name} is already running.`;
    const response = await fetchImpl(`http://127.0.0.1:${app.port}/api/voice/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: marker.voiceChannelId }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`${app.name}'s voice join failed (${response.status})`);
    return `${app.name} is joining this voice channel.`;
  }
  const launcher = path.join(app.dir, 'start.bat');
  if (!existsSync(launcher)) throw new Error(`No start.bat found for ${app.name}`);
  if (marker.guildId) {
    mkdirSync(path.join(app.dir, 'data'), { recursive: true });
    writeFileSync(path.join(app.dir, 'data', 'restart.json'), JSON.stringify({ at: Date.now(), reason: '', doctor: null, ...marker }));
  }
  const env = { ...ownEnv };
  for (const key of Object.keys(readEnv(path.join(root, 'Amy', '.env')))) delete env[key];
  delete env.CHAMP_SUPERVISED;
  const child = spawnImpl('cmd.exe', ['/d', '/s', '/c', `""${launcher}""`], { cwd: app.dir, windowsHide: true, windowsVerbatimArguments: true, detached: true, stdio: 'ignore', env });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref?.();
  return `Started ${app.name}'s program. Discord connection is pending startup.`;
}

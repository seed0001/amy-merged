import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePeerApps, findPeerApp, bringPeer, cleanEnv } from './peer-apps.js';

test('PEER_APPS lists each bot with its names, folder and port', () => {
  const apps = parsePeerApps('Alex=C:\\Desktop\\Alex@3001, Howard|Gramps|Grandpa=C:\\Desktop\\Gramps@3002, junk');
  assert.deepEqual(apps, [
    { name: 'Alex', names: ['Alex'], dir: 'C:\\Desktop\\Alex', port: 3001 },
    { name: 'Howard', names: ['Howard', 'Gramps', 'Grandpa'], dir: 'C:\\Desktop\\Gramps', port: 3002 },
  ]);
  assert.equal(findPeerApp(apps, 'grandpa').name, 'Howard');
  assert.equal(findPeerApp(apps, 'Zed'), null);
});

test('other bots in the bots folder with a start file are found by folder name or the name they go by, skipping our own', async () => {
  const { folderBots, findFolderBot } = await import('./peer-apps.js');
  const bots = mkdtempSync(path.join(tmpdir(), 'bots-'));
  for (const d of ['HalMini', 'new champ', 'NoStart', 'Other']) mkdirSync(path.join(bots, d));
  writeFileSync(path.join(bots, 'HalMini', 'start_halmini.bat'), '');
  writeFileSync(path.join(bots, 'new champ', 'start.bat'), '');
  writeFileSync(path.join(bots, 'Other', 'start.bat'), '');
  writeFileSync(path.join(bots, 'Other', 'start_old.bat'), '');
  const found = folderBots(bots, { skip: [path.join(bots, 'new champ')] });
  assert.deepEqual(found.map((b) => [b.name, b.bat]), [['HalMini', 'start_halmini.bat'], ['Other', 'start.bat']]);
  for (const name of ['HalMini', 'hal mini', 'Mini Hal', 'adam', 'Adam.']) assert.equal(findFolderBot(found, name)?.dir, path.join(bots, 'HalMini'), name);
  assert.equal(findFolderBot(found, 'Zed'), null);
  assert.equal(findFolderBot(found, ''), null);
});

test("a folder bot is started with its own start file, and no note is left in its folder", async () => {
  const { start } = await import('./peer-apps.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-'));
  writeFileSync(path.join(dir, 'start_halmini.bat'), '');
  const spawned = [];
  start({ name: 'HalMini', names: ['HalMini', 'Adam'], dir, port: null, bat: 'start_halmini.bat' }, null, { spawnImpl: (cmd, args) => { spawned.push(args[1]); return { unref() {} }; }, env: {} });
  assert.equal(spawned[0], `start "HalMini" /D "${dir}" "${path.join(dir, 'start_halmini.bat')}"`);
  assert.equal(existsSync(path.join(dir, 'data')), false);
});

test('a folder bot is called into the call with !join until it turns up, and the !join messages are cleaned up', async () => {
  const { callIntoVoice, isFolderBotMember } = await import('./peer-apps.js');
  const members = new Map([['amy', { id: 'amy', user: { bot: true } }], ['owner', { id: 'owner', user: { bot: false } }]]);
  const sent = [];
  const textChannel = { send: async (text) => { const m = { text, deleted: false, delete: async () => { m.deleted = true; } }; sent.push(m); return m; } };
  let ticks = 0;
  const adam = { id: 'adam', displayName: 'Adam', user: { bot: true, username: 'HalMini' } };
  const sleep = async () => { if (++ticks === 25) members.set('adam', adam); };
  const arrived = await callIntoVoice({ textChannel, voiceChannel: { members }, tries: 5, every: 20000, sleep });
  assert.equal(arrived, adam);
  assert.deepEqual(sent.map((m) => [m.text, m.deleted]), [['!join', true], ['!join', true]]);
  assert.equal(isFolderBotMember({ names: ['HalMini', 'Adam'] }, adam), true);
  assert.equal(isFolderBotMember({ names: ['HalMini', 'Adam'] }, { displayName: 'Adam', user: { bot: false, username: 'adam' } }), false);
  members.delete('adam');
  assert.equal(await callIntoVoice({ textChannel, voiceChannel: { members }, tries: 2, every: 3000, sleep: async () => {} }), null);
});

const where = { guildId: 'g1', voiceChannelId: 'v1', textChannelId: 't1', by: { id: 'u1', name: 'Owner' }, startedBy: 'Amy' };

test('a bot that is not running gets a note for where to join, then its start.bat is run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-'));
  writeFileSync(path.join(dir, 'start.bat'), '');
  const spawned = [];
  const result = await bringPeer({ name: 'Alex', names: ['Alex'], dir, port: 1 }, where, {
    fetchImpl: async () => { throw new Error('not running'); },
    spawnImpl: (cmd, args) => { spawned.push([cmd, args]); return { unref() {} }; },
    now: () => 42,
  });
  assert.match(result, /Started Alex/);
  const note = JSON.parse(readFileSync(path.join(dir, 'data', 'restart.json'), 'utf8'));
  assert.equal(note.at, 42);
  assert.equal(note.voiceChannelId, 'v1');
  assert.equal(note.startedBy, 'Amy');
  assert.equal(spawned[0][0], 'cmd.exe');
  assert.equal(spawned[0][1][1], `start "Alex" /D "${dir}" "${path.join(dir, 'start.bat')}"`);
});

test('a bot that is already running is asked to join the call instead of started again', async () => {
  const calls = [];
  const result = await bringPeer({ name: 'Alex', names: ['Alex'], dir: 'nowhere', port: 3001 }, where, {
    fetchImpl: async (url, opts) => { calls.push([url, opts?.body]); return { ok: true, json: async () => ({}) }; },
    spawnImpl: () => { throw new Error('must not start a second copy'); },
  });
  assert.match(result, /already running and is joining/);
  assert.deepEqual(calls[1], ['http://127.0.0.1:3001/api/voice/join', JSON.stringify({ channelId: 'v1' })]);
});

test('a missing start.bat is reported, not silently ignored', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-'));
  await assert.rejects(bringPeer({ name: 'Alex', names: ['Alex'], dir, port: 1 }, where, { fetchImpl: async () => { throw new Error('down'); } }), /start\.bat isn't/);
  assert.equal(existsSync(path.join(dir, 'data', 'restart.json')), false);
});

test('the started bot gets none of our .env settings, only the shared system environment', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-'));
  writeFileSync(path.join(dir, '.env'), 'BOT_NAME=Amy\nCLIENT_ID=123\nPEER_BOTS=Alex\n');
  const env = cleanEnv({ BOT_NAME: 'Amy', CLIENT_ID: '123', PEER_BOTS: 'Alex', CHAMP_SUPERVISED: '1', PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\user' }, path.join(dir, '.env'));
  assert.deepEqual(env, { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\user' });
  writeFileSync(path.join(dir, 'start.bat'), '');
  let opts;
  await bringPeer({ name: 'Alex', names: ['Alex'], dir, port: 1 }, where, {
    fetchImpl: async () => { throw new Error('down'); },
    spawnImpl: (cmd, args, o) => { opts = o; return { unref() {} }; },
    env,
  });
  assert.equal(opts.env, env);
});

test('a running peer has a setting changed through its dashboard, with only that setting sent', async () => {
  let call;
  const { setPeerSettings } = await import('./peer-apps.js');
  await setPeerSettings({ name: 'Alex', port: 3001 }, { voiceFreeTalk: false }, { fetchImpl: async (url, opts) => { call = [url, opts.method, opts.body]; return { ok: true }; } });
  assert.deepEqual(call, ['http://127.0.0.1:3001/api/settings', 'PUT', '{"voiceFreeTalk":false}']);
});

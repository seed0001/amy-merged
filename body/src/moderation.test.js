import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { runTool } from './tools.js';

const person = (id, username, extra = {}) => ({
  id,
  displayName: username,
  user: { username, globalName: null },
  bannable: true,
  ban: async () => { person.banned.push(username); },
  ...extra,
});
person.banned = [];

function server(names, guildName = '📡  the server  📡') {
  const everyone = new Collection(names.map((n, i) => [String(i + 1), person(String(i + 1), n)]));
  const me = { id: 'me', permissions: { has: () => true }, roles: { highest: { position: 10 } } };
  return {
    id: 'guild',
    name: guildName,
    ownerId: 'owner',
    members: { me, cache: everyone, fetch: async () => everyone },
    roles: { cache: new Collection() },
    channels: { cache: new Collection() },
  };
}
const ctx = (guild) => ({ guild, perms: { owner: true }, speaker: { name: 'Owner' }, conversation: 'test' });
const ban = (user, guild) => runTool('moderate', { action: 'ban', user, reason: 'test' }, ctx(guild));

test('a missed name is not reported as an outage because of the server name', async () => {
  const result = await ban('nobody-here', server(['friend_11']));
  assert.match(result, /^\[moderate: error not_found\]/);
  assert.doesNotMatch(result, /outside service/);
});

test('member names that look like faults do not change the classification', async () => {
  const result = await ban('network', server(['networkk', 'timeout tony'], 'Timeout Lounge'));
  assert.doesNotMatch(result, /error unavailable/);
});

test('a misspelled name suggests the real member and bans nobody', async () => {
  person.banned.length = 0;
  const result = await ban('Lanmoa', server(['friend_11', 'friend_18', 'friend_3']));
  assert.match(result, /Closest names: friend_11\./);
  assert.doesNotMatch(result, /friend_18|friend_3/);
  assert.deepEqual(person.banned, []);
});

test('a word that is nobody\'s name suggests no one', async () => {
  const result = await ban('asshole', server(['friend_11', 'friend_18', 'friend_3']));
  assert.doesNotMatch(result, /Closest names/);
});

test('an exact name still bans immediately', async () => {
  person.banned.length = 0;
  const result = await ban('friend_11', server(['friend_11']));
  assert.match(result, /^\[moderate: ok\]\nBanned friend_11\./);
  assert.deepEqual(person.banned, ['friend_11']);
});

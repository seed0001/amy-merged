import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { look } from './home.js';

const coll = (items) => { const m = new Map(items.map((x, i) => [x.id ?? String(i), x])); m.filter = (fn) => coll([...m.values()].filter(fn)); m.map = (fn) => [...m.values()].map(fn); return m; };

test('she learns her home by looking: owner, size, channels and what they are for, roles; each line tagged as what she saw', () => {
  const guild = {
    name: 'The Back Channel', memberCount: 59, createdAt: new Date('2026-01-02'), description: null, ownerId: 'o1',
    members: { cache: coll([{ id: 'o1', displayName: 'Owner', user: { bot: false } }, { id: 'b1', displayName: 'Amy', user: { bot: true } }]) },
    channels: { cache: coll([{ id: 'c1', name: 'general', type: ChannelType.GuildText, topic: 'hang out' }, { id: 'c2', name: 'General', type: ChannelType.GuildVoice }]) },
    roles: { cache: coll([{ name: '@everyone', managed: false }, { name: 'Mods', managed: false }]) },
  };
  const { lines, summary } = look({ user: { username: 'Amy' }, guilds: { cache: coll([guild]) } });
  assert.ok(lines.every((l) => l.startsWith('What Amy saw on the server herself (')), 'tagged with where it came from');
  assert.ok(lines.some((l) => /Owner owns The Back Channel/.test(l)));
  assert.ok(lines.some((l) => /#general on The Back Channel is described as: hang out/.test(l)));
  assert.ok(lines.some((l) => /roles: Mods/.test(l)) && !lines.some((l) => /@everyone/.test(l)));
  assert.match(summary[0], /owned by Owner.*about 59 members \(1 people she can see\).*#general.*General/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, toolFailed } from './tools.js';
import { sleep } from './sleep.js';
import * as ignoring from './ignoring.js';
import * as pressure from './pressure.js';

// Owner, 2026-11-09: "I should be able to say in text, hey, come join us in voice, and she chooses to join voice
// based on her internal state." She had no tool for it, so she said "I'm in" and wasn't.

const speaker = { id: 'u1', name: 'Owner' };
const guild = (voiceChannel) => ({ id: 'g1', members: { cache: new Map([['u1', { voice: { channel: voiceChannel } }]]), fetch: async () => null } });
const ctx = (voiceChannel) => ({ perms: { owner: true, files: true }, speaker, userText: 'come join us in voice', turn: '1', conversation: 'text:c1', guild: guild(voiceChannel), channel: { id: 'c1', name: 'general' } });

test('it says why when the person asking is not in a call', async () => {
  pressure.state.reserve = 5;
  const out = await runTool('join_voice', {}, ctx(null));
  assert.ok(toolFailed(out), out);
  assert.match(out, /isn't in a voice channel/);
});

test('her state decides: too low on energy, she does not come, and says so', async () => {
  pressure.state.reserve = 0;
  const out = await runTool('join_voice', {}, ctx({ id: 'v1', name: 'Morning Vibes', guild: { id: 'g1' } }));
  assert.ok(toolFailed(out), out);
  assert.match(out, /energy/i);
});

test('her state decides: someone she is ignoring does not get her into a call', async () => {
  pressure.state.reserve = 5;
  ignoring.ignore({ id: 'u1', name: 'Owner' }, 'test');
  try {
    const out = await runTool('join_voice', {}, ctx({ id: 'v1', name: 'Morning Vibes', guild: { id: 'g1' } }));
    assert.ok(toolFailed(out), out);
    assert.match(out, /ignoring/);
  } finally { ignoring.unignore({ id: 'u1', name: 'Owner' }); }
});

test('it is offered in text, not while she is already in a voice turn', async () => {
  const { TOOLS } = await import('./tools.js');
  assert.ok(TOOLS.join_voice.enabled(ctx(null)));
  assert.equal(TOOLS.join_voice.enabled({ ...ctx(null), voice: {} }), false);
  assert.equal(typeof sleep.sleeping, 'function');
});

// Owner, 2026-11-10: he DMed "join us in voice please" and she said she didn't have the tools: a DM has no server,
// so join_voice was never offered there. From a DM she finds the server where he's in voice.
const dm = (voiceChannel) => {
  const g = { ...guild(voiceChannel), voiceStates: { cache: new Map(voiceChannel ? [['u1', { channelId: voiceChannel.id }]] : []) } };
  // discord.js keeps guilds in a Collection: a Map with find().
  const cache = Object.assign(new Map([['g1', g]]), { find(fn) { return [...this.values()].find(fn); } });
  return { perms: { owner: true, files: true }, speaker, userText: 'join us in voice please', turn: '2', conversation: 'text:dm1', channel: { id: 'dm1' }, client: { guilds: { cache } } };
};

test('asked by DM: the tool is there, and it finds the call he is in on her server', async () => {
  const { TOOLS } = await import('./tools.js');
  const { config } = await import('./config.js');
  assert.ok(TOOLS.join_voice.enabled(dm(null)), 'offered in a DM');
  pressure.state.reserve = 5;
  const nowhere = await runTool('join_voice', {}, dm(null));
  assert.ok(toolFailed(nowhere), nowhere);
  assert.match(nowhere, /isn't in a voice channel on any server/);
  // Found through the server he's in: the channel rule names his channel, so it was found from the DM.
  const before = config.voice.channelIds;
  config.voice.channelIds = ['some-other-channel'];
  try {
    const out = await runTool('join_voice', {}, dm({ id: 'v1', name: 'Morning Vibes', guild: { id: 'g1' } }));
    assert.ok(toolFailed(out), out);
    assert.match(out, /"Morning Vibes" isn't one of them/);
  } finally { config.voice.channelIds = before; }
});

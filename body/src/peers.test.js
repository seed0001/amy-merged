import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { setSelf, isPeer, calledByName, noteTurn } from './peers.js';

test('every other bot is a peer; people and the bot itself are not', () => {
  setSelf('5');
  assert.ok(isPeer({ id: '1', bot: true, username: 'amy' }));
  assert.ok(isPeer({ id: '9', bot: true, username: 'MusicBot' }));
  assert.ok(!isPeer({ id: '42', bot: false, username: 'Amy' }));
  assert.ok(!isPeer({ id: '5', bot: true, username: 'me' }));
});

test('a peer is answered only when it says his name', () => {
  assert.ok(calledByName('Alex, what do you think?', { names: ['Alex'] }));
  assert.ok(!calledByName('Alexander was here', { names: ['Alex'] }));
  assert.ok(calledByName('anything', { mentioned: true }));
});

test('bot-to-bot runs are not capped unless PEER_MAX_EXCHANGES sets a limit', () => {
  const c = 'text:test';
  for (let i = 0; i < 50; i++) assert.ok(noteTurn(c, true));
  noteTurn(c, false);
  assert.ok(noteTurn(c, true));
});

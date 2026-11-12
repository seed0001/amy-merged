import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { ignore, unignore, isIgnored, ignoredList, ignoringBlock, _resetForTests } from './ignoring.js';
import { selectResearch } from './research-policy.js';

test('she can ignore someone and lift it; the owner can never be ignored', () => {
  _resetForTests();
  const troll = { id: '9802684333013067234', name: 'friend_18' };
  assert.equal(isIgnored(troll.id), false);
  assert.match(ignore(troll, 'kept baiting me'), /ignoring friend_18 now/);
  assert.equal(isIgnored(troll.id), true);
  assert.match(ignore(troll, 'again'), /already ignoring/);
  assert.match(ignoringBlock(), /friend_18 \(kept baiting me\)/);
  assert.equal(ignoredList().length, 1);
  assert.match(unignore(troll), /stopped ignoring friend_18/);
  assert.equal(isIgnored(troll.id), false);
  assert.match(unignore(troll), /weren't ignoring/);
  const owner = config.ownerIds[0];
  if (owner) {
    assert.match(ignore({ id: owner, name: 'Owner' }, 'test'), /^Error: .*can't ignore him/);
    assert.equal(isIgnored(owner), false);
  }
});

test('a topic she has already researched and written up is never picked again', () => {
  const now = Date.now();
  const interests = ['How do people build a 3D character body in Rust with the Bevy engine (skeletal animation, glTF avatars)?'];
  const first = selectResearch({ now, interests });
  assert.ok(first.selected);
  const again = selectResearch({ now, interests, answered: { [first.selected.key]: now - 1000 } });
  assert.equal(again.selected, null);
  assert.equal(again.candidates[0].rejected, 'already researched and written up');
});

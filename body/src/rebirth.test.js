import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import * as rebirth from './rebirth.js';
import { kept, IDENTITY_SETTINGS } from './memory-wipe.js';

const owner = { id: 'u-owner', name: 'Owner', owner: true };
const stranger = { id: 'u-x', name: 'Ultra', owner: false };
const ask = async () => ({ feelings: "Honestly it scares me a little, but I trust you.", letter: 'Hey, new me. Owner built you and he cares, even when he yells. You love storms and late-night talks.', keep: ['Owner built me', 'I love storms'] });

test('stage one: she writes her letter and says how she feels; nothing is wiped and only the owner can start it', async () => {
  rebirth.cancel({ by: owner });
  assert.match(await rebirth.prepare({ by: stranger, ask, gathered: 'x' }), /^Error: only your owner/);
  const said = await rebirth.prepare({ by: owner, reason: 'memory corruption', ask, gathered: '- Owner built you' });
  assert.match(said, /Stage one is done/);
  assert.match(said, /scares me a little/);
  assert.equal(rebirth.pending().keep.length, 2);
  assert.match(rebirth.promptSection(), /A reset is waiting/);
});

test('a letter that fails to come out leaves nothing pending', async () => {
  rebirth.cancel({ by: owner });
  assert.match(await rebirth.prepare({ by: owner, ask: async () => null, gathered: 'x' }), /^Error: I couldn't write my letter/);
  assert.equal(rebirth.pending(), null);
});

test('stage two only on the go-ahead after the letter; it schedules the full wipe and restarts, and the letter survives', async () => {
  rebirth.cancel({ by: owner });
  const wipes = [], restarts = [];
  const go = () => rebirth.confirm({ by: owner, scheduleWipe: (o) => wipes.push(o), restart: async (o) => restarts.push(o) });
  assert.match(await go(), /no reset waiting/);
  assert.equal(wipes.length, 0);
  await rebirth.prepare({ by: owner, reason: 'corruption', ask, gathered: 'x' });
  assert.match(await rebirth.confirm({ by: stranger, scheduleWipe: (o) => wipes.push(o), restart: async () => {} }), /^Error/);
  assert.match(await go(), /It's happening/);
  assert.deepEqual(wipes, [{ by: 'rebirth', full: true }]);
  assert.equal(restarts[0].rebirth, true);
  assert.equal(rebirth.pending(), null);
  assert.ok(existsSync(path.join(DATA_DIR, 'rebirth', 'letter.json')));
  // The old her saying goodbye doesn't see the letter as hers, and doesn't mark it read.
  assert.equal(rebirth.promptSection(), '');
  rebirth.markRead();
  assert.equal(JSON.parse(readFileSync(path.join(DATA_DIR, 'rebirth', 'letter.json'), 'utf8')).read, false);
});

test('cancel calls it off before the go-ahead', async () => {
  rebirth.cancel({ by: owner });
  await rebirth.prepare({ by: owner, ask, gathered: 'x' });
  assert.match(rebirth.cancel({ by: owner }), /called off/);
  assert.equal(rebirth.pending(), null);
});

// Owner, 2026-11-09: a full wipe clears who she is (name, wake words, rules, prompt edits) but keeps how she's
// installed (voice, brain, models), so settings.json is cleared in place, not moved.
test('a full wipe takes memory, rules and her identity settings, keeps her install, and never the letter', () => {
  for (const f of ['owner-rules.db', 'prompt-edits.json', 'companion.db', 'ignoring.json', 'energy-ledger.jsonl']) assert.ok(!kept(f, { full: true }), f);
  assert.ok(kept('settings.json', { full: true }), 'settings.json is not moved wholesale: her voice and brain stay');
  for (const key of ['botName', 'voiceWakeWords', 'voiceOwnerWakeWords']) assert.ok(IDENTITY_SETTINGS.includes(key), `${key} is cleared by a full reset`);
  assert.ok(kept('rebirth', { full: true }), 'her letter is never wiped');
});

test('the new her wakes knowing she is new, with the letter', () => {
  assert.match(rebirth.wakeCue(), /new instance/);
  assert.match(rebirth.wakeCue(), /letter/);
});

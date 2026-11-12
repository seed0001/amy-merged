import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduleWipe, runPendingWipe } from './memory-wipe.js';

// A memory wipe clears her memory and leaves what the owner set up. A full reset clears that too.
function dataWith(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wipe-'));
  for (const name of files) writeFileSync(path.join(dir, name), '{}');
  return dir;
}

test('a memory wipe moves her memory and leaves the owner rules and settings in place', () => {
  const dir = dataWith(['companion.db', 'owner-rules.db', 'settings.json']);
  scheduleWipe({ dataDir: dir });
  const result = runPendingWipe({ dataDir: dir });
  assert.ok(result.moved.includes('companion.db'));
  assert.ok(!result.moved.includes('owner-rules.db'));
  assert.ok(existsSync(path.join(dir, 'owner-rules.db')));
  assert.ok(existsSync(path.join(dir, 'settings.json')));
});

// Owner, 2026-11-09: a full reset clears who she is (name, wake words, rules, prompt edits), not how she's
// installed (voice, brain, models): settings.json stays, with a copy in the backup.
test('a full reset also moves the owner rules and prompt edits, and clears her identity settings but keeps her install', () => {
  const dir = dataWith(['companion.db', 'owner-rules.db', 'prompt-edits.json']);
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ botName: 'Amy', voiceWakeWords: ['amy'], fishVoiceId: 'voice-1', brain: 'openrouter' }));
  scheduleWipe({ dataDir: dir, full: true });
  const result = runPendingWipe({ dataDir: dir });
  for (const name of ['companion.db', 'owner-rules.db', 'prompt-edits.json']) {
    assert.ok(result.moved.includes(name), `${name} moved`);
    assert.ok(!existsSync(path.join(dir, name)), `${name} is no longer in place`);
  }
  assert.ok(existsSync(path.join(dir, 'settings.json')), 'settings.json stays in place');
  assert.ok(existsSync(path.join(result.backup, 'settings.json')), 'the old settings are copied into the backup');
  assert.ok(result.moved.some((m) => m.startsWith('settings.json')), 'the report says what happened to the settings');
  const after = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(after.botName, undefined, 'her name is cleared');
  assert.deepEqual(after.voiceWakeWords, [], 'wake words back to none');
  assert.deepEqual(after.voiceOwnerWakeWords, []);
  assert.equal(after.fishVoiceId, 'voice-1', 'her voice is kept');
  assert.equal(after.brain, 'openrouter', 'her brain is kept');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { scheduleWipe, wipePending, runPendingWipe } from './memory-wipe.js';

function dataDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'champ-wipe-'));
  const db = new DatabaseSync(path.join(dir, 'companion.db'));
  db.exec('CREATE TABLE memories(x); INSERT INTO memories VALUES (1)');
  db.close();
  mkdirSync(path.join(dir, 'journal'));
  writeFileSync(path.join(dir, 'journal', 'today.md'), 'x');
  for (const f of ['context.jsonl', 'dreams', 'settings.json', 'owner-rules.db', 'prompt-edits.json', 'restart.json']) writeFileSync(path.join(dir, f), 'x');
  return dir;
}

test('nothing is wiped unless the dashboard asked for it', () => {
  const dir = dataDir();
  assert.equal(runPendingWipe({ dataDir: dir }), null);
  assert.ok(existsSync(path.join(dir, 'companion.db')));
});

test('a wipe moves all her memory to a backup and keeps settings, rules and where she was', () => {
  const dir = dataDir();
  scheduleWipe({ dataDir: dir });
  assert.equal(wipePending({ dataDir: dir }), true);
  const result = runPendingWipe({ dataDir: dir });
  assert.deepEqual(result.moved.sort(), ['companion.db', 'context.jsonl', 'dreams', 'journal']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(readdirSync(dir).sort(), ['backups', 'owner-rules.db', 'prompt-edits.json', 'restart.json', 'settings.json']);
  assert.deepEqual(readdirSync(result.backup).sort(), ['companion.db', 'context.jsonl', 'dreams', 'journal']);
  assert.equal(wipePending({ dataDir: dir }), false, 'it runs once, not on every start');
  assert.equal(runPendingWipe({ dataDir: dir }), null);
});

// Owner, 2026-11-11: a full reset left her voiceprints behind, because the wipe only moved a fixed list of files.
// Now everything in data/ goes unless it's on the keep list, so a file no one thought to list is cleared too.
test('a wipe clears voiceprints and any file not on the keep list, and keeps her install, what she made and her letter', () => {
  const dir = dataDir();
  for (const f of ['voiceprints.json', 'salience.json', 'phone-chat.jsonl', 'inner-prompts.json', 'a-file-from-a-new-feature.json']) writeFileSync(path.join(dir, f), 'x');
  for (const d of ['voices', 'files', 'rebirth', 'rocketbox_female_adult_04', 'avatars']) mkdirSync(path.join(dir, d));
  writeFileSync(path.join(dir, 'avatars', 'library.json'), 'x');
  writeFileSync(path.join(dir, 'avatars', 'her-model.glb'), 'x');
  for (const f of ['spend.jsonl', 'work-done.jsonl', 'taste.json', 'life.json']) writeFileSync(path.join(dir, f), 'x');
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ brain: 'openrouter' }));
  scheduleWipe({ dataDir: dir, full: true });
  const result = runPendingWipe({ dataDir: dir, rootDir: null });
  for (const f of ['voiceprints.json', 'salience.json', 'phone-chat.jsonl', 'inner-prompts.json', 'a-file-from-a-new-feature.json', 'companion.db', 'owner-rules.db', path.join('avatars', 'library.json')]) {
    assert.ok(!existsSync(path.join(dir, f)), `${f} is cleared`);
    assert.ok(existsSync(path.join(result.backup, f)), `${f} is in the backup`);
  }
  for (const f of ['voices', 'files', 'rebirth', 'rocketbox_female_adult_04', path.join('avatars', 'her-model.glb'), 'spend.jsonl', 'work-done.jsonl', 'taste.json', 'life.json', 'settings.json', 'restart.json']) {
    assert.ok(existsSync(path.join(dir, f)), `${f} is kept`);
  }
  assert.deepEqual(result.failed, []);
});

// Owner, 2026-11-09: a full reset clears her persona too, so the new user sets up how she acts and talks.
test('a full reset moves the persona into the backup; a normal wipe leaves it alone', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'champ-root-'));
  writeFileSync(path.join(root, 'persona.md'), 'You are flirty.');
  let cleared = false;
  const dir = dataDir();
  scheduleWipe({ dataDir: dir });
  runPendingWipe({ dataDir: dir, rootDir: root, onPersonaCleared: () => { cleared = true; } });
  assert.ok(existsSync(path.join(root, 'persona.md')), 'a normal wipe keeps the persona');
  assert.equal(cleared, false);
  const full = dataDir();
  scheduleWipe({ dataDir: full, full: true });
  const result = runPendingWipe({ dataDir: full, rootDir: root, onPersonaCleared: () => { cleared = true; } });
  assert.ok(!existsSync(path.join(root, 'persona.md')), 'the full reset moved it');
  assert.ok(existsSync(path.join(result.backup, 'persona.md')), 'into the backup');
  assert.ok(result.moved.includes('persona.md'));
  assert.equal(cleared, true, 'the running copy is cleared too');
});

// The first start after a full reset reads config before the wipe moves anything: it must already start from zero.
test('with a full reset waiting, config starts with no persona, name or wake words, but keeps her voice', () => {
  const dir = dataDir();
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ voiceWakeWords: ['amy'], voiceOwnerWakeWords: ['babe'], botName: 'Old Name', fishVoiceId: 'her-voice' }));
  scheduleWipe({ dataDir: dir, full: true });
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { config } = await import(${JSON.stringify(new URL('./config.js', import.meta.url).href)}); console.log(JSON.stringify({ persona: config.persona, words: config.voice.wakeWords, owner: config.voice.ownerWakeWords, name: config.botName, voice: config.fish.voiceId }));`],
    { env: { ...process.env, CHAMP_DATA_DIR: dir, VOICE_WAKE_WORD: 'hey you', VOICE_OWNER_WAKE_WORDS: 'boss' }, encoding: 'utf8' });
  const seen = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(seen.persona, '');
  assert.deepEqual(seen.words, [], 'not from the old settings, not from .env');
  assert.deepEqual(seen.owner, []);
  assert.notEqual(seen.name, 'Old Name', 'her old name is not applied');
  assert.equal(seen.voice, 'her-voice', 'her voice is kept');
});

// Owner, 2026-11-09: a full reset takes her wake words back to none, and they stay none (not refilled from .env).
test('a full reset moves the old settings aside and leaves wake words saved as empty; a normal wipe keeps them', () => {
  const words = { voiceWakeWords: ['amy'], voiceOwnerWakeWords: ['babe'], voiceFreeTalk: false, botName: 'Amy', fishVoiceId: 'her-voice', brain: 'openrouter' };
  const normal = dataDir();
  writeFileSync(path.join(normal, 'settings.json'), JSON.stringify(words));
  scheduleWipe({ dataDir: normal });
  runPendingWipe({ dataDir: normal, rootDir: null });
  assert.deepEqual(JSON.parse(readFileSync(path.join(normal, 'settings.json'), 'utf8')), words, 'a normal wipe keeps the wake words');
  const full = dataDir();
  writeFileSync(path.join(full, 'settings.json'), JSON.stringify(words));
  scheduleWipe({ dataDir: full, full: true });
  const result = runPendingWipe({ dataDir: full, rootDir: null });
  assert.deepEqual(JSON.parse(readFileSync(path.join(result.backup, 'settings.json'), 'utf8')), words, 'the old settings are in the backup');
  // Her name and wake words go; her voice, brain and the rest of how she's installed stay (her voice changed when they didn't).
  assert.deepEqual(JSON.parse(readFileSync(path.join(full, 'settings.json'), 'utf8')), { voiceFreeTalk: false, fishVoiceId: 'her-voice', brain: 'openrouter', voiceWakeWords: [], voiceOwnerWakeWords: [] });
});

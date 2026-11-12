import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { noteFrom, cueFor, workDone, setWorkDoneDelivery, notesLine, recentNotes } from './work-done.js';

// Owner, 2026-11-10: he gives Claude Code work on her and walks away; when it's done it tells her, and she
// tells him. These run that hand-off end to end, including when she's offline at the time.

const PENDING = path.join(DATA_DIR, 'work-done-pending.jsonl');
const note = (title) => noteFrom({ title, summary: 'The voice library finds voices by name now.', not_done: 'Not live until she restarts.', restart_needed: true });

test('a note needs a title and a summary, and says why when one is missing', () => {
  assert.throws(() => noteFrom({ summary: 'x' }), /title is required/);
  assert.throws(() => noteFrom({ title: 'x' }), /summary is required/);
  assert.equal(note('Fix voice IDs').from, 'Claude Code');
});

test('what she is told carries the facts; a DM is asked to stay short', () => {
  const n = note('Fix voice IDs');
  const cue = cueFor(n, { dm: true });
  for (const part of ['Fix voice IDs', 'finds voices by name', 'Not live until she restarts', 'after you restart', 'short sentences']) assert.ok(cue.includes(part), part);
  assert.ok(!cueFor(n).includes('short sentences'), 'in a call she just says it');
});

// 2026-11-10: delivered right after her restart, she still asked him when he'd like her to restart.
test('a note written before this run of her already had its restart', () => {
  const n = { ...note('Fix voice IDs'), at: 1000 };
  assert.match(cueFor(n, { startedAt: 2000 }), /restarted since, so it's live now/);
  assert.match(cueFor({ ...n, at: 3000 }, { startedAt: 2000 }), /offer to restart/);
});

test('offline: the note waits, and goes to Owner the moment she is back, oldest first', async () => {
  rmSync(PENDING, { force: true });
  await setWorkDoneDelivery(null);
  const r = await workDone(note('First job'));
  assert.equal(r.delivered, false);
  assert.match(r.why, /isn't connected/);
  await workDone(note('Second job'));
  assert.equal(readFileSync(PENDING, 'utf8').trim().split('\n').length, 2);
  const told = [];
  await setWorkDoneDelivery(async (n) => { told.push(n.title); return 'dm'; });
  assert.deepEqual(told, ['First job', 'Second job']);
  assert.equal(readFileSync(PENDING, 'utf8').trim(), '', 'nothing left waiting');
});

test('online: told at once; a failed send is kept with the reason and retried later', async () => {
  rmSync(PENDING, { force: true });
  await setWorkDoneDelivery(async () => 'voice');
  assert.deepEqual(await workDone(note('Now')), { delivered: true, via: 'voice' });
  assert.ok(!existsSync(PENDING) || !readFileSync(PENDING, 'utf8').trim());
  await setWorkDoneDelivery(async () => { throw new Error('Discord said no'); });
  const r = await workDone(note('Later'));
  assert.deepEqual([r.delivered, r.why], [false, 'Discord said no']);
  const told = [];
  await setWorkDoneDelivery(async (n) => { told.push(n.title); return 'dm'; });
  assert.deepEqual(told, ['Later']);
  rmSync(PENDING, { force: true });
});

// 2026-11-10: she told him by DM, then in the call he asked "did you get the note from the doctor?" and she
// found nothing, because only the DM conversation had it.
test('the notes she has had are on record for any conversation, under the name he uses', async () => {
  rmSync(path.join(DATA_DIR, 'work-done.jsonl'), { force: true });
  assert.match(notesLine(), /no notes from Claude Code/);
  await setWorkDoneDelivery(async () => 'dm');
  await workDone(note('Fix voice IDs'));
  const line = notesLine();
  assert.match(line, /"Fix voice IDs".*you told Owner by dm.*finds voices by name.*Not done yet: Not live/);
  assert.match(line, /may call it the doctor/);
  assert.equal(recentNotes(1)[0].title, 'Fix voice IDs');
});

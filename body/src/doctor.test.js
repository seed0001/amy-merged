import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { callDoctor, doctorStatus, buildDoctorPrompt, describeWhen, lastVisit, recentReports } from './doctor.js';
import { DATA_DIR } from './config.js';

// A fake doctor process: prints Claude Code's JSON result, then exits. `hold` keeps it running
// until release() is called, to test the "already working" path.
function fakeSpawn({ result = 'All fixed.', code = 0, hold = false } = {}) {
  const calls = [];
  let release = null;
  const spawnImpl = (bin, args) => {
    calls.push({ bin, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('close', 1);
    const end = () => {
      child.stdout.emit('data', JSON.stringify({ result, is_error: false, session_id: 's1' }));
      child.emit('close', code);
    };
    if (hold) release = end; else setImmediate(end);
    return child;
  };
  return { spawnImpl, calls, release: () => release?.() };
}

const noGit = async () => ({ stdout: '' }); // nothing committed, nothing changed
const candidates = [{ kind: 'claude', bin: 'claude-fake' }];
const opts = {}; // opts.onFinished: set per test to await the background finish
const base = () => ({ gitImpl: noGit, candidates, npmTestImpl: async () => ({ ok: true }), onFinished: null });

test("the doctor's task quotes the owner verbatim and labels her paraphrase as untrusted", () => {
  const prompt = buildDoctorPrompt('Investigate why free talk switches off', "No, you're not turning off free talk. It's not switching it off.");
  assert.match(prompt, /^Owner said \(verbatim[^\n]*\):\n"No, you're not turning off free talk\. It's not switching it off\."/);
  assert.match(prompt, /paraphrase[\s\S]*hands model[\s\S]*trust the quote and do NOT trust the paraphrase/);
  assert.ok(prompt.indexOf('Owner said') < prompt.indexOf('Investigate why free talk'));
  // Without the owner's words there's still a warning, not a bare task.
  assert.match(buildDoctorPrompt('Fix the thing properly please'), /hands model, which can get the meaning backwards/);
});

test('an empty or too-short task is an Error and dispatches nothing', async () => {
  const fake = fakeSpawn();
  for (const task of ['', '   ', 'fix it', undefined]) {
    const result = await callDoctor(task, null, { ...base(), spawnImpl: fake.spawnImpl });
    assert.match(result, /^Error: .*at least 15 characters.*Nothing was dispatched/);
  }
  assert.equal(fake.calls.length, 0);
});

test('a successful dispatch says dispatched-not-done, the prompt carries the quote, and the report lands by DM and on disk', async () => {
  const fake = fakeSpawn({ result: 'Fixed the wake-word rule.' });
  const dms = [], notes = [];
  const done = new Promise((resolve) => (opts.onFinished = resolve));
  const result = await callDoctor('Investigate and fix why free talk is switching off when Owner says not to', async (t) => notes.push(t), {
    ...base(), spawnImpl: fake.spawnImpl, ownerText: "you're not turning off free talk", dmImpl: async (t) => dms.push(t), onFinished: (r) => opts.onFinished(r),
  });
  assert.match(result, /^Dispatched, not done: the doctor has started on "Investigate and fix why free talk is switching off when T\.\.\."/);
  assert.match(result, /nothing is fixed yet/);
  assert.equal(fake.calls.length, 1);
  const prompt = fake.calls[0].args[1];
  assert.match(prompt, /Owner said \(verbatim[^\n]*\):\n"you're not turning off free talk"/);
  const outcome = await done;
  assert.equal(outcome.inText, true);
  assert.deepEqual(outcome.delivered, ['notify', 'dm']);
  assert.equal(notes.length, 1);
  assert.equal(dms.length, 1);
  assert.match(dms[0], /^Doctor visit "Investigate and fix[^"]*" done:\nFixed the wake-word rule\.\nNo files were changed\./);
  // The report is the answer to `status` now, with its time, and it is on disk for after a restart.
  const status = doctorStatus();
  assert.match(status, /not working on anything right now\. The last visit, "Investigate and fix[^"]*", finished at \d{1,2}:\d{2}.*, less than a minute ago and went fine \(no files changed\)\. Its report: Fixed the wake-word rule\./);
  assert.equal(lastVisit().ok, true);
  const file = path.join(DATA_DIR, 'doctor-reports.json');
  assert.ok(existsSync(file));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved[0].report, 'Fixed the wake-word rule.');
  assert.equal(recentReports()[0].title, saved[0].title);
});

test('when speech and the DM both fail, the report still goes to the text channel', async () => {
  const fake = fakeSpawn({ result: 'Report that must not be lost.' });
  const posted = [];
  const done = new Promise((resolve) => (opts.onFinished = resolve));
  await callDoctor('Make the report delivery robust against TTS timeouts', async () => { throw new Error('TTS timed out'); }, {
    ...base(), spawnImpl: fake.spawnImpl, dmImpl: async () => { throw new Error('Discord is offline'); },
    deliverText: async (t) => posted.push(t), onFinished: (r) => opts.onFinished(r),
  });
  const outcome = await done;
  assert.equal(outcome.inText, true);
  assert.deepEqual(outcome.delivered, ['notify failed: TTS timed out', 'dm failed: Discord is offline', 'channel']);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /Report that must not be lost\./);
});

test('a second call while the doctor is busy names the running task and since when, and a failure is reported with its time', async () => {
  const fake = fakeSpawn({ result: 'It stopped.', code: 1, hold: true });
  const done = new Promise((resolve) => (opts.onFinished = resolve));
  const started = Date.now() - 3 * 60000; // pretend it began three minutes ago
  let clock = started;
  const first = await callDoctor('Investigate the free talk setting behaviour in voice', null, {
    ...base(), spawnImpl: fake.spawnImpl, dmImpl: async () => {}, now: () => clock, onFinished: (r) => opts.onFinished(r),
  });
  assert.match(first, /^Dispatched, not done/);
  clock = Date.now();
  const second = await callDoctor('Investigate the free talk setting behaviour again', null, { ...base(), spawnImpl: fake.spawnImpl });
  assert.match(second, /^Error: The doctor is already working on "Investigate the free talk setting behaviour in voice" \(started at \d{1,2}:\d{2}[^,]*, 3 minutes ago\) and has not finished yet\. Nothing new was dispatched/);
  assert.match(doctorStatus(), /^The doctor is already working on "Investigate the free talk setting behaviour in voice" \(started at .*3 minutes ago\)/);
  assert.equal(fake.calls.length, 1);
  fake.release();
  await done;
  assert.equal(lastVisit().ok, false);
  assert.match(doctorStatus(), /FAILED \(no files changed\)\. Its report: The doctor stopped early \(exit 1\)\. It stopped\./);
});

test('describeWhen reads as a clock time and an age', () => {
  const now = Date.now();
  assert.match(describeWhen(now - 30000, now), /^\d{1,2}:\d{2}.*, less than a minute ago$/);
  assert.match(describeWhen(now - 60000, now), /, 1 minute ago$/);
  assert.match(describeWhen(now - 12 * 60000, now), /, 12 minutes ago$/);
});

test('an abandoned doctor visit is reported after restart and releases its lock', () => {
  const lock = path.join(DATA_DIR, 'doctor.lock');
  writeFileSync(lock, String(Date.now() - 22 * 60_000));
  assert.match(doctorStatus(), /Interrupted doctor visit.*FAILED.*file changes and tests were not verified/);
  assert.equal(lastVisit().ok, false);
  assert.equal(existsSync(lock), false);
});

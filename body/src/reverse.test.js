import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReverse } from './reverse.js';

// A stand-in for Claude Code: resolves when the test says so, and records what it was asked.
function setup({ ready = () => null, engine = 'claude', ok = true, writeReport = true } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rea-'));
  let finish, asked = null;
  const coder = (args) => { asked = args; return new Promise((r) => { finish = () => { if (writeReport) writeFileSync(path.join(args.cwd, 'report.md'), '# notes'); r({ ok, report: 'It uses a local index.', engine }); }; }); };
  const rev = createReverse({ dir: path.join(tmp, 'jobs'), workRoot: () => path.join(tmp, 'work'), coder, ready });
  return { rev, tmp, done: () => finish(), asked: () => asked };
}
const target = 'https://example.com'; // a URL is checked by the run itself, so no file is needed

test('an investigation runs in the background with REA rules, and its report comes back with where the notes are', async () => {
  const s = setup();
  let told = null;
  const started = s.rev.start({ target, question: 'how does its search work' }, async (t) => { told = t; });
  assert.match(started, /Investigation #1 started/);
  assert.match(s.rev.status(), /#1 "how does its search work"/);
  assert.match(s.asked().rules, /REA/);
  assert.match(s.asked().rules, /Never modify, patch, crack/);
  assert.match(s.asked().prompt, /Target: https:\/\/example\.com/);
  assert.throws(() => s.rev.start({ target, question: 'another' }), /still running; one at a time/);
  s.done();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(told, /#1 "how does its search work" done:\nIt uses a local index\.\nFull notes and evidence: .*report\.md/);
  assert.equal(s.rev.status(), null);
  assert.match(s.rev.report(1), /Investigation #1: done/);
  assert.match(s.rev.list(), /#1 how does its search work/);
});

test('a fallback to another engine is reported as not done with REA', async () => {
  const s = setup({ engine: 'opencode' });
  let told = null;
  s.rev.start({ target, question: 'what is it built with' }, async (t) => { told = t; });
  s.done();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(told, /failed:\nClaude Code couldn't run, so it fell back to opencode, which doesn't have REA/);
});

test('nothing starts without REA, a target, a question, or a real path, and each says why', () => {
  const missing = setup({ ready: () => 'REA isn\'t installed (C:\\Tools\\rea is missing).' });
  assert.throws(() => missing.rev.start({ target, question: 'q' }), /Nothing was started: REA isn't installed/);
  const s = setup();
  assert.throws(() => s.rev.start({ target: '', question: 'q' }), /say what to investigate/);
  assert.throws(() => s.rev.start({ target, question: '' }), /say what .+ wants to know/);
  assert.throws(() => s.rev.start({ target: 'Desktop/definitely-not-here-123/app.exe', question: 'q' }), /doesn't exist/);
  assert.throws(() => s.rev.report(9), /There's no investigation #9/);
  assert.equal(s.rev.cancel(), 'No investigation is running.');
  assert.ok(!existsSync(path.join(s.tmp, 'work')), 'no folder made for a run that never started');
});

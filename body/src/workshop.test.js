import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createWorkshop } from './workshop.js';
import { selfName } from './config.js';
import { keyInfo } from './browser.js';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

function setup(coder) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workshop-'));
  const game = path.join(root, 'game');
  execFileSync('git', ['init', '-q', game]);
  writeFileSync(path.join(game, 'world.js'), 'speed = 1\n');
  git(game, 'add', '-A'); git(game, 'commit', '-q', '-m', 'start');
  const w = createWorkshop({ dir: path.join(root, 'ws'), resolve: (p) => p, coder });
  w.add({ name: 'Lyra', folder: game, run: 'python serve.py', url: 'http://localhost:8123', deploy: 'push to main' });
  return { w, game };
}
const finished = (w, id) => new Promise((resolve) => { const t = setInterval(() => { if (!/running/.test(w.jobs())) { clearInterval(t); resolve(w.report(id)); } }, 20); });

test('a project is saved once and found by any part of its name', async () => {
  const { w, game } = setup();
  assert.match(w.list(), /Lyra/);
  assert.equal(w.project('lyra').path, game);
  assert.throws(() => w.project('nope'), /No project called "nope".*Lyra/);
  assert.match(await w.overview('Lyra'), /Uncommitted changes: none[\s\S]*start/);
});

test('a coding job runs in the project, is saved as one commit, reports back, and can be undone', async () => {
  let told = '', asked;
  const { w, game } = setup(async (job) => {
    asked = job;
    writeFileSync(path.join(game, 'world.js'), 'speed = 2\n');
    return { ok: true, report: 'Doubled the speed in world.js.', engine: 'claude' };
  });
  writeFileSync(path.join(game, 'notes.txt'), "the owner's own unsaved work");
  assert.match(await w.start('lyra', 'Double the flying speed.', async (t) => { told = t; }), /Job #1 on Lyra started/);
  await assert.rejects(w.start('lyra', 'Another one'), /still running/);
  assert.match(await finished(w, 1), /done[\s\S]*Doubled the speed[\s\S]*world\.js/);
  assert.equal(asked.cwd, game);
  assert.match(asked.rules, /Never push, deploy or publish: here that's push to main/);
  assert.match(told, /Lyra job #1 .* done[\s\S]*Saved as a commit, not pushed/);
  // Commits are named after whoever the companion is, never a fixed "Amy" (owner, 2026-11-11).
  assert.match(git(game, 'log', '--format=%s'), new RegExp(`${selfName()}'s job #1[\\s\\S]*Before ${selfName()}'s job`));
  if (selfName() !== 'Amy') assert.doesNotMatch(git(game, 'log', '--format=%s %an'), /Amy/, 'no fixed "Amy" for a companion with another name');

  assert.match(await w.undo('lyra'), /Undid job #1/);
  assert.equal(readFileSync(path.join(game, 'world.js'), 'utf8').trim(), 'speed = 1');
  assert.ok(existsSync(path.join(game, 'notes.txt')), "the owner's own work survives an undo");
});

test('undo refuses when something was committed after the job', async () => {
  const { w, game } = setup(async () => { writeFileSync(path.join(game, 'world.js'), 'speed = 3\n'); return { ok: true, report: 'ok', engine: 'claude' }; });
  await w.start('lyra', 'Triple it.');
  await finished(w, 1);
  writeFileSync(path.join(game, 'other.js'), 'x'); git(game, 'add', '-A'); git(game, 'commit', '-q', '-m', 'by hand');
  await assert.rejects(w.undo('lyra'), /committed after job #1/);
});

test('browser keys map to what a game listens for', () => {
  assert.deepEqual(keyInfo('w'), { code: 'KeyW', key: 'w', vk: 87, text: 'w' });
  assert.equal(keyInfo('shift').code, 'ShiftLeft');
  assert.equal(keyInfo('space').code, 'Space');
  assert.equal(keyInfo('5').code, 'Digit5');
  assert.throws(() => keyInfo('hyperjump'), /Unknown key/);
});

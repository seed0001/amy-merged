import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as git from './git.js';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true });
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitlog-'));
  sh(dir, 'init', '-q');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Tester');
  return dir;
}

test('log shows the history, and says what is not committed yet', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'a.txt'), 'one');
  sh(dir, 'add', 'a.txt'); sh(dir, 'commit', '-q', '-m', 'first thing');
  writeFileSync(path.join(dir, 'b.txt'), 'two');
  const out = await git.log(dir); // a temp folder is off limits to her path guard (AppData), so straight to log
  assert.match(out, /Tester\s+first thing/);
  assert.match(out, /Not in history yet: 1 changed or new file not committed/);
});

test('a repo with no commits says so plainly', async () => {
  const dir = repo();
  await assert.rejects(git.log(dir), /has no commits yet, so it has no history/);
});

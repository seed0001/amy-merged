import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectRuntime } from './project-runtime.js';
import { homeFolder } from './files.js';

const runtime = () => createProjectRuntime({
  run: async () => ({ stdout: 'ok', stderr: '' }),
  receipts: mkdtempSync(path.join(os.tmpdir(), 'receipts-')),
});

test('a script that names another user folder is refused, with the real home folder', async () => {
  const rt = runtime();
  await assert.rejects(
    rt.command('Desktop/guard', 'node', ['--input-type=module', '-e', "import {mkdir} from 'node:fs/promises'; await mkdir('C:/Users/user/Desktop/dashboard',{recursive:true})"]),
    (err) => /user folder "Owner"/.test(err.message) && err.message.includes(homeFolder()),
  );
});

test('a script that uses the owner real home folder runs', async () => {
  const rt = runtime();
  const home = homeFolder();
  const result = await rt.command('Desktop/guard', 'node', ['-e', `console.log(${JSON.stringify(path.join(home, 'Desktop'))})`]);
  assert.equal(result.status, 'succeeded');
});

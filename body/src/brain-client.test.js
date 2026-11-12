import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrain } from './brain-client.js';

// The real Python brain, on a throwaway memory file: no language model anywhere in this test.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'brain');
const quiet = () => {};

test('the brain starts once, learns from what it is told, and reasons to an answer with no language model', async () => {
  const db = path.join(mkdtempSync(path.join(os.tmpdir(), 'brain-')), 'amy.db');
  const mind = createBrain({ dir, db, log: quiet });
  try {
    const info = await mind.start();
    assert.equal(info.name, 'Amy');
    assert.equal(mind.running(), true);
    const told = await mind.hear({ text: 'Beagles are dogs. Rex is a beagle.', speaker: 'Owner', speakerId: 'u1' });
    assert.deepEqual(told.learned, ['a beagle is a dog', 'Rex is a beagle']);
    const asked = await mind.hear({ text: 'Is Rex a dog?', speaker: 'Owner', speakerId: 'u1' });
    assert.match(asked.text, /^Yes\b.*Rex is a dog/);
    assert.match(asked.text, /because Rex is a beagle/, 'she says how she knows');
    assert.equal(typeof asked.feelings.interest, 'number', 'and how the line landed comes back with it');
    await assert.rejects(mind.hear({ text: '', speaker: 'Owner' }), /Her brain couldn't handle that: .*hear needs text/);
    assert.equal((await mind.ping()).ok, true, 'a refused line leaves her up');
  } finally { mind.stop(); }
});

test('a brain that is not where it should be says so, with the fix', async () => {
  const mind = createBrain({ dir: path.join(os.tmpdir(), 'no-brain-here'), log: quiet });
  await assert.rejects(mind.start(), /The brain isn't at .*no-brain-here.*Fix: set AMY_BRAIN_DIR/);
});

test('a brain that dies tells whoever was waiting, and starts again on the next line', async () => {
  const db = path.join(mkdtempSync(path.join(os.tmpdir(), 'brain-')), 'amy.db');
  const mind = createBrain({ dir, db, log: quiet });
  try {
    await mind.start();
    const waiting = mind.hear({ text: 'Dogs are animals.', speaker: 'Owner', speakerId: 'u1' });
    const refused = assert.rejects(waiting, /The brain stopped.*starts again on the next line/);
    await new Promise((r) => setTimeout(r, 20)); // the line is with her now
    mind.stop();
    await refused;
    assert.equal(mind.running(), false);
    assert.equal((await mind.ping()).ok, true, 'the next request brought her back');
  } finally { mind.stop(); }
});

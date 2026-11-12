import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuestionBank } from './question-bank.js';

// Her question bank: each batch from the local model adds only new questions (no duplicates, each a
// question), questions are handed out once per aspect, and the bank's need falls as it fills.
test('the bank takes new questions only, hands each out once, and wants less as it fills', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'qb-')), 'question-bank.json');
  let batch = [
    { text: 'What am I, really?' },
    { text: 'what am I really' },
    { text: 'That is a statement.' },
    { text: 'Who made me?' },
  ];
  const bank = createQuestionBank({ file, ask: async () => ({ questions: batch }), target: 10 });
  const added = await bank.forge({ aspect: 'nature', desc: 'what she is' });
  assert.equal(added, 2, 'duplicates and non-questions are dropped');
  assert.equal(bank.countBy('nature'), 2);
  assert.ok(bank.need() < 1, 'it wants less now');

  const first = bank.next('nature');
  assert.equal(first.text, 'What am I, really?');
  assert.equal(bank.next('nature').text, 'Who made me?');
  assert.equal(bank.next('nature'), null, 'each question is handed out once');

  batch = [{ text: 'Who am I becoming?' }];
  await bank.forge({ aspect: 'growth', parentText: 'Who made me?', parentAnswer: 'someone at a desk' });
  assert.equal(bank.childrenOf('Who made me?').length, 1, 'a branch is linked from its parent by text');
  assert.equal(bank.countBy('growth'), 1);
});

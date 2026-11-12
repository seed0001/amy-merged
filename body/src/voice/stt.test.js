import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseRepeats } from './stt.js';

test('a word or phrase the recognizer got stuck repeating is cut back to 4', () => {
  assert.equal(collapseRepeats('Do ' + 'do '.repeat(400)), 'Do do do do');
  assert.equal(collapseRepeats('Oh, ha ha ha ha ha ha ha ha ha'), 'Oh, ha ha ha ha');
  assert.equal(collapseRepeats('thank you thank you thank you thank you thank you so much'), 'thank you thank you thank you thank you so much');
});

test('normal speech, including a few repeats, is left alone', () => {
  for (const s of ['I said no no no, stop it', 'Amy, what time is it?', 'that that is is fine']) assert.equal(collapseRepeats(s), s);
});

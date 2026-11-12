import test from 'node:test';
import assert from 'node:assert/strict';
import { shortText, DM_MAX } from './short-text.js';

// Owner, 2026-11-09: her DMs were five paragraphs (674 to 2,076 characters). A DM she starts is a short text.
test('a short text goes out as it is', () => {
  assert.deepEqual(shortText('Hey you. Hop in voice when you get a sec?'), { text: 'Hey you. Hop in voice when you get a sec?', trimmed: false });
});

test('a long one ends at the last full sentence that fits', () => {
  const long = 'Evening, Owner. Feels like it has been a while. ' + 'There is a lot I want to walk you through about how my energy works and why. '.repeat(10);
  const out = shortText(long);
  assert.equal(out.trimmed, true);
  assert.ok(out.text.length <= DM_MAX, `${out.text.length} characters`);
  assert.match(out.text, /^Evening, Owner\. Feels like it has been a while\./);
  assert.match(out.text, /[.!?]$/, 'it ends on a whole sentence');
});

test('one endless sentence is cut at a word, with an ellipsis', () => {
  const out = shortText('so '.repeat(300));
  assert.equal(out.trimmed, true);
  assert.ok(out.text.length <= DM_MAX);
  assert.match(out.text, /…$/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBubbleStyle } from './bubble-style.js';

test('bubble size defaults to 1, saves, and tells open pages', () => {
  const emitted = [];
  const style = createBubbleStyle(path.join(mkdtempSync(path.join(os.tmpdir(), 'bubble-')), 'bubble-style.json'), (s) => emitted.push(s));
  assert.equal(style.get().scale, 1);
  style.set(1.5);
  assert.equal(style.get().scale, 1.5);
  assert.deepEqual(emitted, [{ scale: 1.5 }]);
});

test('sizes outside 0.75 to 3 are refused and nothing changes', () => {
  const style = createBubbleStyle(path.join(mkdtempSync(path.join(os.tmpdir(), 'bubble-')), 'bubble-style.json'), () => {});
  style.set(2);
  assert.throws(() => style.set(5), /between 0.75 and 3/);
  assert.throws(() => style.set(0.2), /between 0.75 and 3/);
  assert.throws(() => style.set(Number.NaN), /between 0.75 and 3/);
  assert.equal(style.get().scale, 2);
});

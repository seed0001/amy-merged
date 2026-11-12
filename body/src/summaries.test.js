import test from 'node:test';
import assert from 'node:assert/strict';
import { rollupDue, ROLLUP_TASK, PARAGRAPHS_PER_ROLLUP, ROLLUP_AGE_MS } from './summaries.js';

const now = 1_800_000_000_000;
const paragraphs = (n, age = 0) => Array.from({ length: n }, (_, i) => ({ id: i + 1, created_at: now - age }));

test('paragraphs roll up once a handful pile up, not a whole day of them', () => {
  assert.equal(PARAGRAPHS_PER_ROLLUP, 8);
  assert.equal(rollupDue(paragraphs(PARAGRAPHS_PER_ROLLUP - 1), now), false);
  assert.equal(rollupDue(paragraphs(PARAGRAPHS_PER_ROLLUP), now), true);
  assert.equal(rollupDue(paragraphs(17), now), true); // a backlog is consolidated in one go
});

test('old paragraphs roll up after a day; a single one or none never does', () => {
  assert.equal(rollupDue(paragraphs(2, ROLLUP_AGE_MS), now), true);
  assert.equal(rollupDue(paragraphs(2, ROLLUP_AGE_MS - 1), now), false);
  assert.equal(rollupDue(paragraphs(1, ROLLUP_AGE_MS * 3), now), false);
  assert.equal(rollupDue([], now), false);
});

test('the rollup keeps people, memories, commitments and unresolved work', () => {
  const task = ROLLUP_TASK('Amy');
  for (const heading of ['People:', 'Important memories:', 'Active commitments:', 'Unresolved work:']) {
    assert.ok(task.includes(heading), heading);
  }
  assert.match(task, /Carry forward everything still relevant/);
  assert.match(task, /Don't invent/);
});

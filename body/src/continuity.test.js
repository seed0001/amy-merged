import test from 'node:test';
import assert from 'node:assert/strict';
import { span, downtimeClause, continuityBlock, startContinuity, touch, SHORT_DOWNTIME_MS } from './continuity.js';

test('a length of time is exact when it is short: no more "offline about just now"', () => {
  assert.equal(span(3_000), 'a few seconds');
  assert.equal(span(10_000), '10 seconds');
  assert.equal(span(48_000), '48 seconds');
  assert.equal(span(5 * 60_000), '5 minutes');
  assert.equal(span(3 * 3600_000), '3 hours');
  assert.doesNotMatch(span(10_000), /just now/);
});

test('seconds down is a pause, minutes down is a gap', () => {
  assert.match(downtimeClause(10_000), /only down 10 seconds: a short pause, nothing was missed and no time was lost/);
  assert.match(downtimeClause(SHORT_DOWNTIME_MS - 1), /short pause/);
  assert.match(downtimeClause(SHORT_DOWNTIME_MS), /offline about 2 minutes/);
  assert.match(downtimeClause(40 * 60_000), /offline about 40 minutes/);
});

test('after a quick restart the block says so plainly and does not call it a gap worth noticing', () => {
  startContinuity(); // a fresh test data folder: this start's downtime is 0 (no earlier heartbeat on file)
  const conversation = 'voice:test';
  touch(conversation);
  const block = continuityBlock({ conversation, speakerName: 'Owner', speakerLastSeen: null, convLastActive: Date.now() - 3 * 60_000 - 1 });
  assert.match(block, /before you were restarted \(you were only down a few seconds: a short pause/);
  assert.doesNotMatch(block, /natural to notice the gap/);
  assert.doesNotMatch(block, /just now\)/);
});

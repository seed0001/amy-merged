import test from 'node:test';
import assert from 'node:assert/strict';
import * as away from './away.js';

const owner = { id: 'u1', name: 'Owner' };

// Nothing in away.js reads words. Since 2026-11-11 (owner: "I didn't say I was leaving the call") nobody is marked away
// from what they say: only deafening in the call (bot.js, from Discord) makes someone away. heard() only treats a line
// as the event "they spoke".

test('nobody is marked away from what they say: the old stepping_away and back refuse and record nothing', () => {
  const c = 'voice:t1';
  for (const line of ['stepping_away', 'back']) {
    assert.match(away.note(c, owner, line, 1000), /^Error: nobody is marked away from what they say.*Nothing was recorded/, line);
    assert.ok(!away.isAway(c, owner.id), line);
  }
  assert.equal(away.promptSection(c, owner.id, 5000), '');
  away.cleared(c);
});

test('deafened is away; anything they say next, or undeafening, brings them back', () => {
  const c = 'voice:t8';
  away.markAway(c, owner, 'deafened', 1000);
  assert.ok(away.isAway(c, owner.id));
  assert.ok(away.deafened(c, owner.id));
  assert.match(away.promptSection(c, null, 6 * 60_000), /deafened themselves.*about 6 minutes ago/);
  assert.equal(away.heard(c, owner, 'okay what were we doing', 7 * 60_000), 'back');
  assert.ok(!away.isAway(c, owner.id));
  assert.match(away.promptSection(c, owner.id, 7 * 60_000), /just came back after being away about 7 minutes/);
  assert.equal(away.promptSection(c, owner.id, 8 * 60_000), ''); // read once
  away.cleared(c);
});

test('heard() never reads the words: lines about being back or stepping out change nothing on their own', () => {
  const c = 'voice:t2';
  for (const line of ['be right back', 'brb', 'hold on a sec', "I'm back", 'quiet time']) {
    assert.equal(away.heard(c, owner, line), null, line);
    assert.ok(!away.isAway(c, owner.id), line);
    assert.equal(away.quietTime(c), null, line);
  }
  assert.equal(away.promptSection(c, owner.id), '');
  away.cleared(c);
});

test('quiet time together is neither away nor being ignored, and ends when they talk again', () => {
  const c = 'voice:t4';
  assert.match(away.note(c, owner, 'quiet_time', 0), /Quiet time with Owner/);
  assert.ok(away.quietTime(c, 1000));
  assert.ok(!away.isAway(c, owner.id));
  assert.match(away.promptSection(c, owner.id, 5000), /settle in/);
  assert.match(away.promptSection(c, null, 10 * 60_000), /Quiet time with Owner.*silence is the point/s);
  // Speaking ends it (heard), but the hands reading that same line as "still quiet time" picks it
  // back up with its original start, so it isn't logged as a new quiet time.
  assert.equal(away.heard(c, owner, 'yeah just this, this is nice', 6 * 60_000), null);
  assert.equal(away.quietTime(c, 6 * 60_000), null);
  assert.match(away.note(c, owner, 'quiet_time', 6 * 60_000), /goes on|Quiet time with Owner/);
  assert.equal(away.quietTime(c, 6 * 60_000).since, 0);
  // Deafening during quiet time doesn't end it.
  away.markAway(c, owner, 'deafened', 11 * 60_000);
  assert.ok(away.quietTime(c, 11 * 60_000));
  assert.ok(away.isAway(c, owner.id));
  // Talking again: back from away, and quiet time ends with nothing to re-mark it.
  assert.equal(away.heard(c, owner, 'okay so what do you think about the new hair', 12 * 60_000), 'back');
  assert.equal(away.quietTime(c, 12 * 60_000), null);
  // talking_again when nothing is on says so instead of pretending.
  assert.match(away.note(c, owner, 'talking_again', 13 * 60_000), /no quiet time on/);
  away.cleared(c);
});

test('talking_again ends quiet time; quiet time runs out on its own after two hours', () => {
  const c = 'voice:t6';
  away.note(c, owner, 'quiet_time', 0);
  assert.match(away.note(c, owner, 'talking_again', 20 * 60_000), /over after 20 minutes/);
  assert.equal(away.quietTime(c, 20 * 60_000), null);
  away.note(c, owner, 'quiet_time', 30 * 60_000);
  assert.ok(away.quietTime(c, 30 * 60_000 + 3600_000));
  assert.equal(away.quietTime(c, 30 * 60_000 + 2 * 3600_000 + 1), null);
  away.cleared(c);
});

test('a bad action or a missing person is an error that says what to do, and records nothing', () => {
  const c = 'voice:t7';
  assert.match(away.note(c, owner, 'gone', 0), /^Error: .*quiet_time, talking_again/);
  assert.match(away.note(c, { id: '', name: '' }, 'quiet_time', 0), /^Error: .*who/);
  assert.match(away.note('', owner, 'quiet_time', 0), /^Error: .*no conversation/);
  assert.ok(!away.isAway(c, owner.id));
  away.cleared(c);
});

test('deafened is an away state, and leaving the call clears it', () => {
  const c = 'voice:t3';
  away.markAway(c, owner, 'deafened', 0);
  assert.match(away.promptSection(c, null, 3 * 60_000), /deafened themselves/);
  assert.deepEqual([...away.awayIds(c)], ['u1']);
  away.left(c, owner.id);
  assert.equal(away.promptSection(c, null), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { lastExitEvent, wakeReason, backCue, BACK_ONLINE } from './restart.js';

const ev = (event, extra = {}) => JSON.stringify({ type: 'life-support', time: 1, event, ...extra });

test('how she went down is read from life support\'s record: a crash, an exit, or nothing at all', () => {
  assert.deepEqual(lastExitEvent([ev('starting'), ev('crash', { code: 1, ranMs: 5000 }), ev('starting')]).event, 'crash');
  assert.equal(lastExitEvent([ev('starting'), ev('restart', { code: 0 }), ev('starting')]).event, 'restart');
  assert.equal(lastExitEvent([ev('starting'), ev('starting')]).event, 'closed', 'two starts with no exit between: closed from outside');
  assert.equal(lastExitEvent([ev('starting')]).event, 'closed');
  assert.equal(lastExitEvent(['{"type":"pressure"}', 'not json']), null, 'never supervised');
  // An exit before the previous start belongs to that start, not this one.
  assert.equal(lastExitEvent([ev('crash', { code: 1 }), ev('starting'), ev('starting')]).event, 'closed');
});

test('the reason she is told is true to the record, and never "you woke up"', () => {
  assert.match(wakeReason({ exit: { event: 'crash', code: 1, signal: null, ranMs: 90_000 } }).text, /crashed .*code 1.*life support started it again/);
  assert.match(wakeReason({ exit: { event: 'closed' }, owner: 'Owner' }).text, /closed from outside.*Owner restarting you by hand/);
  assert.match(wakeReason({ marker: { by: { name: 'Owner' }, reason: 'new fix' } }).text, /because Owner asked \(new fix\)/);
  assert.match(wakeReason({ marker: { doctor: { title: 'eyes zoom', report: 'Added a frame.', changed: 'a.js', tests: 'PASS' } } }).text, /doctor visit about "eyes zoom".*Files changed: a\.js.*Tests: PASS/);
  assert.match(wakeReason({ marker: { startedBy: 'Nova' } }).text, /started up by Nova/);
  assert.match(wakeReason({}).text, /nothing on record says why/);
  for (const r of [wakeReason({}), wakeReason({ exit: { event: 'crash', code: 1 } })]) assert.doesNotMatch(r.text, /woke|woken|asleep/);
});

test('the comeback cue tells her how long it really was and what she already said last time', () => {
  const short = backCue({ reason: wakeReason({ exit: { event: 'closed' } }), downtimeMs: 10_000, lastActiveMs: 30_000 });
  assert.match(short, new RegExp(BACK_ONLINE));
  assert.match(short, /only down 10 seconds: a short pause, nothing was missed and no time was lost/);
  assert.match(short, /not sleep/);
  assert.doesNotMatch(short, /quiet for/, 'a 30-second lull before going down is not worth mentioning');
  const long = backCue({ reason: wakeReason({ exit: { event: 'crash', code: 1 } }), downtimeMs: 25 * 60_000, lastActiveMs: 50 * 60_000, previous: ['Mmm, I just woke up foggy.', 'Mmm, I just woke up foggy again.'] });
  assert.match(long, /offline about 25 minutes/);
  assert.match(long, /quiet for 50 minutes before you went down/);
  assert.match(long, /On earlier restarts you said: "Mmm, I just woke up foggy\." \/ "Mmm, I just woke up foggy again\."\. Say something different/);
  assert.doesNotMatch(backCue({ reason: wakeReason({ marker: { startedBy: 'Nova' } }) }), /not sleep/, 'a peer start is a plain hello');
});

test('back from a restart with a done note waiting: one announcement that says both, not two "I\'m back"s', async () => {
  const { announceComeback } = await import('./restart.js');
  const said = [];
  const session = { announce: (cue, evidence, kind) => said.push({ cue, evidence, kind }) };
  announceComeback(session, '(Stage direction: you just restarted. Say you\'re back.)', 'restart evidence');
  assert.ok(session.comeback, 'the comeback is pending for a moment');
  session.comeback.extras.push('Claude Code just finished "Real dancing". Let Owner know it\'s done.');
  session.comeback.evidence.push('Claude Code "Real dancing": done.');
  await new Promise((r) => setTimeout(r, 2700));
  assert.equal(said.length, 1);
  assert.match(said[0].cue, /Say you're back\.[\s\S]*In the same breath[\s\S]*Real dancing[\s\S]*Say you're back only once/);
  assert.match(said[0].evidence, /restart evidence\nClaude Code "Real dancing": done\./);
  assert.equal(session.comeback, null);
});

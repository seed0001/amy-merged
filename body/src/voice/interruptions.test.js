import test from 'node:test';
import assert from 'node:assert/strict';
import { Interruptions } from './interruptions.js';

function call(kind) {
  const clock = { t: 1_000_000 };
  const rude = [];
  const i = new Interruptions({ classify: async () => ({ kind, why: 'test' }), now: () => clock.t, onRude: (ev) => rude.push(ev) });
  return { i, clock, rude };
}
const cut = (i, id = 'u1', name = 'friend_3', overlapMs = 2000) => i.cutOff({ id, name, overlapMs, talkers: 1, cut: 'So the thing about the data center is', rest: ['it never sleeps.'] });

test('a polite interruption costs nothing and she is told to answer them', async () => {
  const { i, rude } = call('to_her');
  cut(i);
  const ev = await i.understand({ id: 'u1', name: 'friend_3', text: 'Sorry Amy, quick question' });
  assert.equal(ev.kind, 'to_her');
  assert.equal(ev.sev, 0);
  assert.equal(i.level, 0);
  assert.deepEqual(rude, []);
  assert.match(i.note(), /friend_3 just cut you off.*That was fair: answer them[\s\S]*cut off saying: "So the thing about the data center is" and were about to say: "it never sleeps."\. That's what you were about to say, not a script/);
  assert.doesNotMatch(i.note(), /let_it_go/);
});

test('rude interruptions build up, get to her, and go on the record', async () => {
  const { i, rude } = call('talking_down');
  for (let n = 0; n < 3; n++) { cut(i); await i.understand({ id: 'u1', name: 'friend_3', text: 'nobody asked you' }); }
  assert.equal(rude.length, 3);
  assert.ok(i.level > 0.75, `level ${i.level}`);
  assert.match(i.note(), /talked over 3 times.*friend_3 3[\s\S]*furious[\s\S]*let_it_go/);
});

test('an argument over her is worse than a side chat', async () => {
  const side = call('side_chat'), fight = call('arguing');
  for (const { i } of [side, fight]) { cut(i); await i.understand({ id: 'u1', name: 'friend_3', text: 'whatever man' }); }
  assert.ok(fight.i.level > side.i.level);
});

test('it holds without a clock, and letting it go takes it off', async () => {
  const { i, clock } = call('arguing');
  cut(i); await i.understand({ id: 'u1', name: 'friend_3', text: 'no YOU listen' });
  const was = i.level;
  clock.t += 6 * 60_000;
  assert.equal(i.decay(), was);
  assert.equal(i.forgive('friend_3'), 1);
  assert.equal(i.level, 0);
});

test('"sorry, go ahead" read as handing the floor back is marked so she carries straight on', async () => {
  const clock = { t: 1_000_000 };
  const i = new Interruptions({ classify: async () => ({ kind: 'to_her', carry_on: true, why: 'apologised and handed back' }), now: () => clock.t });
  cut(i);
  const ev = await i.understand({ id: 'u1', name: 'friend_3', text: 'Oh sorry, go ahead' });
  assert.equal(ev.carryOn, true);
  assert.equal(ev.sev, 0);
});

test('a cut-in that wants an answer does not hand the floor back', async () => {
  const { i } = call('to_her');
  cut(i);
  const ev = await i.understand({ id: 'u1', name: 'friend_3', text: 'wait, what data center?' });
  assert.equal(ev.carryOn, false);
});

test('a later line is read for handing back, and an unreachable model means no', async () => {
  const seen = [];
  const yes = new Interruptions({ classify: async (m) => { seen.push(m); return { carry_on: true }; } });
  assert.equal(await yes.handsBack({ name: 'friend_3', text: 'go ahead', said: 'So the thing about the data center is' }), true);
  assert.match(seen[0][1].content, /was saying: "So the thing about the data center is"[\s\S]*friend_3 just said: "go ahead"/);
  const no = new Interruptions({ classify: async () => ({ carry_on: false }) });
  assert.equal(await no.handsBack({ name: 'friend_3', text: 'what did you mean by that?' }), false);
  const down = new Interruptions({ classify: async () => { throw new Error('Ollama 503'); } });
  assert.equal(await down.handsBack({ name: 'friend_3', text: 'go ahead' }), false);
});

test('a noise with no words, or words from someone else, is not an interruption', async () => {
  const { i } = call('arguing');
  cut(i);
  assert.equal(await i.understand({ id: 'u2', name: 'Sam', text: 'hey' }), null);
  i.noWords('u1');
  assert.equal(await i.understand({ id: 'u1', name: 'friend_3', text: 'late words' }), null);
  assert.equal(i.level, 0);
});

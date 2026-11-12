import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntake, SIGNALS } from './intake.js';

const owner = { id: 'u1', name: 'Owner' };
const tick = () => new Promise((r) => setImmediate(r));

test('a line said to her is read into numbers and handed to pressure with who said it', async () => {
  const got = [];
  const intake = createIntake({ read: async () => ({ praise: 0.9, addressed: 1, humor: 0.2, bogus: 5 }), onSignals: (sig, ctx) => got.push({ sig, ctx }), listening: () => false, name: () => 'Amy' });
  assert.equal(intake.hear({ conversation: 'voice:1', speaker: owner, text: 'Amy, that was really sharp, I love how you handled it.', owner: true, addressed: true }), true);
  await tick(); await tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].sig.praise, 0.9);
  assert.equal(got[0].sig.addressed, 1);
  for (const k of SIGNALS) assert.ok(k in got[0].sig, `every signal present: ${k}`);
  assert.equal('bogus' in got[0].sig, false);
  assert.equal(got[0].ctx.owner, true);
  assert.equal(got[0].ctx.speaker.name, 'Owner');
});

// Nov 10: a reaction to something he'd made carries creation_id "12" (text), which passed the >= 0.3 filter for the
// log line and threw "v.toFixed is not a function": the line never reached his pressure and the reaction was lost.
test('a reaction to something she made, with its id, is read and handed on, not lost to an error', async () => {
  const got = [];
  const errors = [];
  const { bus } = await import('./events.js');
  const onErr = (e) => { if (e?.type === 'error' && e.where === 'intake') errors.push(e.message); };
  bus.on('activity', onErr);
  try {
    const intake = createIntake({ read: async () => ({ creation_liked: 0.9, creation_id: '12', topic: '42', addressed: 1 }), onSignals: (sig) => got.push(sig), listening: () => false, name: () => 'Amy' });
    intake.hear({ conversation: 'voice:2', speaker: owner, text: 'That song you made is fire.', owner: true, addressed: true });
    await tick(); await tick(); await tick();
  } finally { bus.off('activity', onErr); }
  assert.deepEqual(errors, []);
  assert.equal(got.length, 1);
  assert.equal(got[0].creation_id, '12');
  assert.equal(got[0].creation_liked, 0.9);
});

// Overheard text chat is read only while her stance has her listening. Lines in a voice call are always read (owner,
// 2026-11-11): what the room says to each other is what he reads the quiet from (pressure-quiet-read.test.js).
test('an overheard line in text chat is read only while her stance has her listening', async () => {
  const got = [];
  let listening = false;
  const intake = createIntake({ read: async () => ({ monologue: 1 }), onSignals: (sig) => got.push(sig), listening: () => listening });
  assert.equal(intake.hear({ conversation: 'text:1', speaker: owner, text: 'so anyway the thing about mirrors is...', addressed: false }), false);
  listening = true;
  assert.equal(intake.hear({ conversation: 'text:1', speaker: owner, text: 'so anyway the thing about mirrors is...', addressed: false }), true);
  await tick(); await tick();
  assert.equal(got.length, 1);
});

test('a busy room keeps only the newest waiting line per conversation, and a model outage backs off with one error', async () => {
  let calls = 0, fail = true;
  let t = 0;
  const got = [];
  const intake = createIntake({ read: async () => { calls++; if (fail) throw new Error('fetch failed'); return { novelty: 1 }; }, onSignals: (sig) => got.push(sig), listening: () => true, now: () => t });
  intake.hear({ conversation: 'c', speaker: owner, text: 'one', addressed: true });
  intake.hear({ conversation: 'c', speaker: owner, text: 'two', addressed: true });
  intake.hear({ conversation: 'c', speaker: owner, text: 'three', addressed: true });
  await tick(); await tick(); await tick();
  assert.ok(calls <= 2, `the first read and at most the newest waiting one: ${calls}`);
  assert.equal(got.length, 0);
  assert.equal(intake.status().outage, true);
  fail = false;
  intake.hear({ conversation: 'c', speaker: owner, text: 'four', addressed: true });
  await tick(); await tick();
  assert.equal(got.length, 0, 'still paused: the line is dropped, not read');
  t = 60_000;
  intake.hear({ conversation: 'c', speaker: owner, text: 'five', addressed: true });
  await tick(); await tick();
  assert.equal(got.length, 1, 'after the pause it reads again');
  assert.equal(intake.status().outage, false);
});

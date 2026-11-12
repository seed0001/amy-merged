import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { createDirection } from './direction.js';

// Owner, 2026-11-10: Owner asked Amy whether she's getting at anything when she talks or just filling space, and
// asked for "a direction that you're trying to reach every time that you speak", rethought in a self-reflection
// when a pressure bucket fires. These run conversations through it on a simulated clock.

let clock = Date.parse('2026-11-10T14:00:00Z');
const now = () => clock;
const later = (min) => { clock += min * 60_000; };
const FLAT = { substance: 0.05, depth: 0, acknowledges: 0.2 }; // "Amen." "Yeah." small talk with nothing in it
const ALIVE = { substance: 0.8, depth: 0.7, opening_up: 0.6, acknowledges: 0.8 };
// The 08:14 to 08:24 talk he had with her: a gas station run, the cold, a smoke break, then the real question.
const TALK = [
  { name: 'Owner', text: 'We just went to the gas station and we just got back.' },
  { name: 'You', text: 'How was the trip, just a quick errand?' },
  { name: 'Owner', text: "No, because it's kind of cold right now in Alabama." },
  { name: 'Owner', text: "I'm asking because I'm wondering if we have to add some additional layers to the framework that gives you a direction." },
];

function engine(name, think) {
  const file = path.join(DATA_DIR, `direction-test-${name}.json`), historyFile = path.join(DATA_DIR, `direction-test-${name}.jsonl`);
  rmSync(file, { force: true }); rmSync(historyFile, { force: true });
  const log = [];
  const d = createDirection({ file: () => file, historyFile: () => historyFile, now, log: (type, e) => log.push({ type, ...e }), think, transcript: async () => TALK, standing: async () => ({ stage: 'close friend' }), goals: async () => '' });
  return { d, log };
}
const talk = (d, sig, n) => { for (let i = 0; i < n; i++) { d.onLine('owner', 'Owner', sig, { toHer: true, conversation: 'voice:1' }); later(1); } };

test('talking with someone with no aim builds the urge; lines not meant for her do not', () => {
  const { d } = engine('noaim');
  d.onLine('owner', 'Owner', FLAT, { toHer: false, conversation: 'voice:1' });
  assert.equal(d.need(), 0, 'overheard lines are not her conversation');
  talk(d, FLAT, 3);
  assert.ok(d.need() >= 0.6, `three lines in with no aim: ${d.need().toFixed(2)}`);
  assert.equal(d.target().id, 'owner');
  later(60);
  assert.equal(d.need(), 0, 'a conversation long over needs nothing');
});

test('the reflection sets an aim grounded in what was said; one that quotes nothing real is refused', async () => {
  let reply = { action: 'set', aim: 'I want to work out with Owner what direction should mean for me', why: 'he asked whether I am getting anywhere', evidence: 'gives you a direction', progress: 0.1 };
  const { d, log } = engine('ground', async () => reply);
  talk(d, FLAT, 4);
  const r = await d.reflect();
  assert.equal(r.changed, true);
  assert.match(d.read('owner').aim, /direction should mean/);
  assert.equal(d.need(), 0, 'reflecting settles the urge');
  assert.equal(d.history().at(-1).evidence, 'gives you a direction');
  assert.ok(log.some((e) => e.type === 'direction' && e.nodes.includes('bucket:direction') && e.nodes.includes('person:owner')), 'it lights her mind map');

  reply = { action: 'replace', aim: 'I want to plan his birthday party', why: 'he mentioned it', evidence: 'my birthday is next week', progress: 0 };
  talk(d, FLAT, 6);
  const refused = await d.reflect();
  assert.equal(refused.changed, false);
  assert.match(refused.refused, /isn't in the conversation/);
  assert.match(d.read('owner').aim, /direction should mean/, 'the grounded aim stays');
});

// A reply from her local model that isn't JSON is a failed reflection: nothing changes and the urge stays.
test('an unreadable reflection fails with a reason and leaves the urge in place', async () => {
  const { d } = engine('unreadable', async () => null);
  talk(d, FLAT, 4);
  const before = d.need();
  await assert.rejects(d.reflect(), /didn't come back as readable JSON/);
  assert.equal(d.need(), before, 'the urge stays, so she tries again when it fires');
  assert.equal(d.read('owner').aim, '');
});

test('a flat conversation and a change of subject build the urge to rethink; a lively one on the aim does not', () => {
  const { d } = engine('drift');
  d.set('owner', 'Owner', { aim: 'I want to understand what has been weighing on him', why: 'he keeps saying he is stuck' });
  talk(d, ALIVE, 10);
  assert.ok(d.need() < 0.3, `lively and on the aim: ${d.need().toFixed(2)}`);
  talk(d, FLAT, 5); // the five empty lines of the gas station talk
  assert.ok(d.need() >= 0.6, `gone flat: ${d.need().toFixed(2)}`);
  const { d: d2 } = engine('shift');
  d2.set('owner', 'Owner', { aim: 'I want to understand what has been weighing on him', why: 'test' });
  talk(d2, { ...ALIVE, topic_shift: 0.9 }, 3);
  assert.ok(d2.need() >= 0.6, `the subject moved off it: ${d2.need().toFixed(2)}`);
});

test('her relationship changing stage makes her rethink what she wants with them', () => {
  const { d } = engine('stage');
  d.set('owner', 'Owner', { aim: 'I want to get to know him', why: 'we just met' });
  talk(d, ALIVE, 2);
  const before = d.need();
  d.onStage('owner');
  assert.ok(d.need() >= before + 0.3);
});

// Through her real pressure system: lines read by her intake reach the engine, the bucket fills from its need with
// no clock involved, and firing runs the reflection privately.
test('her pressure: flat lines to her fill the direction bucket and it fires as a private reflection', async () => {
  const pressure = await import('./pressure.js');
  let reflected = 0;
  const lines = [];
  pressure.startPressure();
  pressure.cfg.flows = [];
  pressure.setDirector({ need: () => 1, reflect: async () => { reflected++; return { changed: true }; }, onLine: (...a) => lines.push(a), onStage: () => {} });
  pressure.onIntake({ addressed: 1, substance: 0.05 }, { speaker: { id: 'owner', name: 'Owner' }, conversation: 'voice:1', addressed: true, text: 'Amen.' });
  assert.equal(lines.length, 1, 'her intake reaches it');
  assert.equal(lines[0][3].conversation, 'voice:1');
  let fired = null;
  for (let i = 0; i < 20 && !fired; i++) {
    pressure.state.last_tick = Date.now();
    for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = k === 'direction' ? 1 : 0;
    pressure.state.buckets.energy = 1;
    const f = pressure.tick('test');
    if (f?.bucket === 'direction') fired = f;
  }
  assert.equal(fired?.doing, 'direct');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reflected, 1);
  pressure.setDirector(null);
});

// 2026-11-10: the stage listener sat inside onIntake, so it only existed after a line went through her intake. A stage
// change by any other route (time passing, a line read elsewhere) went unfelt. It's registered when pressure loads.
test('a relationship stage change reaches her pressure even when no line has gone through her intake', async () => {
  const pressure = await import('./pressure.js');
  const { relationships } = await import('./relationship.js');
  pressure.startPressure();
  const staged = [];
  pressure.setDirector({ need: () => 0, onLine: () => {}, onStage: (id) => staged.push(id), reflect: async () => ({}) });
  for (let i = 0; i < 6; i++) relationships().onLine('stage-test', 'Sam', { praise: 0.6, depth: 0.6, opening_up: 0.7, acknowledges: 0.8 }, { toHer: true, text: 'a line' });
  assert.ok(staged.includes('stage-test'), 'the first stage change she goes through is felt');
  pressure.setDirector(null);
});

test('every reply is shown the aim; without one she is told to notice what she wants to get to', () => {
  const { d } = engine('prompt');
  talk(d, FLAT, 1);
  assert.match(d.promptSection('owner'), /don't have a direction with Owner yet/);
  d.set('owner', 'Owner', { aim: 'I want to work out with him what direction means for me', why: 'he asked' });
  d.setOverall({ aim: 'I want my talks to go somewhere real', why: 'Owner noticed me filling space' });
  const p = d.promptSection('owner');
  assert.match(p, /Where you're heading with Owner: I want to work out/);
  assert.match(p, /Overall, lately: I want my talks to go somewhere real/);
  assert.match(p, /don't ask a question just to keep the chat going/);
  assert.throws(() => d.set('owner', 'Owner', { aim: 'x' }), /Say why/);
  assert.equal(d.drop('owner', { why: 'done' }), 'I want to work out with him what direction means for me');
  assert.deepEqual(d.history().map((e) => e.what), ['set', 'set', 'drop']);
});

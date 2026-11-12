import test from 'node:test';
import assert from 'node:assert/strict';
import { callArchitect, architectStatus, buildArchitectBrief, RULES } from './architect.js';

const gitOk = async (...args) => ({ stdout: args[0] === 'diff' ? ' src/dashboard/public/avatar-world.js | 40 ++\n 1 file changed\n' : '' });

test('a brief goes out with the owner\'s words, her taste and the architect rules; he reports, she judges, it is on record', async () => {
  const seen = [];
  let notified = '';
  const done = new Promise((resolve) => {
    callArchitect('Port the beach house from Amy-Voice as a world mode, with Chance by the sofa.', async (t) => { notified = t; }, {
      ownerText: 'I want it so detailed it looks like a real game engine.',
      gitImpl: gitOk,
      npmTestImpl: async () => ({ ok: true }),
      doctorBusy: () => false,
      runImpl: async ({ prompt, rules }) => { seen.push({ prompt, rules }); return { ok: true, report: 'Built the beach house as a world mode with a dog bed by the sofa. LOOK AT: the living room from the deck.', sessionId: 's1', engine: 'claude' }; },
      judgeImpl: async () => ({ verdict: 'like', why: 'The light is right, but that sofa is grey.', wants: ['a deep teal sofa instead of the grey one'] }),
      onFinished: resolve,
    }).then((first) => assert.match(first, /Dispatched, not built/));
  });
  const { entry, verdict } = await done;
  assert.equal(seen.length, 1);
  assert.match(seen[0].prompt, /Owner said \(verbatim.*real game engine/);
  assert.match(seen[0].prompt, /taste for her home/);
  assert.equal(seen[0].rules, RULES);
  assert.match(RULES, /Unity or Unreal/);
  assert.match(RULES, /Never edit her persona, prompts, pressure system/);
  assert.equal(entry.ok, true);
  assert.equal(entry.tests, 'pass');
  assert.equal(verdict.verdict, 'like');
  assert.match(notified, /The architect delivered/);
  assert.match(notified, /What you want different: a deep teal sofa/);
  assert.match(architectStatus(), /His last job.*went fine.*Your verdict on it: like/s);
});

test('nothing is dispatched for a slip of a brief or while the doctor is working', async () => {
  assert.match(await callArchitect('deck', async () => {}), /Error: .*at least 20 characters.*Nothing was dispatched/);
  assert.match(await callArchitect('Add a second floor with a balcony over the water.', async () => {}, { doctorBusy: () => true, gitImpl: gitOk }), /doctor is working on your code.*Nothing was dispatched/);
  assert.match(buildArchitectBrief('a deck', ''), /^The brief from/);
});

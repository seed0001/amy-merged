import test from 'node:test';
import assert from 'node:assert/strict';
import { learnProfile } from './profile-learning.js';
import { profiles } from './memory.js';

// Owner, 2026-11-10: "make sure she is saving the correct person to the correct area." James had kept "Owner was
// rude or hostile toward me" for "please restart yourself now" and "I told you to turn it down": instructions, not
// hostility. A bad mark now gets its own look before it counts.

const first = (repair) => async () => ({ preferences: [], repair, harm: null });

test('an instruction the first pass called hostile is checked again, and no bad mark is given', async () => {
  const speaker = { id: 'pl-1', name: 'Owner' };
  const before = profiles.ticks(speaker.id).negative;
  const asked = [];
  const r = await learnProfile(speaker, 'James, please restart yourself now.', null, ['Owner: you are lagging'], {
    ask: first({ kind: 'negative', evidence: 'please restart yourself now' }),
    confirm: async (x) => { asked.push(x); return { hostile: false, why: 'an instruction' }; },
  });
  assert.equal(r, undefined, 'no mark, no memory, no notice');
  assert.equal(profiles.ticks(speaker.id).negative, before);
  assert.equal(asked[0].text, 'James, please restart yourself now.');
  assert.deepEqual(asked[0].recent, ['Owner: you are lagging'], 'judged with the lines before it');
});

test('real hostility, confirmed, still counts; and a check that fails gives no mark', async () => {
  const speaker = { id: 'pl-2', name: 'Gary' };
  const r = await learnProfile(speaker, 'James you are a worthless pile of junk', null, [], {
    ask: first({ kind: 'negative', evidence: 'you are a worthless pile of junk' }),
    confirm: async () => ({ hostile: true, why: 'contempt aimed at her' }),
  });
  assert.equal(r.kind, 'negative');
  const quiet = await learnProfile({ id: 'pl-3', name: 'Gary' }, 'James you are a worthless pile of junk', null, [], {
    ask: first({ kind: 'negative', evidence: 'you are a worthless pile of junk' }),
    confirm: async () => { throw new Error('fetch failed'); },
  });
  assert.equal(quiet, undefined);
});

test('kindness is not second-guessed', async () => {
  let checked = false;
  const r = await learnProfile({ id: 'pl-4', name: 'friend_3' }, 'thank you James, that was lovely', null, [], {
    ask: first({ kind: 'positive', evidence: 'thank you James' }), confirm: async () => { checked = true; return { hostile: false }; },
  });
  assert.equal(r.kind, 'positive');
  assert.equal(checked, false);
});

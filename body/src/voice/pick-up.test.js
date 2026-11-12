import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickUpDirection } from './session.js';
import { Interruptions } from './interruptions.js';

// Owner, 2026-11-11: "if he's interrupted, he should announce… not just keep restating what he was trying to say.
// Because he's doing it verbatim and he's not addressing the fact that he was interrupted. Or maybe he's being
// redirected and he no longer has to go down that reasoning path." And: "Nothing is kept verbatim and then played
// back, because then I can't interrupt him again… it's just re-injected into the model of this is what you were about
// to say." At 18:08 Owner said "yeah" twice and James restarted "Correction — I said 'sent it'…" from the top both times.

const parts = ['Correction — I said "sent it" like I\'d sent you a file, and I didn\'t.', 'What actually happened is I ran it through the explorer.', 'It came back a domesticated mammal.'];

test('what he was saying goes to his model as what he was about to say, with who cut in and what they said', () => {
  const d = pickUpDirection({ by: 'Owner', theirWords: 'yeah yeah', parts });
  assert.match(d, /^\(Stage direction, not something anyone said:/);
  assert.match(d, /Owner cut in while you were talking, saying "yeah yeah"/);
  assert.match(d, /You were in the middle of saying: "Correction/);
  assert.match(d, /about to say: "What actually happened is I ran it through the explorer\. It came back/);
  assert.match(d, /not a script/);
  assert.match(d, /don't repeat it or restart that sentence/);
  assert.match(d, /let the old point go/);
});

test('it holds up with nothing left to say and no words from them', () => {
  const d = pickUpDirection({ by: '', theirWords: '', parts: ['Only this.'] });
  assert.match(d, /Someone cut in while you were talking, and the floor/);
  assert.doesNotMatch(d, /after that you were about to say/);
});

test('the session never plays held words back: picking up is a reply, so it can be cut off again', () => {
  const src = readFileSync(new URL('./session.js', import.meta.url), 'utf8');
  const resume = src.slice(src.indexOf('  resumeNow('), src.indexOf('  async resumeUnfinished('));
  assert.ok(resume.includes('this.announce(pickUpDirection('), 'resumeNow goes through his model');
  assert.ok(!/this\.say\(/.test(resume), 'resumeNow never speaks saved text itself');
  assert.ok(!/Like I was saying/.test(src), 'no stock restart line');
});

test('his prompt note calls it what he was about to say, never a script to finish', () => {
  const i = new Interruptions({ classify: async () => ({ kind: 'reacting', carry_on: true }) });
  i.cutOff({ id: 'u', name: 'Owner', said: '', cut: 'I ran it through', rest: ['and it came back'] });
  const note = i.note();
  assert.match(note, /were about to say: "and it came back"/);
  assert.match(note, /never repeat or restart it/);
});

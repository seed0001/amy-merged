import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickGap, generateQuestion } from './question-engine.js';
import * as openQuestion from './open-question.js';

const gaps = [
  { scope: 'person', aboutId: 'owner', aboutName: 'Owner', area: 'music', desc: 'what music they love' },
  { scope: 'person', aboutId: 'friend_3', aboutName: 'friend_3', area: 'work', desc: 'their work' },
  { scope: 'self', aboutId: 'self', aboutName: 'herself', area: 'voice', desc: 'how she sounds to others' },
  { scope: 'home', aboutId: 'home', aboutName: 'the server', area: 'rules', desc: 'its rules' },
];

test('the harness picks the subject from her pressure, for the person she is asking, skipping areas already asked', () => {
  const to = { id: 'owner', name: 'Owner' };
  // Missing people pulls toward the person in front of her.
  assert.equal(pickGap(gaps, { to, buckets: { loneliness: 0.9 }, asked: [] }).gap.area, 'music');
  // Reflection pulls toward herself.
  assert.equal(pickGap(gaps, { to, buckets: { reflection: 0.9 }, asked: [] }).gap.scope, 'self');
  // Never another person's gap, and never an area she already asked about.
  const asked = [{ key: 'person:owner:music' }, { key: 'self:self:voice' }];
  assert.equal(pickGap(gaps, { to, buckets: { loneliness: 0.9 }, asked }).gap.scope, 'home');
});

test('the model only words the subject the harness chose', async () => {
  let seen = '';
  const q = await generateQuestion({ to: { id: 'owner', name: 'Owner' }, conversation: 'test:qe', buckets: { loneliness: 1 }, gaps: [gaps[0]],
    ask: async (messages) => { seen = messages.map((m) => m.content).join('\n'); return { question: 'What have you been listening to lately?' }; } });
  assert.match(seen, /Subject: Owner: what music they love/);
  assert.equal(q.text, 'What have you been listening to lately?');
  assert.equal(q.drive, 'loneliness');
});

test('her open question stays hers and open until she judges it answered', () => {
  const c = 'test:oq';
  openQuestion.cleared(c);
  openQuestion.asked(c, { text: 'Am I the fun one everyone sees?', to: { id: 't', name: 'Owner' } });
  openQuestion.heard(c, { id: 't', name: 'Owner' }, 'Why do you always end questions like that?');
  assert.ok(openQuestion.current(c), 'still open after he speaks');
  assert.match(openQuestion.promptSection(c, 't'), /YOUR question; Owner didn't ask it/);
  assert.match(openQuestion.promptSection(c, 't'), /Why do you always end questions like that/);
  assert.equal(openQuestion.verdictIn('Got it. [[question: answered]]'), 'answered');
  assert.equal(openQuestion.verdictIn('Fine. [[question: let go]]'), 'let go');
  assert.equal(openQuestion.verdictIn('No tag here.'), null);
  openQuestion.resolve(c, 'answered');
  assert.equal(openQuestion.current(c), null);
});

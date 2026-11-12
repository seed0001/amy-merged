import test from 'node:test';
import assert from 'node:assert/strict';
import { lifeView } from './life-view.js';
import { noteContact } from './memory.js';
import { relationships } from './relationship.js';
import { direction } from './direction.js';
import { config } from './config.js';

// Owner, 2026-11-10: a dashboard of her life: who she knows, what she knows about them, how they make her feel,
// her subjects, wants and goals. The view reads what her modules keep; these check it brings each part through.

test('her life view brings together who she knows, how they make her feel, her wants, goals and self', async () => {
  config.ownerIds = ['owner-1'];
  noteContact({ userId: 'owner-1', name: 'Owner', username: 'owner' });
  relationships().onLine('owner-1', 'Owner', { opening_up: 0.8, depth: 0.7, affection: 0.6, acknowledges: 0.8 }, { toHer: true, text: 'a line' });
  direction().set('owner-1', 'Owner', { aim: 'I want to know what has been weighing on him', why: 'he keeps saying he is stuck' });

  const v = await lifeView();
  assert.deepEqual(v.problems, [], `every part read: ${JSON.stringify(v.problems)}`);
  const t = v.people.find((p) => p.id === 'owner-1');
  assert.ok(t, 'Owner is among the people she knows');
  assert.equal(t.tier, 'owner', 'her owner shows as her owner, whatever his access tier');
  assert.ok(t.relationship?.stage, 'with where they stand');
  assert.ok(t.relationship.feelings.closeness > 0, 'and how he makes her feel');
  assert.match(t.aim.aim, /weighing on him/, 'and where she is heading with him');
  assert.ok(Array.isArray(t.memories), 'and what she knows about him');
  assert.equal(v.people[0].id, 'owner-1', 'her owner comes first');
  assert.ok(v.wants.wants.length > 5 && v.wants.feelings.length > 3, 'her wants and feelings');
  assert.ok(v.wants.wants.some((w) => w.key === 'direction'), 'including the newest want');
  assert.ok(v.goals && Array.isArray(v.goals.open), 'her goals');
  assert.ok(Array.isArray(v.self.aspects) && v.self.aspects.length > 3, 'who she is, aspect by aspect');
  assert.ok(Array.isArray(v.subjects), 'her subjects');
});

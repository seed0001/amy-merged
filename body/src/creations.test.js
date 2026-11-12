import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import * as creations from './creations.js';
import { experiences } from './experience.js';

// Owner, 2026-11-09: music, pictures, visual effects and what people use are judged by the person, not by the
// tool. She tracks their reactions, and that's how she gets feedback on those things.
const owner = { id: 'u-owner', name: 'Owner' };
const fresh = () => { rmSync(path.join(DATA_DIR, 'creations.json'), { force: true }); };
const expectation = (act) => ({ id: 'e1', act, objective: `${act}: aurora`, bucket: 'expression', person: owner.id, method: act, spent: 0, expected: 0.5, at: Date.now() });

test('what she makes for people is judged by them; plain tool calls are not', () => {
  assert.equal(creations.judgedByUser('generate_image', { prompt: 'x' }), true);
  assert.equal(creations.judgedByUser('generate_music', {}), true);
  assert.equal(creations.judgedByUser('avatar_background', { action: 'scene' }), true);
  assert.equal(creations.judgedByUser('avatar_background', { action: 'status' }), false);
  assert.equal(creations.judgedByUser('web_search', {}), false);
});

test('a creation waits for the reaction; nothing is decided until then', () => {
  fresh();
  creations.open({ expectation: expectation('avatar_background'), act: 'avatar_background', label: 'background', detail: 'aurora over peaks', conversation: 'voice:1', person: owner.id, personName: 'Owner' });
  assert.equal(creations.awaiting('voice:1').length, 1);
  assert.match(creations.intakeContext('voice:1'), /aurora over peaks/);
  assert.match(creations.promptSection('voice:1'), /Waiting to hear what they think/);
});

test('a line that is not a reaction leaves it waiting; a reaction settles it with their verdict, credited to them', async () => {
  fresh();
  const item = creations.open({ expectation: expectation('avatar_background'), act: 'avatar_background', label: 'background', detail: 'aurora', conversation: 'voice:2', person: owner.id });
  assert.equal(await creations.feedback({ creation_liked: 0, creation_disliked: 0 }, { speaker: owner, conversation: 'voice:2', text: 'anyway' }), null);
  assert.equal(creations.awaiting('voice:2').length, 1);
  experiences.reset();
  const settled = await creations.feedback({ creation_liked: 0.9, creation_disliked: 0, creation_id: item.id }, { speaker: owner, conversation: 'voice:2', text: 'oh that aurora is gorgeous' });
  assert.ok(settled, 'settled');
  assert.ok(settled.satisfaction > 0.9 && settled.outcome > 0.9, `verdict ${settled.satisfaction}`);
  assert.equal(settled.person, owner.id);
  assert.equal(creations.awaiting('voice:2').length, 0);
  assert.match(creations.promptSection('voice:2'), /Owner loved your background/);
});

test('a disliked creation is a low outcome, kept with what they said, and shapes her record for that kind of thing', async () => {
  fresh();
  experiences.reset();
  creations.open({ expectation: expectation('generate_image'), act: 'generate_image', label: 'picture', detail: 'galaxy', conversation: 'text:3', person: owner.id });
  const settled = await creations.feedback({ creation_liked: 0, creation_disliked: 0.9 }, { speaker: owner, conversation: 'text:3', text: "nah I don't like that one" });
  assert.ok(settled.satisfaction < 0.2);
  assert.equal(settled.result, 'disliked');
  assert.match(settled.why, /didn't like it/);
  const record = experiences.ofAct('generate_image').at(-1);
  assert.ok(record.outcome < 0.2, 'her record at making pictures carries the verdict');
});

test('something she made on her own (no conversation) can be reacted to anywhere', async () => {
  fresh();
  creations.open({ expectation: expectation('songwrite'), act: 'songwrite', label: 'song', detail: '"Glass"', conversation: null });
  assert.equal(creations.awaiting('voice:9').length, 1);
  const settled = await creations.feedback({ creation_liked: 0.7 }, { speaker: owner, conversation: 'voice:9', text: 'that song you wrote is fire' });
  assert.ok(settled && settled.satisfaction > 0.5);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReflections, onGoalLeft } from './reflections.js';
import { createInterests } from './interests.js';
import { config, DATA_DIR } from './config.js';
import { currentSetupStep, setupSection, SETUP } from './onboarding.js';

// Owner, 2026-11-11: "see where the memory leak is at." What was leaking into James's prompt every turn: the research
// from goals Owner had him drop (the NATA athletic-trainer grants: 6 of the 8 "goal experiences" shown), the interests
// that grew out of them, and a setup step telling him he had "no personality of your own" with a persona saved.

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'leak-'));
const experience = (id, goalId, summary, query) => ({ id, goalId, outcome: 'researched', summary, at: 1,
  evidence: { file: 'C:/x/journal/2026-11-11.md', sources: ['https://a.example', 'https://b.example'], query } });

test('experiences from a dropped goal stop being shown; the open goal\'s still are', () => {
  const file = path.join(tmp(), 'reflections.json');
  writeFileSync(file, JSON.stringify({ next: 3, items: [
    { id: 1, kind: 'goal', text: 'Research athletic-trainer grants', at: 1, dropped: 2, dropReason: 'Owner said let it go' },
    { id: 2, kind: 'goal', text: 'Research AI research grants', at: 1 },
  ], experiences: [
    experience('e1', 1, 'NATA deadlines are February 15th', 'NATA grant deadline'),
    experience('e2', 2, 'NSF SBIR covers small AI teams', 'AI research grants for small teams'),
  ] }));
  const block = createReflections(file).promptBlock();
  assert.doesNotMatch(block, /February 15th/, 'the dropped goal\'s research is gone from the prompt');
  assert.match(block, /NSF SBIR covers small AI teams; 2 sources \(in 2026-11-11\.md\)/, 'the open goal\'s stays, without the raw evidence');
  assert.doesNotMatch(block, /https:\/\//);
  assert.match(block, /Goals you left behind: #1/, 'that it was left behind is still known');
  // Kept on file all the same (learned preference, review).
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).experiences.length, 2);
});

test('letting a goal go tells listeners what it was about, and its interests let go with it', async () => {
  const file = path.join(tmp(), 'reflections.json');
  writeFileSync(file, JSON.stringify({ next: 3, items: [
    { id: 1, kind: 'goal', text: 'Research athletic-trainer grants', at: 1 },
    { id: 2, kind: 'goal', text: 'Research AI research grants', at: 1 },
  ], experiences: [experience('e1', 1, 'NATA criteria', 'NATA grant eligibility'), experience('e2', 2, 'NSF', 'AI research grants')] }));
  const store = createReflections(file);
  const heard = [];
  const off = onGoalLeft((note) => heard.push(note));
  try { store.drop(1, 'Owner said let it go'); } finally { off(); }
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0].about, ['Research athletic-trainer grants', 'NATA grant eligibility']);
  assert.ok(heard[0].held.includes('AI research grants'), 'what the goals still held are about comes along');

  // Meaning by subject words, as a stand-in for the embedder.
  const SUBJECTS = ['NATA', 'athletic', 'AI research', 'League'];
  const embedder = async (texts) => texts.map((t) => SUBJECTS.map((s) => (t.includes(s) ? 1 : 0)).concat([0.01]));
  const it = createInterests({ file: path.join(tmp(), 'interests.json'), embedder });
  await it.notice([{ name: 'NATA grant eligibility criteria', source: 'answered' }, { name: 'AI research grants', source: 'answered' },
    { name: 'League of Legends', source: 'conversation', person: 'friend_3' }]);
  const released = await it.letGo(heard[0].about, heard[0].held);
  assert.deepEqual(released, ['NATA grant eligibility criteria']);
  assert.deepEqual(it.top().map((t) => t.name).sort(), ['AI research grants', 'League of Legends']);

  // Caught up once for goals let go while nothing listened.
  assert.deepEqual(store.leftUnheard().map((n) => n.goal.id), [1]);
  store.markLeftHeard(1);
  assert.deepEqual(store.leftUnheard(), []);
});

test('a persona saved any way, not only by the persona tool, finishes the persona setup step', () => {
  const file = path.join(DATA_DIR, 'onboarding.json');
  const saved = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const persona = config.persona;
  try {
    config.persona = '';
    writeFileSync(file, JSON.stringify({ done: { intro: 1, wake_words: 1 }, setup_started: 1 }));
    assert.equal(currentSetupStep()?.id, 'persona');
    assert.match(setupSection(), /no personality of your own/);
    // persona.md written from the dashboard or by hand: config.persona is set, the tool never ran.
    config.persona = 'You are James: steady, direct, curious.';
    assert.doesNotMatch(setupSection(), /no personality of your own/);
    assert.equal(currentSetupStep()?.id, SETUP.find((id) => !['intro', 'persona', 'wake_words'].includes(id)), 'on to the next step');
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).done.persona, 'and it is recorded');
  } finally { config.persona = persona; if (saved !== null) writeFileSync(file, saved); }
});

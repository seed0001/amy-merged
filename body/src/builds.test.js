import test from 'node:test';
import assert from 'node:assert/strict';
import { pickIdea, slugOf, startBuild, builtIdeas, buildRoot } from './builds.js';
import { config } from './config.js';

// Owner, 2026-11-11: "Why are all the pages he's creating saying Amy? That should have been removed from the code
// base." A build is named after whoever the companion is (config.botName), never a fixed name.
config.botName = 'James Burke';
config.botGender = 'male';

test('the idea is the strongest interest she has not built yet, with its reason', () => {
  const top = [
    { name: 'telescope mirrors', interest: 0.82, why: 'came up in conversation with Owner' },
    { name: 'bird migration', interest: 0.6, why: 'you read about it' },
  ];
  assert.equal(pickIdea(top, new Set()).topic, 'telescope mirrors');
  assert.equal(pickIdea(top, new Set([slugOf('telescope mirrors')])).topic, 'bird migration');
  assert.equal(pickIdea([{ name: 'weather', interest: 0.3, why: '' }], new Set()), null);
});

test('a build is named, placed and reasoned by code, and opens in her tab when the job is done', async () => {
  const added = [], started = [], opened = [], logged = [];
  const w = {
    add: (args) => added.push(args),
    start: async (name, task, notify) => { started.push({ name, task }); await notify(`${name} job #3 "Build" done:\nThe page works.`); return 'started'; },
    open: async (name) => { opened.push(name); return 'opened'; },
  };
  const idea = { topic: 'telescope mirrors', interest: 0.82, why: 'came up in conversation with Owner' };
  const result = await startBuild({ idea, pressure: 'build 0.91', feelings: 'curiosity 0.7', w });
  assert.equal(added[0].name, 'James telescope mirrors');
  assert.equal(buildRoot(), 'Desktop\\James Projects');
  assert.equal(added[0].folder, 'Desktop\\James Projects\\telescope-mirrors');
  assert.match(added[0].notes, /Built by James from his own interest/);
  assert.match(added[0].notes, /Driven by: build 0\.91/);
  assert.match(started[0].task, /Read BUILD-GUIDE\.md first/);
  assert.match(started[0].task, /James's own interest/);
  assert.match(started[0].task, /Feelings then: curiosity 0\.7/);
  assert.doesNotMatch(`${added[0].name} ${added[0].notes} ${started[0].task}`, /Amy|AMY/, 'nothing he builds names Amy');
  assert.deepEqual(opened, ['James telescope mirrors']);
  assert.equal(result.name, 'James telescope mirrors');
});

test('a failed job is not opened in her tab', async () => {
  const opened = [];
  const w = {
    add: () => {},
    start: async (name, task, notify) => { await notify(`${name} job #4 "Build" failed:\nIt broke.`); return 'started'; },
    open: async (name) => { opened.push(name); },
  };
  await startBuild({ idea: { topic: 'x thing', interest: 0.9, why: 'why' }, pressure: 'p', feelings: 'f', w });
  assert.deepEqual(opened, []);
});

test('ideas already built are known by their project name', () => {
  const w = { snapshot: () => [{ name: 'James telescope mirrors' }, { name: 'Lyra' }] };
  assert.deepEqual([...builtIdeas(w)], ['telescope-mirrors']);
});

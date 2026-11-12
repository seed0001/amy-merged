import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { startTask, setSteps, ownerWorkRunning } from './agents.js';
import * as pressure from './pressure.js';
import { runTool } from './tools.js';

// Owner, 2026-11-11: "The local model choked on a build. Whenever we're building or he's doing something like this,
// we need to allocate the resources accordingly, especially if it's coming from me. If he's low on energy, we gotta
// have a bypass. If it's a direct build request, he gets extra energy, extra excitement." At 11:12 his LLM site build
// came back empty in four seconds on the local model while realization, self-upkeep and pondering fired every fifteen
// seconds on the same model.

const wait = (pred, ms = 2000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => (pred() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timed out waiting')) : setTimeout(tick, 5));
  tick();
});
const callFiles = { content: '', tool_calls: [{ id: 'c1', function: { name: 'files', arguments: '{"action":"write","path":"Desktop/x/index.html"}' } }] };
const done = { content: 'Built the page.', tool_calls: [] };

test("the owner's build moves to the cloud when the local model chokes on its first step, and finishes there", async () => {
  config.openrouter.apiKey = 'test-key';
  config.workshop.coderModel = 'test/cloud-coder';
  const calls = [];
  setSteps({
    local: async () => { calls.push('local'); return { content: '', tool_calls: [] }; }, // choked: nothing at all
    cloud: async (_m, _t, { model }) => { calls.push(`cloud:${model}`); return calls.filter((c) => c.startsWith('cloud')).length === 1 ? callFiles : done; },
  });
  const task = startTask({ title: 'LLM Architecture Explorer', instructions: 'build it', coding: true, owner: true, tools: [], run: async () => '[files: ok]\nCreated Desktop/x/index.html' });
  await wait(() => task.status !== 'running');
  assert.equal(task.status, 'done', task.result);
  assert.equal(task.cloud, true);
  assert.equal(task.model, 'test/cloud-coder');
  assert.deepEqual(calls, ['local', 'cloud:test/cloud-coder', 'cloud:test/cloud-coder'], 'tried local once, then the rest on the cloud');
  assert.match(task.result, /Built the page/);
});

test('a local error on the owner\'s work also moves it to the cloud; her own tasks never go to the cloud', async () => {
  config.openrouter.apiKey = 'test-key';
  const calls = [];
  setSteps({
    local: async () => { calls.push('local'); throw new Error('model timed out'); },
    cloud: async () => { calls.push('cloud'); return done; },
  });
  const owners = startTask({ title: 'owner job', instructions: 'x', coding: true, owner: true, tools: [], run: async () => '' });
  await wait(() => owners.status !== 'running');
  assert.equal(owners.status, 'done');
  assert.deepEqual(calls, ['local', 'cloud']);
  calls.length = 0;
  const hers = startTask({ title: 'her own task', instructions: 'x', coding: true, owner: false, tools: [], run: async () => '' });
  await wait(() => hers.status !== 'running');
  assert.equal(hers.status, 'failed', 'not the owner\'s: no cloud, the local error stands');
  assert.deepEqual(calls, ['local']);
  setSteps();
});

// Owner, 2026-11-11, 7:35 PM: her "How I Work" site came back failed with no files. The local model listed the
// folder, read the guide, checked system info three times and said it was done; nothing moved it to the cloud.
test("the owner's build moves to the cloud when the local model calls it done without the work, and the cloud finishes it", async () => {
  config.openrouter.apiKey = 'test-key';
  config.workshop.coderModel = 'test/cloud-coder';
  const calls = [], told = [];
  const look = { content: '', tool_calls: [{ id: 'l1', function: { name: 'files', arguments: '{"action":"read","path":"Desktop/x/BUILD-GUIDE.md"}' } }] };
  setSteps({
    local: async () => { calls.push('local'); return calls.length === 1 ? look : { content: 'All done.', tool_calls: [] }; },
    cloud: async (messages) => { calls.push('cloud'); told.push(messages.at(-1).content); return calls.filter((c) => c === 'cloud').length === 1 ? callFiles : done; },
  });
  const run = async (_name, args) => (JSON.parse(args).action === 'write' ? '[files: ok]\nCreated Desktop/x/index.html' : '[files: ok]\n# Build guide');
  const verify = async (results) => {
    if (!results.some(({ out }) => /^\[files: ok\]\nCreated /.test(out))) throw new Error('Project did not produce any files.');
    return '\nVerified.';
  };
  const task = startTask({ title: 'Amy: How I Work', instructions: 'build it', coding: true, owner: true, tools: [], run, verify });
  await wait(() => task.status !== 'running');
  assert.equal(task.status, 'done', task.result);
  assert.equal(task.cloud, true);
  assert.deepEqual(calls, ['local', 'local', 'cloud', 'cloud']);
  assert.match(told[0], /isn't finished: Project did not produce any files/, 'the cloud is told what is missing');
  assert.match(task.result, /Built the page[\s\S]*Verified/);
  setSteps();
});

test("while the owner's work runs, her private local-model wants wait, keeping their pressure; after, they go", async () => {
  let release;
  setSteps({ local: () => new Promise((r) => { release = () => r(done); }), cloud: async () => done });
  const job = startTask({ title: 'owner build', instructions: 'x', coding: true, owner: true, tools: [], run: async () => '' });
  assert.equal(ownerWorkRunning().length, 1);
  pressure.startPressure();
  pressure.cfg.flows = [];
  pressure.cfg.actions_live = true;
  pressure.setOwnerWork(() => ownerWorkRunning().length > 0);
  let pondered = 0;
  pressure.setSelfWork({ upkeepNeed: () => 0, ponderNeed: () => 1, realizationNeed: () => 0, forgeNeed: () => 0, upkeep: async () => {}, ponder: async () => { pondered++; }, realize: async () => {}, forge: async () => {} });
  const fire = () => {
    for (let i = 0; i < 6; i++) {
      pressure.state.last_tick = Date.now();
      for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = k === 'self_ponder' ? 1 : 0;
      pressure.state.buckets.energy = 1;
      const f = pressure.tick('test');
      if (f?.bucket === 'self_ponder') return f;
    }
    return null;
  };
  assert.equal(fire(), null, 'it waits while his build runs');
  assert.ok((pressure.state.buckets.self_ponder ?? 0) > 0.5, 'and keeps its pressure');
  release();
  await wait(() => job.status !== 'running');
  assert.equal(fire()?.bucket, 'self_ponder', 'once the build is done, it goes');
  pressure.setOwnerWork(null);
  pressure.setSelfWork(null);
  setSteps();
});

test('a direct request from the owner is never stopped by low energy, and it lifts him', async () => {
  config.ownerIds = ['owner-1'];
  pressure.startPressure();
  pressure.state.reserve = 0.1; // far short of a workshop job (1.2)
  // An ordinary him: some energy in his channels for the lift to move (the test before this one left them empty).
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0.2;
  pressure.state.buckets.thrill = 0;
  const ctx = { perms: { owner: true, files: true }, speaker: { id: 'owner-1', name: 'Owner' }, userText: 'go ahead and build it', turn: 't1', conversation: 'voice:1', character: { main: true } };
  const out = await runTool('workshop', { action: 'job', name: 'No Such Project', task: 'build the page' }, ctx);
  assert.doesNotMatch(out, /don't have the energy/, `not stopped for energy: ${out.slice(0, 160)}`);
  assert.ok((pressure.state.buckets.thrill ?? 0) > 0.2, 'being asked lifts him');
  // Her own initiative, short of energy, still waits for it.
  pressure.state.reserve = 0.1;
  const hers = await runTool('workshop', { action: 'job', name: 'No Such Project', task: 'build the page' }, { ...ctx, speaker: { id: 'cue', name: 'cue' }, userText: '' });
  assert.match(hers, /don't have the energy/);
});

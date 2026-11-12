import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverhear } from './overhear.js';

const owner = { id: 'owner-1', name: 'Owner' };
const stranger = { id: 'other-1', name: 'friend_3' };

function setup({ verdict = { actionable: true, request: 'check the source file for the reconnect bug' }, acted = { calls: [{ name: 'files', args: { action: 'read' }, result: '[files: ok]\nfound it' }], report: 'The reconnect bug is in voice/session.js.' }, clock = { t: 1_000_000 } } = {}) {
  const asked = [], handed = [], spoken = [], logged = [];
  const overhear = createOverhear({
    ask: async (messages) => { asked.push(messages); return verdict; },
    hands: async (args) => { handed.push(args); return acted; },
    announce: (event) => spoken.push(event),
    log: (type, data) => logged.push({ type, ...data }),
    permit: (id) => ({ owner: id === owner.id }),
    now: () => clock.t,
  });
  return { overhear, asked, handed, spoken, logged, clock };
}

test('an owner request the model confirms is handed to the hands, with the request itself', async () => {
  const { overhear, handed, asked } = setup();
  await overhear.hear({ speaker: owner, text: 'you need to check the source file for that reconnect bug', conversation: 'voice:1' });
  assert.equal(asked.length, 1);
  assert.equal(handed.length, 1);
  assert.equal(handed[0].text, 'check the source file for the reconnect bug');
  assert.equal(handed[0].speaker.name, 'Owner');
});

test('other people are never acted on, even when they ask for something', async () => {
  const { overhear, asked, handed } = setup();
  await overhear.hear({ speaker: stranger, text: 'somebody should check the source file for that bug', conversation: 'voice:1' });
  assert.equal(asked.length, 0);
  assert.equal(handed.length, 0);
});

test('talk with no action words never reaches the model', async () => {
  const { overhear, asked } = setup();
  await overhear.hear({ speaker: owner, text: 'anyway I did not sleep much last night', conversation: 'voice:1' });
  assert.equal(asked.length, 0);
});

test('chat the model says is not a request does nothing', async () => {
  const { overhear, handed } = setup({ verdict: { actionable: false } });
  await overhear.hear({ speaker: owner, text: 'I was going to look at the file later maybe', conversation: 'voice:1' });
  assert.equal(handed.length, 0);
});

test('routine success stays quiet; a failure is said out loud', async () => {
  const quiet = setup({ acted: { calls: [{ name: 'web_search', args: {}, result: '[web_search: ok]\nresults' }], report: 'NOTHING' } });
  await quiet.overhear.hear({ speaker: owner, text: 'look up how telescope mirrors hold their shape', conversation: 'voice:1' });
  assert.equal(quiet.spoken.length, 0);

  const broke = setup({ acted: { calls: [{ name: 'files', args: { action: 'edit' }, result: '[files: error failed] permission denied' }], report: 'The edit failed.' } });
  await broke.overhear.hear({ speaker: owner, text: 'fix the typo in the source file please', conversation: 'voice:1' });
  assert.equal(broke.spoken.length, 1);
  assert.equal(broke.spoken[0].failed, true);
});

test('a second request within the cooldown waits', async () => {
  const { overhear, handed, clock } = setup();
  await overhear.hear({ speaker: owner, text: 'check the source file for the first bug', conversation: 'voice:1' });
  clock.t += 5_000;
  await overhear.hear({ speaker: owner, text: 'check the source file for the second bug', conversation: 'voice:1' });
  assert.equal(handed.length, 1);
  clock.t += 30_000;
  await overhear.hear({ speaker: owner, text: 'check the source file for the third bug', conversation: 'voice:1' });
  assert.equal(handed.length, 2);
});

test('a failing hands run is logged and never breaks the call', async () => {
  const logged = [];
  const overhear = createOverhear({
    ask: async () => ({ actionable: true, request: 'check the file' }),
    hands: async () => { throw new Error('openrouter down'); },
    announce: () => {},
    log: (type, data) => logged.push({ type, ...data }),
    permit: () => ({ owner: true }),
    now: () => 1,
  });
  assert.equal(await overhear.hear({ speaker: owner, text: 'check the file for me', conversation: 'voice:1' }), null);
  assert.ok(logged.some((l) => l.type === 'error' && /openrouter down/.test(l.message)));
});

test('a follow-up can share only the same speaker and call’s pending tool report', async () => {
  const { overhear, handed, spoken } = setup();
  const work = overhear.hear({ speaker: owner, text: 'check the source file for the reconnect bug', conversation: 'voice:1' });
  assert.equal(overhear.pendingReport('voice:2', owner.id), null);
  assert.equal(overhear.pendingReport('voice:1', stranger.id), null);
  assert.equal(await overhear.pendingReport('voice:1', owner.id), true);
  await work;
  assert.equal(handed.length, 1);
  assert.equal(spoken.length, 1);
  assert.equal(overhear.pendingReport('voice:1', owner.id), null);
});

test('stopping a call before classification prevents stale tool actions and reports', async () => {
  const { overhear, handed, spoken } = setup();
  let current = true;
  const work = overhear.hear({ speaker: owner, text: 'check the source file for the reconnect bug', conversation: 'voice:1', isCurrent: () => current });
  const report = overhear.pendingReport('voice:1', owner.id);
  current = false;
  assert.equal(await report, false);
  await work;
  assert.equal(handed.length, 0);
  assert.equal(spoken.length, 0);
});

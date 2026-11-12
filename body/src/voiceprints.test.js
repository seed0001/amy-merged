import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVoiceprints, cosine, downsample16k, unavailableReason } from './voiceprints.js';

// Fake voices: each person is a fixed direction; an utterance is that direction plus a little noise.
const voices = { owner: [1, 0, 0, 0], friend_3: [0, 1, 0, 0], bella: [0, 0, 1, 0] };
const noisy = (v, n = 0.05) => Float32Array.from(v, (x) => x + (Math.random() - 0.5) * n);
let speaking = 'owner';
const embed = async () => noisy(voices[speaking]);
const pcm = Buffer.alloc(48000 * 2 * 2); // two seconds of silence; the fake embed ignores it
const setup = () => {
  const logs = [];
  const vp = createVoiceprints({ embed, file: path.join(mkdtempSync(path.join(os.tmpdir(), 'vp-')), 'voiceprints.json'), log: (t, d) => logs.push({ t, ...d }) });
  return { vp, logs };
};

test('voices are learned by listening, under the tag they came in with', async () => {
  const { vp } = setup();
  speaking = 'owner';
  for (let i = 0; i < 3; i++) await vp.heard(pcm, { userId: 't', name: 'Owner', conversation: 'c' });
  speaking = 'friend_3';
  await vp.heard(pcm, { userId: 'ch', name: 'friend_3', conversation: 'c' });
  const list = vp.list();
  assert.deepEqual(list.map((p) => [p.name, p.utterances]), [['Owner', 3], ['friend_3', 1]]);
  assert.equal(vp.who('c').match, 'friend_3');
  assert.equal(vp.promptLine('c'), '', 'no mismatch, nothing to say');
});

test('a voice that matches someone else is flagged, not learned under the wrong tag', async () => {
  const { vp, logs } = setup();
  speaking = 'owner';
  for (let i = 0; i < 4; i++) await vp.heard(pcm, { userId: 't', name: 'Owner', conversation: 'c' });
  speaking = 'friend_3';
  for (let i = 0; i < 4; i++) await vp.heard(pcm, { userId: 'ch', name: 'friend_3', conversation: 'c' });
  // friend_3 talks on Owner's mic.
  const r = await vp.heard(pcm, { userId: 't', name: 'Owner', conversation: 'c' });
  assert.equal(r.mismatch, true);
  assert.equal(r.match, 'friend_3');
  assert.match(vp.promptLine('c'), /voice on Owner's mic sounds like friend_3/);
  assert.ok(logs.some((l) => l.t === 'voiceprint' && l.mismatch && l.sounds_like === 'friend_3'));
  assert.equal(vp.list().find((p) => p.name === 'Owner').utterances, 4, 'the stray utterance did not pollute his print');
});

test('short audio, a missing user, and a failing model never throw; forget and settings work', async () => {
  const { vp, logs } = setup();
  assert.equal(await vp.heard(Buffer.alloc(48000), { userId: 't', name: 'Owner', conversation: 'c' }), null);
  assert.equal(await vp.heard(pcm, { userId: '', name: 'x', conversation: 'c' }), null);
  const broken = createVoiceprints({ embed: async () => { throw new Error('model down'); }, file: path.join(mkdtempSync(path.join(os.tmpdir(), 'vp-')), 'v.json'), log: (t, d) => logs.push({ t, ...d }) });
  assert.equal(await broken.heard(pcm, { userId: 't', name: 'Owner', conversation: 'c' }), null);
  assert.ok(logs.some((l) => l.t === 'error' && /model down/.test(l.message)));
  speaking = 'bella';
  await vp.heard(pcm, { userId: 'b', name: 'Bella', conversation: 'c' });
  assert.equal(vp.forget('b'), 'Bella');
  assert.equal(vp.list().length, 0);
  assert.equal(vp.settings({ threshold: 0.7 }).threshold, 0.7);
  assert.throws(() => vp.settings({ threshold: 2 }), /threshold is 0\.2 to 0\.95/);
});

test('helpers: cosine, downsampling, and the unavailable reason', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  const pcm48 = Buffer.alloc(12);
  for (let i = 0; i < 6; i++) pcm48.writeInt16LE((i + 1) * 100, i * 2);
  const out = downsample16k(pcm48);
  assert.equal(out.length, 4);
  assert.equal(out.readInt16LE(0), 200);
  assert.equal(out.readInt16LE(2), 500);
  assert.match(unavailableReason({ model: path.join(os.tmpdir(), 'no-such-model.onnx'), python: 'python' }), /speaker model is missing/);
});

test('without the model on this machine, hearing is a silent no-op that says so once', async () => {
  const logs = [];
  const vp = createVoiceprints({ file: path.join(mkdtempSync(path.join(os.tmpdir(), 'vp-')), 'v.json'), model: path.join(os.tmpdir(), 'no-such-model.onnx'), python: 'python', log: (t, d) => logs.push({ t, ...d }) });
  assert.equal(await vp.heard(pcm, { userId: 't', name: 'Owner', conversation: 'c' }), null);
  assert.equal(await vp.heard(pcm, { userId: 't', name: 'Owner', conversation: 'c' }), null);
  assert.equal(logs.filter((l) => l.t === 'voiceprint' && l.unavailable).length, 1);
  const s = vp.status();
  assert.equal(s.ready, false);
  assert.match(s.fix, /setup-voiceprints\.ps1/);
  assert.match(s.fix, /pip install sherpa-onnx/);
});

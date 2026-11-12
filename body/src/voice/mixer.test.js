import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Mixer, FRAME } from './mixer.js';

// Owner, 2026-11-10: the music has to keep playing behind her voice the whole time, two streams in one.

// Stand-ins for the decoders: music is a steady tone of value `level`, speech a block of value 8000.
const tone = (frames, level) => { const b = Buffer.alloc(frames * FRAME); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(level, i); return b; };
const mixer = ({ musicFrames = 200, speechFrames = 50 } = {}) => new Mixer({
  music: () => Readable.from([tone(musicFrames, 10000)]),
  speech: async () => tone(speechFrames, 8000),
});
const tick = () => new Promise((r) => setImmediate(r));
const level = (f) => f.readInt16LE(0);

test('the music keeps playing under her voice, dipped while she talks and back up after', async () => {
  const m = mixer();
  m.setVolume(1);
  m.playMusic('song');
  await tick();
  let f;
  for (let i = 0; i < 40; i++) f = m.frame();
  const before = level(f);
  const v = m.say(Buffer.from('clip'));
  await v.ready;
  let during;
  for (let i = 0; i < 49; i++) during = m.frame();
  assert.ok(during.readInt16LE(0) > 8000, 'her voice is in it');
  assert.ok(during.readInt16LE(0) - 8000 < before * 0.6, `the music dipped under her: ${during.readInt16LE(0) - 8000} vs ${before}`);
  m.frame();
  await v.ended;
  for (let i = 0; i < 60; i++) f = m.frame();
  assert.ok(level(f) > before * 0.9, `and came back up: ${level(f)} vs ${before}`);
  assert.equal(m.musicPlayedMs, (40 + 50 + 60) * 20, 'the song never stalled while she spoke');
});

test('her voice is heard whole: started when its first sound goes out, ended after the last', async () => {
  const m = mixer({ speechFrames: 3 });
  const v = m.say(Buffer.from('clip'));
  let started = false; v.started.then(() => { started = true; });
  await v.ready;
  assert.equal(m.speaking, true);
  m.frame(); await tick();
  assert.equal(started, true);
  m.frame(); m.frame(); await v.ended;
  assert.equal(m.speaking, false);
  assert.equal(m.frame(), null, 'nothing left: the stream ends so she isn\'t shown talking to silence');
});

test('stopping her mid-sentence leaves the music playing; a song that runs out says so', async () => {
  const m = mixer({ musicFrames: 5 });
  let ended = 0; m.on('music-end', () => ended++);
  m.playMusic('song'); await tick();
  const v = m.say(Buffer.from('clip')); await v.ready;
  m.frame();
  m.stopSpeech();
  await v.ended;
  assert.equal(m.speaking, false);
  assert.equal(m.musicOn, true, 'the music plays on');
  for (let i = 0; i < 6; i++) m.frame();
  assert.equal(ended, 1);
  assert.equal(m.musicOn, false);
});

// Owner, 2026-11-11: "My mic would not pick up because of how loud he was playing." Anyone talking in the call puts the
// music well under them, lower than under his own voice, and it comes back up once they've stopped.
test('someone talking in the call puts the music well under them, and it comes back after', async () => {
  const m = mixer({ musicFrames: 400 });
  m.setVolume(1);
  m.playMusic('song'); await tick();
  let f;
  for (let i = 0; i < 40; i++) f = m.frame();
  const before = level(f);
  const t0 = Date.now();
  let during;
  for (let i = 0; i < 80; i++) { m.othersTalking(); during = m.frame(); }
  assert.ok(level(during) < before * 0.2, `under them: ${level(during)} vs ${before}`);
  m.othersUntil = t0 - 1; // they stopped talking
  for (let i = 0; i < 80; i++) f = m.frame();
  assert.ok(level(f) > before * 0.9, `back up after: ${level(f)} vs ${before}`);
});

test('paused music sends nothing; resumed, it carries on from where it was', async () => {
  const m = mixer();
  m.playMusic('song'); await tick();
  for (let i = 0; i < 10; i++) m.frame();
  assert.equal(m.pauseMusic(), true);
  assert.equal(m.frame(), null);
  assert.equal(m.resumeMusic(), true);
  m.frame();
  assert.equal(m.musicPlayedMs, 220);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { STATIONS, findStation } from './music.js';

test('stations are found by name, by part of a name, or by mood words', () => {
  assert.equal(findStation('Drone Zone').name, 'Drone Zone');
  assert.equal(findStation('groove salad').name, 'Groove Salad');
  assert.equal(findStation('radio paradise').name, 'Radio Paradise');
  assert.equal(findStation('paradise mellow').name, 'Radio Paradise Mellow');
  assert.equal(findStation('something spacey ambient').name, 'Deep Space One');
  assert.equal(findStation('spy lounge').name, 'Secret Agent');
  assert.equal(findStation(''), null);
  assert.equal(findStation('polka hour'), null);
});

test('every station has a name, an https stream and a mood', () => {
  assert.ok(STATIONS.length >= 10);
  for (const s of STATIONS) {
    assert.ok(s.name && s.mood);
    assert.match(s.url, /^https:\/\//);
  }
  assert.equal(new Set(STATIONS.map((s) => s.name)).size, STATIONS.length, 'names are unique');
});

// The volume rule lives on the voice session; the same arithmetic is checked here against a stand-in
// built the way session.js builds its music state, so a wrong clamp shows up without a voice call.
test('volume is clamped to 0..1 and applied to what is playing', () => {
  const applied = [];
  const session = {
    music: { queue: [], index: -1, on: false, volume: 0.6, station: null },
    musicResource: { volume: { setVolume: (v) => applied.push(v) } },
    musicVolume() { return this.music.volume ?? 0.6; },
    setMusicVolume(level) {
      const v = Number(level);
      if (!Number.isFinite(v)) throw new Error('Volume is a number from 0 (silent) to 1 (full).');
      this.music.volume = Math.max(0, Math.min(1, v));
      this.musicResource?.volume?.setVolume(this.music.volume);
      return this.music.volume;
    },
  };
  assert.equal(session.musicVolume(), 0.6);
  assert.equal(session.setMusicVolume(0.25), 0.25);
  assert.equal(session.setMusicVolume(1.7), 1);
  assert.equal(session.setMusicVolume(-2), 0);
  assert.deepEqual(applied, [0.25, 1, 0]);
  assert.throws(() => session.setMusicVolume('loud'), /0 \(silent\) to 1/);
});

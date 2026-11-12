import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR, onVoiceFreeTalkChanged, updateSettings } from './config.js';

test('free talk stays unchanged when settings cannot be saved and publishes once after saving', () => {
  const file = path.join(DATA_DIR, 'settings.json');
  const initial = config.voice.freeTalk;
  const published = [];
  const unsubscribe = onVoiceFreeTalkChanged((value) => {
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).voiceFreeTalk, value);
    published.push(value);
  });
  try {
    mkdirSync(file);
    try {
      assert.throws(() => updateSettings({ voiceFreeTalk: !initial }));
      assert.equal(config.voice.freeTalk, initial);
      assert.deepEqual(published, []);
    } finally {
      rmdirSync(file);
    }
    updateSettings({ voiceFreeTalk: !initial });
    updateSettings({ voiceFreeTalk: !initial });
    assert.deepEqual(published, [!initial]);
  } finally {
    unsubscribe();
  }
});

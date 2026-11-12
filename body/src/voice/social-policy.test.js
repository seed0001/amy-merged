import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticSpeech } from './social-policy.js';

test('new arrivals, joins and reconnects never trigger greetings', () => {
  for (const voice of [{}, { autoSocial: true, joinGreeting: true, newcomerIntroductions: true, arrivalFollowups: true, reconnectAnnouncements: true }]) {
    for (const kind of ['join', 'newcomer', 'followup', 'reconnect']) assert.equal(automaticSpeech(kind, voice), false, kind);
  }
});
test('a companion waking after reboot may announce itself', () => {
  assert.equal(automaticSpeech('restart', {}), true);
  assert.equal(automaticSpeech('restart', { autoSocial: false, restartAnnouncements: false }), true);
});
test('task progress keeps its existing independent control', () => {
  assert.equal(automaticSpeech('taskProgress', {}), true);
  assert.equal(automaticSpeech('taskProgress', { taskProgress: false }), false);
});

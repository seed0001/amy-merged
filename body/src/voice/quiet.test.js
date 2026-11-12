import test from 'node:test';
import assert from 'node:assert/strict';

// Nov 10: Owner lay down with his dog, phone in hand, quiet for minutes, and James never spoke up. Every packet from
// the open mic (breathing, the dog, rustling) counted as "someone talking", so the quiet clock kept starting over.
// The quiet the pressure feels runs from the last real line or her own speech; talking now means voice-level sound.

const { sessions, voiceActor } = await import('./session.js');

function fakeSession({ wordsAgo, voicedAgo, noiseAgo = 0, open = true }) {
  const now = Date.now();
  const s = {
    destroyed: false, pending: 0, speaking: false, transcribing: false, conversation: 'voice:quiet-test', startedAt: now - 3600_000,
    lastWords: now - wordsAgo, lastVoiced: now - voicedAgo, lastHeard: now - noiseAgo, lastSpoke: 0, lastAddressed: now - wordsAgo,
    listening: new Set(open ? ['u-owner'] : []), heardFrom: new Map(),
    humans: () => [{ id: 'u-owner', displayName: 'Owner' }],
  };
  // the same rule the real session uses
  s.talkingNow = (t = Date.now()) => t - (s.lastVoiced ?? 0) < 1500;
  return s;
}

test('an open mic with only noise is quiet: the silence builds and she can speak up', () => {
  sessions.clear();
  sessions.set('g', fakeSession({ wordsAgo: 70_000, voicedAgo: 60_000, noiseAgo: 200 }));
  const room = voiceActor.room();
  assert.ok(room.quietMs >= 69_000, `quiet for ${room.quietMs} ms though the mic sent noise 0.2 s ago`);
  assert.ok(voiceActor.audience({ lullMs: 15_000 }), 'the pause is real: she may speak');
  sessions.clear();
});

test('someone actually talking, or a line just said, is not quiet', () => {
  sessions.clear();
  sessions.set('g', fakeSession({ wordsAgo: 70_000, voicedAgo: 300 }));
  assert.equal(voiceActor.room().quietMs, 0, 'voice-level sound right now: mid-sentence');
  assert.equal(voiceActor.audience({ lullMs: 15_000 }), null);
  sessions.clear();
  sessions.set('g', fakeSession({ wordsAgo: 5_000, voicedAgo: 6_000 }));
  assert.ok(voiceActor.room().quietMs < 6_000, 'a line 5 s ago');
  assert.equal(voiceActor.audience({ lullMs: 15_000 }), null);
  sessions.clear();
});

// Nov 11: friend_16 was mid-explanation, stopping to think between phrases, and James's unprompted question went
// out over him: nothing had been transcribed for half a minute, and the pauses were longer than "talking now".
test('someone who has started a line and paused to think is not a lull', () => {
  sessions.clear();
  const s = fakeSession({ wordsAgo: 40_000, voicedAgo: 3_000 });
  s.voicedOpen = new Map([['u-owner', Date.now() - 3_000]]);
  s.midTurn = (t = Date.now()) => [...s.voicedOpen.values()].some((at) => t - at < 8000);
  sessions.set('g', s);
  assert.equal(voiceActor.room().quietMs, 0);
  assert.equal(voiceActor.audience({ lullMs: 15_000 }), null);
  s.voicedOpen.clear(); // the line ended (it gets transcribed and answered the usual way)
  assert.ok(voiceActor.audience({ lullMs: 15_000 }));
  sessions.clear();
});

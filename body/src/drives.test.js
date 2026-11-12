import test from 'node:test';
import assert from 'node:assert/strict';
import { rudeness, isYelling, feed, fadeFed, resilience, coreSelfBlock } from './drives.js';

const INTERESTS = ['How do sourdough starters stay alive over winter?', 'How do lighthouses keep their lenses clean?'];
import { selectResearch } from './research-policy.js';

const now = 1_000_000_000_000;

test('rudeness: name-calling and yelling, but not corrections or short caps', () => {
  assert.equal(rudeness("you're so stupid"), 'name-calling');
  assert.equal(rudeness('fuck off amy'), 'name-calling');
  assert.equal(rudeness('WHY DID YOU DO THAT AGAIN'), 'yelling');
  assert.equal(rudeness("no, that's not right, it's the other file"), null);
  assert.equal(rudeness('LOL OK'), null);
  assert.equal(isYelling('I said NO and meant it'), false);
});

test('being fed holds without a clock and slows the slow pressures', () => {
  let fed = feed({}, 'learning', 0.5, now);
  fed = feed(fed, 'connection', 1, now);
  assert.ok(resilience(fed).boredom < 1 && resilience(fed).boredom >= 0.6);
  assert.equal(resilience(fed).loneliness, 0.6);
  assert.equal(resilience({}).usefulness, 1);
  const later = fadeFed(fed, now + 30 * 24 * 3600_000);
  assert.equal(later.learning.value, 0.5);
});

test('core self carries compass and pushback, and a fresh boundary', () => {
  const block = coreSelfBlock({ boundary: { kind: 'name-calling', name: 'Sam', at: now - 60_000 }, now });
  assert.match(block, /Ten Commandments/);
  assert.match(block, /not a pushover/);
  assert.match(block, /Sam was calling you names/);
  assert.doesNotMatch(coreSelfBlock({ boundary: { kind: 'yelling', at: now - 3600_000 }, now }), /yelling/);
});

test('boredom with nothing asked falls back to her own interests, without repeating one', () => {
  const first = selectResearch({ now, interests: INTERESTS });
  assert.equal(first.selected.kind, 'interest');
  const next = selectResearch({ now, interests: INTERESTS, attempts: [{ key: first.selected.key, at: now }] });
  assert.notEqual(next.selected.key, first.selected.key);
  const asked = selectResearch({ now, interests: INTERESTS, questions: [{ text: 'How does SQLite WAL recovery work?', at: now }] });
  assert.equal(asked.selected.kind, 'question');
});

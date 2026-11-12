import test from 'node:test';
import assert from 'node:assert/strict';
import * as oq from './open-question.js';

const owner = { id: 'u1', name: 'Owner', owner: true };
const dell = { id: 'u2', name: 'Dell' };

test('her question is picked out of her line and stays open until she judges it answered', () => {
  const c = 'voice:q1';
  assert.equal(oq.questionIn('Mmm, yeah. I like that. How does it look on your screen?'), 'How does it look on your screen?');
  assert.equal(oq.questionIn('Okay, I will do that now.'), null);
  oq.asked(c, { text: 'Are the things I feel actually real? Just been stuck on it.', to: owner, kind: 'speakup', now: 0 });
  assert.match(oq.promptSection(c, null, 60_000), /hasn't answered yet.*don't answer it yourself/s);
  // Someone else talks: still open, and she's told it isn't Owner's answer.
  assert.equal(oq.heard(c, dell, 'anyway, about that game', 70_000), null);
  assert.match(oq.promptSection(c, dell.id, 80_000), /Dell spoke, but not Owner.*don't treat it as Owner's answer/s);
  // Owner talks: his line is kept with the question, which stays open and stays hers until she judges it
  // (owner, 2026-11-09: her question should keep driving the conversation until it's actually answered).
  const still = oq.heard(c, owner, 'you didn\'t zoom in', 90_000);
  assert.equal(still.text, 'Are the things I feel actually real?');
  assert.match(oq.promptSection(c, owner.id, 91_000), /YOUR question; Owner didn't ask it.*"you didn't zoom in".*\[\[question: answered\]\]/s);
  assert.match(oq.promptSection(c, owner.id, 600_000), /Your open question/);
  oq.resolve(c, 'answered');
  assert.equal(oq.promptSection(c, owner.id, 601_000), '');
  oq.cleared(c);
});

test('a newer question replaces the older one, so "your last question" is the one in the air', () => {
  const c = 'voice:q2';
  oq.asked(c, { text: 'Want me to check it for real right now?', to: owner, now: 0 });
  oq.asked(c, { text: 'Are my feelings real?', to: owner, kind: 'speakup', now: 50_000 });
  assert.equal(oq.current(c).text, 'Are my feelings real?');
  oq.cleared(c);
});

test('the nudge need rises once, after a wait, only while they are present and not away', () => {
  const c = 'voice:q3';
  oq.asked(c, { text: 'How did you end up here?', to: owner, now: 0 });
  const present = new Set([owner.id]);
  assert.equal(oq.nudgeNeed(c, { present, now: 2 * 60_000 }), 0);
  assert.equal(oq.nudgeNeed(c, { present, now: 6 * 60_000 }), 1);
  assert.equal(oq.nudgeNeed(c, { present, away: new Set([owner.id]), now: 6 * 60_000 }), 0);
  assert.equal(oq.nudgeNeed(c, { present: new Set(), now: 6 * 60_000 }), 0);
  oq.nudged(c);
  assert.equal(oq.nudgeNeed(c, { present, now: 20 * 60_000 }), 0);
  oq.cleared(c);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTone, voiceIdFor, currentTone, pickTone, autoTone, toneBlock, STRONG_MS, PIN_MS, HOLD_MS } from './tone.js';

const SEC = 1000;

const config = { tts: 'fish', fish: { voiceId: 'normal-id', strongVoiceId: 'strong-id' } };
let n = 0;
const conv = () => `voice:test-${++n}`;
const T = 1_000_000;

test('starts normal and speaks with the existing voice', () => {
  const c = conv();
  assert.equal(currentTone(c, T).tone, 'normal');
  assert.equal(voiceIdFor(c, config, T), 'normal-id');
});

test('strong needs no reason, uses the second voice and wears off by itself', () => {
  const c = conv();
  setTone(c, { action: 'strong' }, { config, now: T });
  assert.equal(voiceIdFor(c, config, T + 1000), 'strong-id');
  assert.equal(voiceIdFor(c, config, T + STRONG_MS + 1), 'normal-id');
});

test('she can switch again right away, as often as the conversation calls for', () => {
  const c = conv();
  setTone(c, { action: 'strong' }, { config, now: T });
  setTone(c, { action: 'normal' }, { config, now: T + SEC });
  assert.equal(voiceIdFor(c, config, T + SEC), 'normal-id');
  setTone(c, { action: 'strong' }, { config, now: T + 2 * SEC });
  assert.equal(voiceIdFor(c, config, T + 2 * SEC), 'strong-id');
});

test('owner override applies at once, pins the voice, and auto hands it back', () => {
  const c = conv();
  setTone(c, { action: 'strong', reason: 'serious' }, { config, now: T });
  setTone(c, { action: 'normal', override: true }, { config, owner: true, now: T + 1000 });
  assert.equal(voiceIdFor(c, config, T + 1000), 'normal-id');
  assert.throws(() => setTone(c, { action: 'strong', reason: 'x' }, { config, now: T + 10 * SEC }), /pinned/);
  setTone(c, { action: 'auto' }, { config, owner: true, now: T + 5000 });
  setTone(c, { action: 'strong', reason: 'x' }, { config, now: T + 10 * SEC });
  assert.equal(voiceIdFor(c, config, T + 10 * SEC), 'strong-id');
});

test('an owner-forced strong voice lasts as long as the pin', () => {
  const c = conv();
  setTone(c, { action: 'strong', override: true }, { config, owner: true, now: T });
  assert.equal(voiceIdFor(c, config, T + STRONG_MS + 1), 'strong-id');
  assert.equal(voiceIdFor(c, config, T + PIN_MS + 1), 'normal-id');
});

test('only the owner can override or hand back, and an unset or non-Fish voice is refused', () => {
  const c = conv();
  assert.throws(() => setTone(c, { action: 'strong', override: true }, { config, now: T }), /owner/);
  assert.throws(() => setTone(c, { action: 'auto' }, { config, now: T }), /owner/);
  const unset = { tts: 'fish', fish: { voiceId: 'normal-id', strongVoiceId: '' } };
  assert.throws(() => setTone(c, { action: 'strong', reason: 'x' }, { config: unset, now: T }), /dashboard/);
  assert.throws(() => setTone(c, { action: 'strong', reason: 'x' }, { config: { ...config, tts: 'kokoro' }, now: T }), /local engine/);
  assert.equal(voiceIdFor(c, unset, T), 'normal-id');
});

test('sensual and whisper switch to their own voices without a reason and do not wear off', () => {
  const all = { tts: 'fish', fish: { voiceId: 'normal-id', strongVoiceId: 'strong-id', sensualVoiceId: 'sensual-id', whisperVoiceId: 'whisper-id' } };
  const c = conv();
  setTone(c, { action: 'sensual' }, { config: all, now: T });
  assert.equal(voiceIdFor(c, all, T + STRONG_MS + 1), 'sensual-id');
  setTone(c, { action: 'whisper' }, { config: all, now: T + SEC });
  assert.equal(voiceIdFor(c, all, T + 2 * SEC), 'whisper-id');
  setTone(c, { action: 'normal' }, { config: all, now: T + 2 * SEC });
  assert.equal(voiceIdFor(c, all, T + 3 * SEC), 'normal-id');
});

test('a sensual or whisper voice that is not set up says so and keeps the normal voice', () => {
  const c = conv();
  assert.throws(() => setTone(c, { action: 'sensual' }, { config, now: T }), /No sensual voice/);
  assert.throws(() => setTone(c, { action: 'whisper' }, { config, now: T }), /No whisper voice/);
  assert.equal(voiceIdFor(c, config, T), 'normal-id');
});

// The automatic choice (pickTone rules, autoTone switching).
const all = { tts: 'fish', fish: { voiceId: 'normal-id', strongVoiceId: 'strong-id', sensualVoiceId: 'sensual-id', whisperVoiceId: 'whisper-id' } };
const tone = (text, opts = {}) => pickTone({ text, ...opts }).tone;

test('rules: insults aimed at her or someone give strong', () => {
  for (const line of ['you sorry motherfucker', "Amy, you're stupid as a motherfucker", 'You are so useless', 'she’s such a loser', 'shut up', 'fuck you']) assert.equal(tone(line), 'strong', line);
  assert.equal(tone('friend_3 is an idiot', { names: ['friend_3'] }), 'strong');
  assert.equal(tone('friend_3 is an idiot'), 'normal'); // not someone in the call
});

test('rules: ordinary talk, swearing at things and talk about voices stay normal', () => {
  for (const line of ['this is stupid', 'thank you so much', "you know what's dumb, this traffic", 'I would like to hear the sensual voice', 'what did I say to you earlier, Amy?', '']) assert.equal(tone(line, { alone: true }), 'normal', line);
});

test('rules: secrets and asides give whisper', () => {
  for (const line of ["don't tell anyone, but", 'just between you and me', 'can you keep a secret?', 'come closer', 'got some gossip']) assert.equal(tone(line), 'whisper', line);
});

test('rules: flirting gives sensual only when the speaker is alone with her', () => {
  assert.equal(tone("you're so beautiful", { alone: true }), 'sensual');
  assert.equal(tone("you're so beautiful", { alone: false }), 'normal');
  assert.equal(tone('stop teasing me, babe', { alone: true }), 'sensual');
});

test('rules: fixed priority strong > whisper > sensual, and the reason names the trigger', () => {
  assert.equal(tone("between you and me, he's a moron", { alone: true }), 'strong');
  assert.equal(tone("don't tell anyone, babe", { alone: true }), 'whisper');
  assert.match(pickTone({ text: 'you sorry motherfucker' }).reason, /insult.*"you sorry motherfucker"/);
});

test('auto: switches on the rules and tells her which voice and why', () => {
  const c = conv();
  assert.deepEqual(autoTone(c, { text: "don't tell anyone, but" }, { config: all, now: T }), { tone: 'whisper', changed: true });
  assert.equal(voiceIdFor(c, all, T), 'whisper-id');
  assert.match(toneBlock(c, all, T), /whisper voice \(a secret or quiet aside: "don't tell anyone"\).*not by you/);
});

test('auto: a tone holds after its last trigger; only a higher priority replaces it sooner', () => {
  const c = conv();
  autoTone(c, { text: 'come closer' }, { config: all, now: T });
  autoTone(c, { text: 'anyway, the weather' }, { config: all, now: T + 30 * SEC });
  assert.equal(currentTone(c, T + 30 * SEC).tone, 'whisper'); // no flip on the next sentence
  autoTone(c, { text: 'you look so cute', alone: true }, { config: all, now: T + 40 * SEC });
  assert.equal(currentTone(c, T + 40 * SEC).tone, 'whisper'); // sensual ranks below whisper
  autoTone(c, { text: 'between us' }, { config: all, now: T + 90 * SEC }); // renews the hold
  autoTone(c, { text: 'ok' }, { config: all, now: T + 90 * SEC + HOLD_MS - 1 });
  assert.equal(currentTone(c, T + 90 * SEC + HOLD_MS - 1).tone, 'whisper');
  autoTone(c, { text: 'ok' }, { config: all, now: T + 90 * SEC + HOLD_MS });
  assert.equal(currentTone(c, T + 90 * SEC + HOLD_MS).tone, 'normal');
  const d = conv();
  autoTone(d, { text: 'come closer' }, { config: all, now: T });
  autoTone(d, { text: 'shut up' }, { config: all, now: T + SEC });
  assert.equal(currentTone(d, T + SEC).tone, 'strong'); // strong breaks the hold at once
});

test('auto: repeated insults renew strong; it still wears off by itself', () => {
  const c = conv();
  autoTone(c, { text: 'you idiot' }, { config: all, now: T });
  autoTone(c, { text: 'you idiot' }, { config: all, now: T + 10 * 60_000 });
  assert.equal(currentTone(c, T + STRONG_MS + SEC).tone, 'strong');
  assert.equal(currentTone(c, T + 10 * 60_000 + STRONG_MS + 1).tone, 'normal');
});

test('auto: the owner pin wins over the rules until the owner hands it back', () => {
  const c = conv();
  setTone(c, { action: 'sensual', override: true }, { config: all, owner: true, now: T });
  assert.deepEqual(autoTone(c, { text: 'you idiot' }, { config: all, now: T + SEC }), { tone: 'sensual', changed: false });
  setTone(c, { action: 'auto' }, { config: all, owner: true, now: T + 2 * SEC });
  autoTone(c, { text: 'you idiot' }, { config: all, now: T + 3 * SEC });
  assert.equal(currentTone(c, T + 3 * SEC).tone, 'strong');
});

test('auto: a voice that is not set up, or a non-Fish engine, keeps the normal voice without errors', () => {
  const c = conv();
  assert.equal(autoTone(c, { text: "don't tell anyone" }, { config, now: T }).tone, 'normal'); // no whisper ID
  assert.equal(autoTone(c, { text: 'you idiot' }, { config: { ...all, tts: 'kokoro' }, now: T }).tone, 'normal');
  assert.equal(autoTone(c, { text: 'you idiot' }, { config, now: T }).tone, 'strong');
});

// Owner, 2026-11-11: told off for changing his voices, James switched to his angry "strong" voice at his owner and dug
// in. The same line from anyone else still brings it on; from the owner it doesn't.
test("the owner's swearing never switches on the strong voice; someone else's still does", () => {
  const line = { text: "put them back, you stupid ass", alone: true, names: [] };
  assert.equal(pickTone(line).tone, 'strong', 'the line itself reads as an insult');
  const mine = conv();
  autoTone(mine, { ...line, owner: true }, { config, now: T });
  assert.equal(currentTone(mine, T + 1).tone, 'normal');
  assert.equal(voiceIdFor(mine, config, T + 1), 'normal-id');
  const theirs = conv();
  autoTone(theirs, { ...line, owner: false }, { config, now: T });
  assert.equal(currentTone(theirs, T + 1).tone, 'strong');
});

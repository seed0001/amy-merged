import test from 'node:test';
import assert from 'node:assert/strict';
import { config, wordList } from '../config.js';
import { saidToMe, answersLine, wakeFollowUp } from './addressed.js';

const set = (everyone, owner) => { config.voice.wakeWords = wordList(everyone); config.voice.ownerWakeWords = wordList(owner); };
const floorYes = async () => true;
const floorNever = async () => { throw new Error('the floor must not be asked when free talk is off'); };

test('the wake-only follow-up is coalescible, but a new request or confirmation is its own turn', () => {
  set('', 'boss lady');
  assert.equal(wakeFollowUp(`I said, ${config.botName}. Okay, thank you.`), true);
  assert.equal(wakeFollowUp('Hey, boss lady.'), true);
  assert.equal(wakeFollowUp(`${config.botName}. Open a new tab.`), false);
  assert.equal(wakeFollowUp(`${config.botName}, go ahead.`), false);
});

// What Owner hit: no wake words set, free talk turned off, and she still answered every line.
test('free talk off with no wake words: a line without her name is only heard', async () => {
  set('', '');
  const named = saidToMe("All right, well, let's test this out, if you're going to reply to this.", { owner: true });
  assert.equal(named, false);
  assert.equal(await answersLine({ named, freeTalk: false, floorMine: floorNever }), false);
});

test('free talk off: her name (or a wake word that counts for the speaker) still gets an answer', async () => {
  set('', '');
  assert.equal(saidToMe(`${config.botName}, what do you think?`, { owner: false }), true);
  assert.equal(await answersLine({ named: true, freeTalk: false, floorMine: floorNever }), true);
  set('hey there', 'boss lady');
  assert.equal(saidToMe('hey there, got a minute', { owner: false }), true);
  assert.equal(saidToMe('boss lady, play something', { owner: true }), true);
  assert.equal(saidToMe('boss lady, play something', { owner: false }), false, "his words are just talk from anyone else");
  assert.equal(await answersLine({ named: false, freeTalk: false, floorMine: floorNever }), false);
});

test('free talk on: a line nobody named her in is hers when the floor says so', async () => {
  set('', '');
  const named = saidToMe('so what should we do about dinner', { owner: true });
  assert.equal(named, false);
  assert.equal(await answersLine({ named, freeTalk: true, floorMine: floorYes }), true);
  assert.equal(await answersLine({ named, freeTalk: true, floorMine: async () => false }), false, 'another companion holds the floor');
});

test('another companion: only her name calls her; a claimed bot turn always answers', async () => {
  set('hey there', '');
  assert.equal(saidToMe('hey there, Amy', { peer: true, peerNamedMe: false }), false, 'wake words are for people');
  assert.equal(saidToMe('what do you think', { peer: true, peerNamedMe: true }), true);
  assert.equal(await answersLine({ peerTurn: { id: 't1' }, named: false, freeTalk: false, floorMine: floorNever }), true);
});

// The whole table, so the code and what her prompt says about it (awareness.js voiceRulesBlock) can't drift apart.
// Rows: free talk × wake words set × her name in the line × who said it. floorYes/floorNo stand for the floor.
test('truth table: when a voice line is hers', async () => {
  const line = (named) => (named ? `${config.botName}, are you there` : 'so anyway I was thinking about dinner');
  const rows = [
    // free, words,      named, who,      floor,     answers
    [false, '',          false, 'owner',  floorNever, false],
    [false, '',          false, 'other',  floorNever, false],
    [false, '',          true,  'owner',  floorNever, true],
    [false, '',          true,  'other',  floorNever, true],
    [false, 'hey there', false, 'owner',  floorNever, false],
    [false, 'hey there', true,  'other',  floorNever, true],
    [true,  '',          false, 'owner',  floorYes,   true],
    [true,  '',          false, 'other',  floorYes,   true],
    [true,  '',          false, 'owner',  async () => false, false],
    [true,  'hey there', false, 'other',  async () => false, false],
    [true,  'hey there', true,  'other',  floorNever, true],
  ];
  for (const [free, words, isNamed, who, floorMine, expected] of rows) {
    set(words, '');
    const named = saidToMe(line(isNamed), { owner: who === 'owner' });
    assert.equal(named, isNamed, `named: free=${free} words="${words}" named=${isNamed} ${who}`);
    assert.equal(await answersLine({ named, freeTalk: free, floorMine }), expected, `answers: free=${free} words="${words}" named=${isNamed} ${who}`);
  }
});

test('truth table: wake words only add ways to call her; they never silence her name', async () => {
  set('hey there', 'boss lady');
  for (const free of [false, true]) {
    assert.equal(await answersLine({ named: saidToMe(`${config.botName} come here`, { owner: false }), freeTalk: free, floorMine: floorNever }), true, 'her name, from anyone');
    assert.equal(await answersLine({ named: saidToMe('hey there, come here', { owner: false }), freeTalk: free, floorMine: floorNever }), true, 'an everyone word, from anyone');
    assert.equal(await answersLine({ named: saidToMe('boss lady, come here', { owner: true }), freeTalk: free, floorMine: floorNever }), true, "his word, from him");
  }
  assert.equal(await answersLine({ named: saidToMe('boss lady, come here', { owner: false }), freeTalk: false, floorMine: floorNever }), false, 'his word from someone else is just talk');
  assert.equal(await answersLine({ named: saidToMe('come here', { owner: true }), freeTalk: false, floorMine: floorNever }), false, 'words set, free talk off, nobody called her: only heard');
});

// Owner, 2026-11-09: after a full reset, until her wake words are set up, she answers every person's line.
test('freshly reset with no wake words set up: every line is hers, whatever free talk says', async () => {
  set('', '');
  const named = saidToMe('so anyway I was thinking about dinner', { owner: false });
  assert.equal(named, false);
  for (const free of [false, true]) {
    assert.equal(await answersLine({ named, freeTalk: free, setupOpen: true, floorMine: async () => false }), true, `free talk ${free}`);
  }
  assert.equal(await answersLine({ named, freeTalk: false, setupOpen: false, floorMine: floorNever }), false, 'once set up, the usual rules again');
});

test('truth table: another companion', async () => {
  set('hey there', 'boss lady');
  // Free talk off: only its naming her, and the budget giving her the turn (peerTurn), make its line hers.
  assert.equal(saidToMe(`hey there boss lady`, { peer: true, peerNamedMe: false }), false, 'no wake word works for a bot');
  assert.equal(await answersLine({ peerTurn: null, named: true, freeTalk: false, floorMine: floorNever }), true, 'it said her name');
  assert.equal(await answersLine({ peerTurn: null, named: false, freeTalk: false, floorMine: floorNever }), false);
  // Free talk on: a claimed turn answers even without her name; without a turn the floor decides.
  assert.equal(await answersLine({ peerTurn: { id: 't2' }, named: false, freeTalk: true, floorMine: floorNever }), true);
  assert.equal(await answersLine({ peerTurn: null, named: false, freeTalk: true, floorMine: async () => false }), false);
});

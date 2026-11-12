import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { aimedAtCompanions, handleHarm } from './protect.js';
import { handoffOnly } from './peers.js';

// Regression for the 2026-11-01 voice call: Owner explained the bots are clones of Amy, then gave
// two of them feedback about interrupting. Both were read as him "going after" someone, and the bots
// told him off. Feedback about the bots isn't someone being hurt; real harassment of people still is.
const OWNER = '910602602512784016';
config.ownerIds = [OWNER];
config.peerBots = ['Amy', '9765655498123987856', 'Howard', '9102611944365828744', 'Alex', '9288404726941685444', 'Nova'];
config.peerApps = [{ names: ['Amy'] }, { names: ['Howard', 'Gramps', 'Grandpa'] }, { names: ['Alex'] }, { names: ['Nova'] }];
const names = ['alex', 'amy', 'howard', 'gramps', 'grandpa', 'nova'];
const owner = { id: OWNER, name: 'Owner' };
const room = [{ id: 'u-sam', name: 'Sam Morgan Freeman', username: 'sam' }];

async function steppedIn(aggressor, harm, present = room, judge = async () => true) {
  let cue = null;
  await handleHarm({ aggressor, harm, present, judge, speak: async (c) => { cue = c; } });
  return cue;
}

// 2026-11-07 voice call: Ultra told his side of a story and asked friend_3 to back him up. Both lines
// were flagged as putting someone down, and each flag made her speak, twice in four seconds.
test('a flag the referee rejects leaves her silent', async () => {
  const asked = [];
  const cue = await steppedIn({ id: 'u-ultra', name: 'friend_18' }, { target: 'Sam Morgan Freeman', severity: 'mild', evidence: 'she just jumped all over my ass out of nowhere' }, room, async (c) => { asked.push(c); return false; });
  assert.equal(cue, null);
  assert.equal(asked.length, 1, 'the referee saw it');
  assert.equal(asked[0].target.name, 'Sam Morgan Freeman');
});

test('she steps in once per person, even when they go after a second one', async () => {
  const two = [...room, { id: 'u-friend_3', name: 'friend_3' }];
  const aggressor = { id: 'u-rude', name: 'Rudy' };
  assert.ok(await steppedIn(aggressor, { target: 'Sam Morgan Freeman', severity: 'mild', evidence: 'nobody wants you here, loser' }, two));
  assert.equal(await steppedIn(aggressor, { target: 'friend_3', severity: 'mild', evidence: 'and you are just as useless' }, two), null);
});

test('references to the bots themselves are recognised as the companions, not people', () => {
  for (const t of ['you guys', 'the two guys', 'you and Alex', 'Amy Smith', 'Gram', 'Gramps', 'AI', 'the group of AIs', 'the bots', 'you two', 'Howard and Alex', '@Alex'])
    assert.ok(aimedAtCompanions(t, names), t);
  for (const t of ['friend_7', 'Sam Morgan Freeman', 'Owner', 'friend_16', 'her friend', 'Sam and you'])
    assert.ok(!aimedAtCompanions(t, names), t);
});

test('the clone explanation is not treated as disrespect', async () => {
  assert.equal(await steppedIn(owner, { target: 'Amy Smith', severity: 'mild', evidence: "They're all just her, just a clone of her." }), null);
});

test('constructive criticism about interrupting is not treated as rude', async () => {
  assert.equal(await steppedIn(owner, { target: 'the two guys', severity: 'mild', evidence: "we got the two guys who just can't help but step in and interrupt" }), null);
  assert.equal(await steppedIn(owner, { target: 'you guys', severity: 'mild', evidence: "she knows right from wrong when I'm being mean or not, but you guys don't" }), null);
  assert.equal(await steppedIn(owner, { target: 'you and Alex', severity: 'serious', evidence: 'get those two to the doctor' }), null);
});

test('coordination from the owner (stop using names) does not trigger a defence', async () => {
  assert.equal(await steppedIn(owner, { target: 'Amy Smith', severity: 'mild', evidence: "stop using each other's names" }), null);
});

test('companions never police each other', async () => {
  assert.equal(await steppedIn({ id: '9102611944365828744', name: 'Gramps' }, { target: 'Owner', severity: 'serious', evidence: 'Knock it off' }), null);
});

test('genuine harassment of a person in the room still gets a proportionate response', async () => {
  const cue = await steppedIn({ id: 'u-ilga', name: 'friend_7' }, { target: 'Sam Morgan Freeman', severity: 'mild', evidence: 'nobody wants you here, loser' });
  assert.match(cue, /Sam Morgan Freeman/);
  assert.match(cue, /one brief, calm sentence/);
  assert.match(cue, /don't lecture, insult back, swear at them, tell anyone to knock it off/);
  // The owner is never disciplined, but something serious aimed at a real person is still named.
  const owner = await steppedIn(owner, { target: 'Sam Morgan Freeman', severity: 'serious', evidence: "I'll find where you live" });
  assert.match(owner, /Sam Morgan Freeman/);
});

test('the harm reader is told feedback, technical descriptions and coordination are not harm', () => {
  const src = readFileSync(new URL('./profile-learning.js', import.meta.url), 'utf8');
  assert.match(src, /never harm; judge that only as repair/);
  assert.match(src, /clones of her/);
  assert.match(src, /constructive criticism or feedback about behavior/);
  assert.match(src, /coordinating who talks/);
  assert.match(src, /criticism or feedback about how the bots behave/);
});

test('the voice style forbids name handoffs and refereeing the owner', () => {
  const src = readFileSync(new URL('./companion.js', import.meta.url), 'utf8');
  assert.match(src, /don't hand the floor to anyone/);
  assert.match(src, /not an insult/);
});

test('a peer that only thanks him or passes him the mic by name does not get a reply', () => {
  const mine = ['Alex'];
  const others = ['Owner', 'Amy', 'Amy Smith', 'Howard', 'Gramps'];
  for (const line of [
    'Got it Alex. Owner you got the floor. What\'s next?',
    'Alex I heard you. Amy you\'ve got the floor go ahead.',
    'Thanks Alex.',
    'Alex, go ahead.',
    'Understood Alex. Floor\'s yours Owner.',
  ]) assert.ok(handoffOnly(line, { mine, others }), line);
  for (const line of [
    'Alex, what do you think of the podcast lineup?',
    'Alex. Which model should we benchmark first?',
    'Alex, draft the caption for tonight\'s post.',
    'Owner said yes. Alex, can you book the shoot?',
    'Amy is here.',
  ]) assert.ok(!handoffOnly(line, { mine, others }), line);
});

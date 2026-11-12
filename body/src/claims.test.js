import test from 'node:test';
import assert from 'node:assert/strict';
import { phantomClaim, phantomReason, phantomText, retractsDone, doing } from './claims.js';

test('a free talk status report uses live state and a change needs a matching tool action', () => {
  const none = new Map();
  assert.equal(phantomClaim('Free talk is on.', none, { freeTalk: true }), null);
  assert.deepEqual(phantomClaim('Free talk is off.', none, { freeTalk: true }), {
    tool: 'free_talk', claim: 'Free talk is off', currentState: 'on',
  });
  assert.equal(phantomClaim("Free talk isn't on.", none, { freeTalk: true }).currentState, 'on');
  assert.equal(phantomClaim('Free talk is listed as on.', none, { freeTalk: true }), null);
  // A true statement of the state is never a phantom, whatever tools ran (she retracted a true one on 2026-11-09 02:21).
  assert.equal(phantomClaim('Free talk is now on.', none, { freeTalk: true }), null);
  assert.equal(phantomClaim('Free talk is now on.', new Map([['free_talk', true]]), { freeTalk: true }), null);
  assert.equal(phantomClaim('Free talk is now on.', new Map([['free_talk:on', true]]), { freeTalk: true }), null);
  // Claiming she flipped it still needs the call.
  assert.equal(phantomClaim('I turned free talk on.', none, { freeTalk: true }).tool, 'free_talk');
  assert.equal(phantomClaim('I turned free talk on.', new Map([['free_talk', true]]), { freeTalk: true }), null);
});

test('bringing up the browser is not a claim about another companion', () => {
  assert.equal(phantomClaim('I brought my browser up.', new Map([['browser', true]])), null);
  assert.equal(phantomClaim('I brought my browser up.', new Map()).tool, 'browser');
  assert.equal(phantomClaim('I brought Mateo in.', new Map()).tool, 'bring_peer');
});
import { visitResult } from './doctor.js';

const none = new Map();
const ok = (...tools) => new Map(tools.map((t) => [t, true]));

test('her own unbacked claim is still caught', () => {
  assert.equal(phantomClaim("Done, I've sent it to you.", none).tool, 'send_file');
  assert.equal(phantomClaim('Sent you the file just now.', none).tool, 'send_file');
  assert.equal(phantomClaim('Alright, it’s playing now.', none).tool, 'music');
  assert.equal(phantomClaim("I've sent it.", new Map([['send_file', true]])), null);
});

test('"it\'s playing" after her own instrument played is true, not a phantom', () => {
  assert.equal(phantomClaim("It's playing — \"Tinkering with the Unfixed Gears\" on the piano.", new Map([['instrument', true]])), null);
  assert.equal(phantomClaim("It's playing now.", new Map([['instrument', false]])).tool, 'music', 'a failed instrument call backs nothing');
});

test('reporting an error or someone else doing it is not a claim', () => {
  // From her logs: each of these got a canned "correction: that didn't go through" tacked on.
  assert.equal(phantomClaim("The picture didn't go through, the image tool rejected the request. I haven't sent you a pic.", none), null);
  assert.equal(phantomClaim('friend_18 sent you a zip of the Tiny Model Maker source around 3:50 PM.', none), null);
  assert.equal(phantomClaim('The stuff Owner sent you in the DM should have the exact commands.', none), null);
  assert.equal(phantomClaim("Sorry, I couldn't get it posted, so nothing went to #general.", none), null);
});

test("the doctor's work counts only when its ok result is on record", () => {
  const line = 'The doctor updated the code and the file has been updated.';
  assert.equal(phantomClaim(line, none).tool, 'files');
  assert.equal(phantomClaim(line, none, { doctorOk: true }), null);
  // A doctor call that succeeded this very turn is on record too.
  assert.equal(phantomClaim(line, ok('doctor')), null);
});

// 2026-11-08 22:04: the hands called doctor (action call), it returned ok, and she said this. "sent it"
// matched send_file, no send_file had run, and she was made to say "I didn't actually send anything to
// the doctor". A real action became a lie.
test('today: "sent it to the doctor" after a real doctor call is not a send_file claim', () => {
  const reply = "Mmm, I hear you.\n\nI just sent it to the doctor for real this time. He's looking at why free talk isn't staying off when you tell it to. He'll fix it and report back when he's done.\n\nHow's that feel?";
  assert.equal(phantomClaim(reply, ok('guide', 'doctor')), null);
  // Per-sentence, as voice checks it before speaking.
  assert.equal(phantomClaim('I just sent it to the doctor for real this time.', ok('doctor')), null);
  // Without the doctor call it is still a claim, and still send_file.
  assert.equal(phantomClaim(reply, ok('guide')).tool, 'send_file');
});

// 2026-11-08 21:35: a real doctor status check, then "I'm sorry. I thought I sent" ("I sent" in a
// hedge). Rewritten to "I didn't actually check the doctor just now", which was false.
test('today: "I thought I sent" after a real doctor status check is not a claim', () => {
  const reply = "Yeah, I just checked on the backup doctor for you.\n\nHe's not working on anything right now and hasn't been called since startup. So that request never actually got to him.\n\nI'm sorry. I thought I sent it over earlier.";
  assert.equal(phantomClaim(reply, ok('doctor')), null);
  // The hedge alone is enough: a belief about an action is not a claim it happened.
  assert.equal(phantomClaim('I thought I sent it to you.', none), null);
  assert.equal(phantomClaim('I meant to post it in #general.', none), null);
});

test('relay verbs aimed at the doctor or another bot are satisfied by relay tools', () => {
  assert.equal(phantomClaim('I told the doctor to look at the free talk switch.', ok('doctor')), null);
  assert.equal(phantomClaim("I've sent her out of the call.", ok('bot_control')), null);
  assert.equal(phantomClaim('Just brought Ultra in.', ok('bring_peer')), null);
  // Aimed at the owner himself, it is still a file claim even when the doctor ran.
  assert.equal(phantomClaim("I've sent it to you.", ok('doctor')).tool, 'send_file');
  assert.equal(phantomClaim("I've sent you the file.", ok('doctor')).tool, 'send_file');
  // Without the relay tool it is still caught (send_file's "I've sent" is checked first; either way unbacked).
  assert.ok(phantomClaim("I've sent her out of the call.", none));
  assert.equal(phantomClaim("She's heading out now.", none).tool, 'bot_control');
});

test('a sentence about a tool that did succeed is never a phantom for another tool', () => {
  // "free talk is now off" is a free_talk claim, backed; the file wording in the same sentence is not a files claim.
  assert.equal(phantomClaim('Free talk is now off, I updated the config for you.', ok('free_talk')), null);
  assert.equal(phantomClaim('I updated the config for you.', ok('free_talk')).tool, 'files');
  assert.equal(phantomClaim('Avatar view: I zoomed in and saved the file.', ok('avatar_view')), null);
});

test('a correction that takes back a real success is caught', () => {
  // Today's two rewrites, with the doctor call that really succeeded that turn.
  assert.equal(retractsDone("Mmm, I fucked up again.\n\nI didn't actually send anything to the doctor. I just said I did.", ok('doctor')), true);
  assert.equal(retractsDone("Owner, I fucked up.\n\nI didn't actually check the doctor just now. I said I did but the tool didn't fire.", ok('doctor')), true);
  assert.equal(retractsDone("I didn't send the file; the upload failed.", ok('doctor')), false);
  assert.equal(retractsDone("I didn't actually send anything to the doctor.", none), false);
  assert.equal(retractsDone("Free talk didn't change, the switch failed.", ok('free_talk')), true);
  assert.equal(retractsDone("The doctor is on it and I'll report back.", ok('doctor')), false);
});

test('the reason a tool did not do it comes from its failed call this turn', () => {
  const calls = [
    { name: 'guide', result: '[guide: ok]\n## doctor' },
    { name: 'doctor', result: '[doctor: error failed] The doctor has been working on "free talk" for 0 minute(s). Wait for it to finish, or cancel it.\nhint: Read the message.' },
  ];
  const reason = phantomReason('doctor', calls);
  assert.equal(reason.code, 'failed');
  assert.match(reason.message, /^The doctor has been working on/);
  assert.equal(reason.source, 'this turn');
  assert.equal(phantomReason('send_file', calls), null);
  assert.equal(phantomReason('send_file', []), null);
});

test('the fallback says what did not happen and why, never a bare "I fucked up"', () => {
  const claim = { tool: 'send_file', claim: 'sent it' };
  const plain = phantomText(claim, null);
  assert.match(plain, /sending the file didn't happen/);
  assert.match(plain, /never actually made the send_file call/);
  const why = phantomText({ tool: 'doctor', claim: 'sent it to the doctor' }, { code: 'failed', message: 'The doctor has been working on "x" for 0 minute(s).' });
  assert.match(why, /the doctor call failed \(failed: The doctor has been working on "x" for 0 minute\(s\)\)/);
  assert.doesNotMatch(why, /fucked up/);
  assert.equal(doing('avatar_view'), 'the avatar view call');
});

test('a doctor visit becomes a verified history note', () => {
  assert.equal(visitResult({ title: 'fix waits', ok: true, changed: 'src/a.js', tests: 'pass' }), 'doctor fix waits: ok, tests pass');
  assert.equal(visitResult({ title: 'x', ok: false, changed: '', tests: 'not run' }), 'doctor x: failed, no files changed');
});

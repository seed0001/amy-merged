import test from 'node:test';
import assert from 'node:assert/strict';
import { config, wordList } from './config.js';
import { gated, wakeHeard, wakeHint, wakeLine } from './wake-words.js';
import { enabledTools, runTool } from './tools.js';

const set = (everyone, owner) => { config.voice.wakeWords = wordList(everyone); config.voice.ownerWakeWords = wordList(owner); };

test('everyone words wake her for anyone; the owner words only for the owner', () => {
  set('hey amy', 'boss lady');
  assert.equal(gated(), true);
  assert.equal(wakeHeard('hey amy, what time is it'), true);
  assert.equal(wakeHeard('boss lady, play something', { owner: true }), true);
  assert.equal(wakeHeard('boss lady, play something', { owner: false }), false, 'his words are just talk from anyone else');
  assert.equal(wakeHeard(`${config.botName}, you there?`), true, 'her name always works');
  assert.equal(wakeHeard('the amity park ride'), false, 'whole words only');
  assert.match(wakeHint(), /hey amy/);
  assert.doesNotMatch(wakeHint(), /boss lady/, 'his words are never handed out to newcomers');
  assert.match(wakeLine(), /only work when he says them\): "boss lady"/);
});

test('with no wake words at all only her name calls her; free talk decides the rest', () => {
  set('', '');
  assert.equal(gated(), false);
  assert.equal(wakeHeard('so anyway, like I was saying'), false, 'an empty list never makes every line hers');
  assert.equal(wakeHeard(`${config.botName}, you there?`), true, 'her name still works');
  assert.match(wakeLine(), /only your name calls you/);
  assert.doesNotMatch(wakeLine(), /answer everyone/);
  set('', 'boss lady');
  assert.equal(gated(), true, 'only his words set: everyone else uses her name');
});

test('she can show and change both lists, owner only, and a bad change says why', async () => {
  set('hey amy', '');
  const ctx = { perms: { owner: true }, speaker: { id: 'dashboard' }, userText: 'wake words', character: { id: 'main', main: true } };
  assert.ok(enabledTools(ctx).some((t) => t.function.name === 'wake_words'));
  assert.ok(!enabledTools({ ...ctx, perms: { owner: false }, speaker: { id: 'u-friend_3' } }).some((t) => t.function.name === 'wake_words'), 'not for anyone else');
  assert.match(await runTool('wake_words', { action: 'add', list: 'owner', words: 'boss lady, queen' }, ctx), /only work when he says them\): "boss lady", "queen"/);
  assert.deepEqual(config.voice.ownerWakeWords, ['boss lady', 'queen']);
  assert.match(await runTool('wake_words', { action: 'add', list: 'everyone', words: 'queen' }, ctx), /already in the owner list/);
  assert.match(await runTool('wake_words', { action: 'remove', list: 'everyone', words: 'nope' }, ctx), /isn't in the everyone list \(it has: hey amy\)/);
  await runTool('wake_words', { action: 'set', list: 'everyone', words: '' }, ctx);
  assert.deepEqual(config.voice.wakeWords, []);
});

// What her prompt tells her about her own voice behaviour must be what the code does (awareness.js), for
// the config as it is now: she stated free talk OFF as "I only answer when called" while answering everything.
test('her switches block states the real rules for the current config, never from memory', async () => {
  const { voiceRulesBlock, switchesBlock } = await import('./awareness.js');
  const was = config.voice.freeTalk;
  try {
    config.voice.freeTalk = false; set('', '');
    let t = voiceRulesBlock();
    assert.match(t, /Free talk is OFF and no wake words are set, so you answer ONLY lines that have your name/);
    assert.match(t, /Having no wake words set does NOT mean you answer everything/);
    assert.match(t, /free talk is already off, and he must not say "/, 'ramble hint fits the current state');
    assert.match(t, /no way to make you ignore other people saying your name/);
    assert.match(t, /wake_words, list owner/, 'offers him a private word when he has none');
    assert.match(t, /turn free talk on \(free_talk on\)/);
    assert.match(t, /"stop", "stop talking", "be quiet", "shut up", "enough", "give it a rest" or "leave me alone"/);
    assert.doesNotMatch(t, /answer everyone in voice/);

    set('hey there', 'boss lady');
    t = voiceRulesBlock();
    assert.match(t, /Free talk is OFF, so you answer ONLY lines that have your name "[^"]+" or a wake word that counts for the speaker \(anyone: "hey there"; .* only: "boss lady"\)/);
    assert.match(t, /His own wake words already work for him alone/);
    assert.match(t, /never removes your name, and it never silences you/);

    config.voice.freeTalk = true;
    t = voiceRulesBlock();
    assert.match(t, /Free talk is ON, so you answer every line that has your name/);
    assert.match(t, /when the floor is yours/);
    assert.match(t, /turn free talk off \(free_talk off\)/, 'ramble hint fits the current state');
    assert.match(t, /free talk is already on/);

    // The full block carries the rules and every voice switch, each with what it does NOT do.
    const block = switchesBlock({ tools: ['free_talk', 'wake_words'] });
    assert.match(block, /Free talk in voice: ON; you can change it \(free_talk\)/);
    assert.match(block, /never describe them from memory/);
    assert.match(block, /barge-in\): (ON|OFF):/);
    assert.match(block, /It does not decide which lines you answer/);
    assert.match(block, /Turn classifier: (on|off) \(a pass before a text reply/);
    assert.match(block, config.turnClassifierVoice ? /also runs before your spoken replies/ : /in voice this switch changes nothing/);
    assert.match(block, /Posting transcripts: (ON|OFF):/);
    assert.match(block, /it has no effect on what you answer/);
  } finally { config.voice.freeTalk = was; set('', ''); }
});

// Tools must not say "done" for things that didn't happen or can't be checked: an unknown avatar frame
// is refused with the real choices, a setting flip is read back before "done", a missed lookup is an
// error, and anything a page or recorder does on its own is reported as sent, not as seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool, toolFailed } from './tools.js';
import { avatarView, FRAMES } from './avatar-view.js';
import { config } from './config.js';

const owner = { perms: { owner: true }, speaker: { id: 'dashboard' }, userText: 'change it for me' };

test('avatar_view refuses a frame the viewer does not have and names the real ones', async () => {
  const before = avatarView.get();
  const result = await runTool('avatar_view', { action: 'set', scale: -1, zoom: -1, frame: 'hands' }, owner);
  assert.ok(toolFailed(result), result);
  assert.match(result, /no "hands" frame/);
  for (const name of Object.keys(FRAMES)) assert.match(result, new RegExp(name));
  assert.match(result, /nothing was changed/);
  assert.deepEqual(avatarView.get(), before);
});

test('avatar_view says what was set in words, whether anyone saw it, and that face is the tightest frame', async () => {
  const result = await runTool('avatar_view', { action: 'set', scale: -1, zoom: 4, frame: 'face' }, owner);
  assert.ok(!toolFailed(result), result);
  assert.match(result, /frame face \(head close-up/);
  assert.match(result, /zoom 4x/);
  assert.match(result, /No Studio page is open|Studio page/);
  assert.match(result, /for the eyes alone use the eyes frame/);
  const eyes = await runTool('avatar_view', { action: 'set', frame: 'eyes' }, owner);
  assert.match(eyes, /frame eyes \(eyes only/);
  assert.match(eyes, /tightest frame: just your eyes/);
  await runTool('avatar_view', { action: 'reset' }, owner);
});

test('avatar_view with nothing to change says so instead of ok', async () => {
  const result = await runTool('avatar_view', { action: 'set', scale: -1, zoom: -1, frame: '' }, owner);
  assert.ok(toolFailed(result), result);
  assert.match(result, /nothing to change/i);
});

test('avatar_view get describes the view and the frames that exist', async () => {
  const result = await runTool('avatar_view', { action: 'get' }, owner);
  assert.match(result, /Avatar view: frame body/);
  assert.match(result, /no eyes-only/);
});

test('avatar_appearance with every field empty is an error, and a saved change says whether a page saw it', async () => {
  const empty = await runTool('avatar_appearance', { action: 'set', hair: '', eyes: '', lipstick: '' }, owner);
  assert.ok(toolFailed(empty), empty);
  assert.match(empty, /nothing to change/i);
  const set = await runTool('avatar_appearance', { action: 'set', hair: 'auburn' }, owner);
  assert.ok(!toolFailed(set), set);
  const body = JSON.parse(set.split('\n').slice(1).join('\n'));
  assert.equal(body.saved, true);
  assert.match(body.delivery, /no avatar page is open|got the new colors live/);
  await runTool('avatar_appearance', { action: 'reset' }, owner);
});

test('guide with an unknown topic is an error, not an ok with nothing in it', async () => {
  const result = await runTool('guide', { topic: 'zzz-no-such-topic-zzz' }, { ...owner, perms: { owner: true } });
  assert.ok(toolFailed(result), result);
  assert.match(result, /no guide topic/);
});

test('read_source is an error when none of the files could be read', async () => {
  const result = await runTool('read_source', { paths: ['src/does-not-exist-anywhere.js', 'knowledge/tools.md'] }, owner);
  assert.ok(toolFailed(result), result);
  assert.match(result, /none of the files were read/);
  assert.match(result, /no such file/);
  assert.match(result, /knowledge base/);
});

test('settings tools read the setting back before saying done', async () => {
  const classifier = config.turnClassifierEnabled;
  const off = await runTool('turn_classifier', { action: 'off' }, owner);
  assert.ok(!toolFailed(off), off);
  assert.equal(config.turnClassifierEnabled, false);
  assert.match(off, /is off/);
  await runTool('turn_classifier', { action: classifier ? 'on' : 'off' }, owner);

  // Only "off" here: "on" would launch the hidden recorder browser (avatarVideo.js), which a test must not do.
  const offVideo = await runTool('avatar_mode', { action: 'off' }, owner);
  assert.ok(!toolFailed(offVideo), offVideo);
  assert.equal(config.avatarVideo, false);
  assert.match(offVideo, /off: replies are text only/);

  const words = await runTool('wake_words', { action: 'set', list: 'everyone', words: 'truth test' }, owner);
  assert.ok(!toolFailed(words), words);
  assert.match(words, /"truth test"/);
  await runTool('wake_words', { action: 'set', list: 'everyone', words: '' }, owner);
});

test('music sent to the Studio page is reported as sent, not as heard', async () => {
  const sent = [];
  const ctx = { ...owner, perms: { owner: true, files: true }, studioMusic: (c) => sent.push(c) };
  const paused = await runTool('music', { action: 'pause' }, ctx);
  assert.ok(!toolFailed(paused), paused);
  assert.match(paused, /Sent pause to the Studio page player/);
  assert.match(paused, /no confirmation/);
  assert.deepEqual(sent, [{ action: 'pause' }]);
  const volume = await runTool('music', { action: 'volume', level: 0.5 }, ctx);
  assert.match(volume, /sent to the Studio page player/);
});

// Owner, 2026-11-11: James saved four voices for himself after "just fill it in with whatever you want" (about his
// personality). A voice he keeps or wears needs the asker's own words from the line he's answering.
test('keeping or wearing a voice needs the words that asked for it, from the line being answered', async () => {
  const { runTool } = await import('./tools.js');
  const { config } = await import('./config.js');
  const was = { tts: config.tts, owners: config.ownerIds };
  config.tts = 'fish'; config.ownerIds = ['u-owner'];
  const ctx = { perms: { owner: true }, speaker: { id: 'u-owner', name: 'Owner' }, userText: 'Just fill it in with whatever you want.', conversation: 'voice:keep-test', turn: '1' };
  try {
    for (const args of [{ action: 'keep', slot: 'regular', id: 'abc' }, { action: 'keep', slot: 'regular', id: 'abc', asked: 'fill it in with whatever you want, make it female' }, { action: 'wear', id: 'abc' }]) {
      const r = String(await runTool('voice_library', args, ctx));
      assert.match(r, /only changes when someone asks for it in the message you're answering.*Nothing changed/s, JSON.stringify(args));
    }
  } finally { config.tts = was.tts; config.ownerIds = was.owners; }
});

// Owner, 2026-11-11: "Yeah" ticked James's voices step through the onboarding tool. The tool itself refuses setup steps.
test('the onboarding tool will not tick a setup step, whatever the hands decide', async () => {
  const { runTool } = await import('./tools.js');
  const { config } = await import('./config.js');
  const was = config.ownerIds;
  config.ownerIds = ['u-owner'];
  const ctx = { perms: { owner: true }, speaker: { id: 'u-owner', name: 'Owner' }, userText: 'Yeah.', conversation: 'voice:onb', turn: '1' };
  try {
    for (const id of ['intro', 'persona', 'wake_words', 'voices', 'how_memory_works']) {
      assert.match(String(await runTool('onboarding', { action: 'check', id }, ctx)), /setup steps aren't checked off by hand.*Nothing was checked/s, id);
    }
  } finally { config.ownerIds = was; }
});

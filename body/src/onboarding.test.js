import test from 'node:test';
import assert from 'node:assert/strict';
import { config, DATA_DIR } from './config.js';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checklist, checklistStatus, checkItem, onboardingSection, onboardingNeed, onboardingBriefing, setupSection, wakeSetupOpen, currentSetupStep, setupHandsLine } from './onboarding.js';

// A fresh her (a new install, or after a full reset clears the persona): setup applies (owner, 2026-11-09).
config.persona = '';

test('pressure wants the onboarding while there is any left, and the briefing carries the next item in depth', () => {
  const next = checklistStatus().next;
  assert.equal(onboardingNeed(), 1);
  const briefing = onboardingBriefing();
  assert.equal(briefing.id, next.id);
  assert.ok(briefing.text.includes(next.title), 'the briefing names the item');
  if (next.detail) assert.ok(briefing.text.includes(next.detail), 'an ability comes with its full detail');
  assert.match(briefing.text, /Take as many exchanges as it needs/);
});

// Her onboarding checklist. Owner, 2026-11-09: setup comes first, in order: introduce herself, the persona
// her owner chooses (how she acts and talks, her name), wake words, then explaining how she remembers
// people, how things affect her and how her energy works; then her owner, how people talk to her, and
// every tool she has, one at a time, each checked off only when it's been done.
test('setup comes first: persona, wake words, then how she works; then the rest of everything she has', () => {
  const items = checklist();
  assert.deepEqual(items.slice(0, 10).map((item) => item.id), ['intro', 'persona', 'avatar', 'wake_words', 'voices', 'how_memory_works', 'how_things_affect_me', 'how_energy_works', 'owner', 'how_to_talk']);
  // Owner, 2026-11-09: the four voice slots, when each kicks in, and choosing each with tags from the library.
  const voices = items.find((item) => item.id === 'voices').detail;
  for (const slot of ['Regular', 'Strong', 'Sensual', 'Whisper']) assert.match(voices, new RegExp(slot));
  assert.match(voices, /kicks in when someone insults you/);
  assert.match(voices, /action tags/);
  assert.match(voices, /voice_library keep/);
  assert.ok(items.length > 100, `every system topic is on the list, not only the tools: ${items.length} items`);
  assert.ok(items.some((item) => item.title.includes('inner_core') || item.id === 'inner_core'), 'every tool is on the list, by its topic or on its own');
  assert.equal(new Set(items.map((item) => item.id)).size, items.length, 'no item twice');
});

test('every system topic carries its real process detail from the guide, not just a keyword', () => {
  const topics = checklist().filter((item) => item.id.startsWith('topic:'));
  const withDetail = topics.filter((item) => item.detail && item.detail.length > 150);
  assert.ok(topics.length > 100, `topics: ${topics.length}`);
  assert.ok(withDetail.length >= topics.length * 0.9, `${withDetail.length} of ${topics.length} topics have their guide detail`);
});

// Owner, 2026-11-09: until her wake words are set up after a reset she answers everyone in voice, and the
// setup step has her explain what wake words are and why they're being set up.
test('while setup is on and no wake words are set, she answers everything; a saved wake word ends it', () => {
  config.voice.wakeWords = []; config.voice.ownerWakeWords = [];
  setupSection(); // setup starts for a her with no persona
  assert.equal(wakeSetupOpen(), true);
  config.voice.wakeWords = ['amy'];
  assert.equal(wakeSetupOpen(), false, 'a saved wake word ends it');
  config.voice.wakeWords = [];
  const step = checklist().find((item) => item.id === 'wake_words');
  assert.match(step.detail, /answer every single line/);
  assert.match(step.detail, /why it matters/);
  assert.match(step.detail, /wake_words tool/);
});

// Owner, 2026-11-09: she looped on "introduce yourself" because nothing ever checked the intro off (her voice
// has no tools; she typed the check into her reply). Her hands are told the step; a later step clears the earlier.
test('setup steps: her hands are told which one, and finishing a later step clears the ones before it', () => {
  const file = path.join(DATA_DIR, 'onboarding.json');
  const saved = readFileSync(file, 'utf8');
  try {
    assert.equal(currentSetupStep()?.id, 'intro');
    assert.match(setupHandsLine(), /"intro"/);
    assert.match(setupHandsLine(), /You never mark setup steps done/); // 2026-11-11: only real events tick them
    assert.doesNotMatch(setupSection(), /call the onboarding tool/, 'her voice is never told to call a tool it does not have');
    // A wake word saved before any persona: the intro is behind her, but the persona isn't saved, so that's next.
    checkItem('wake_words');
    assert.equal(currentSetupStep()?.id, 'persona');
    // What happened live: persona and wake word saved, intro never checked. Now the intro goes with them.
    config.persona = 'You are curious and growing.';
    checkItem('wake_words');
    assert.equal(currentSetupStep()?.id, 'voices');
    assert.doesNotMatch(setupSection(), /Introduce yourself/);
  } finally { writeFileSync(file, saved); config.persona = ''; }
});

// Owner, 2026-11-11, after a wipe: wake words set, then "You're talking to Owner. I own you and I created you" ticked the
// persona (none saved), "Yeah" ticked voices and James announced four voices nobody chose, "Okay, go ahead" ticked the
// memory step before he'd explained it. Setup steps are never ticked by a model reading a line: only real events.
test('tonight replayed: nothing anyone says ticks a setup step; only the real thing does', async () => {
  const { checkStep, afterSetupReply } = await import('./onboarding.js');
  const file = path.join(DATA_DIR, 'onboarding.json');
  let saved = null; try { saved = readFileSync(file, 'utf8'); } catch {}
  try {
    assert.equal(currentSetupStep()?.id, 'intro');
    // His intro reply: said, so done.
    afterSetupReply('intro');
    assert.equal(currentSetupStep()?.id, 'persona');
    // Wake words saved (the event, as tools.js calls it): done; the persona isn't, since none is saved.
    checkItem('wake_words');
    assert.equal(currentSetupStep()?.id, 'persona');
    // "You're talking to Owner", "Yeah", "Okay, go ahead": the hands try to tick steps. Every one is refused.
    for (const id of ['persona', 'voices', 'how_memory_works']) {
      assert.match(checkStep(id), /^Error: setup steps aren't checked off by hand.*Nothing was checked/, id);
      assert.equal(currentSetupStep()?.id, 'persona', `${id}: nothing moved`);
    }
    // A reply with the persona step in front of him doesn't finish it: it needs a saved persona.
    afterSetupReply('persona');
    assert.equal(currentSetupStep()?.id, 'persona');
    // A saved persona is what finishes it.
    config.persona = 'You are steady and direct.';
    checkItem('persona'); // what tools.js persona set does
    assert.equal(currentSetupStep()?.id, 'voices');
  } finally { config.persona = ''; if (saved !== null) writeFileSync(file, saved); }
});

test('voices and memory: a voice he picked and saved finishes voices; the memory step finishes once it has been explained', async () => {
  const { afterSetupReply, SETUP } = await import('./onboarding.js');
  const file = path.join(DATA_DIR, 'onboarding.json');
  let saved = null; try { saved = readFileSync(file, 'utf8'); } catch {}
  try {
    for (const id of SETUP.slice(0, SETUP.indexOf('voices'))) checkItem(id, { sweep: false }); // every step before voices
    assert.equal(currentSetupStep()?.id, 'voices');
    afterSetupReply('voices'); // talking about voices doesn't pick one
    assert.equal(currentSetupStep()?.id, 'voices');
    checkItem('voices', { sweep: false }); // what voice_library keep does once he's picked one
    assert.equal(currentSetupStep()?.id, 'how_memory_works');
    afterSetupReply('voices'); // a stale step id from an earlier reply changes nothing
    assert.equal(currentSetupStep()?.id, 'how_memory_works');
    afterSetupReply('how_memory_works'); // the reply that explained it
    assert.equal(currentSetupStep()?.id, 'how_things_affect_me');
    assert.match(setupHandsLine(), /You never mark setup steps done/);
    assert.match(setupSection(), /Never say a step is done or something is set unless it is/);
  } finally { if (saved !== null) writeFileSync(file, saved); }
});

test('checking an item moves her on to the next one, and unknown items are refused', () => {
  const before = checklistStatus();
  assert.equal(before.next.id, 'intro');
  assert.match(onboardingSection(), /Next: Introduce yourself/);
  checkItem('intro');
  const after = checklistStatus();
  assert.equal(after.done, before.done + 1);
  assert.equal(after.next.id, 'persona');
  assert.throws(() => checkItem('no_such_thing'), /no checklist item/);
});

test('while setup is unfinished it is in her prompt every reply, starting with the persona her owner chooses', () => {
  const section = setupSection();
  assert.match(section, /Persona: your owner decides how you act and talk/);
  assert.match(section, /persona tool/);
  checkItem('persona');
  assert.match(setupSection(), /Avatar: show your owner the avatars/);
  checkItem('avatar');
  assert.match(setupSection(), /Wake words/);
  checkItem('wake_words');
  assert.equal(wakeSetupOpen(), false, 'her owner chose none and the step is done: the usual rules again');
  assert.match(setupSection(), /four voices/);
  for (const id of ['voices', 'how_memory_works', 'how_things_affect_me']) checkItem(id);
  assert.match(setupSection(), /energy/);
  checkItem('how_energy_works');
  assert.equal(setupSection(), '', 'setup done: nothing more in her prompt');
});

test('once every item is checked off, there is nothing left to tell her', () => {
  for (const item of checklist()) checkItem(item.id);
  assert.equal(checklistStatus().complete, true);
  assert.equal(onboardingSection(), '');
});

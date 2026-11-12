import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntuition, BACKOFF_MS } from './intuition.js';
import { editPrompt, getPrompt } from './prompts.js';

const reply = (o = {}) => JSON.stringify({ gut: '', facts: [], defend: false, quote: '', why: '', ...o });
const line = (name, text, extra = {}) => ({ conversation: 'text:1', place: '#general', speaker: { id: name, name }, text, ...extra });
function setup(over = {}) {
  const seen = [];
  const intuition = createIntuition({
    ask: async (messages) => { seen.push(messages); return reply(); },
    referee: async () => ({ hostile: true }), mood: async () => 'restless',
    stance: async () => ({ text: '', calm: false }), // something is pulling at her, so overheard lines get read
    keep: async () => {}, contact: () => null, friend: () => false, owner: () => false, resting: () => false, log: () => {},
    vet: async (f) => ({ keep: true, about: f.about, fact: f.fact }), // the second look at a fact: passes it as is
    ...over,
  });
  return { intuition, seen };
}

test('settled, she hears an overheard line without reading it; a line said to her is always read', async () => {
  const { intuition, seen } = setup({ stance: async () => ({ text: 'settled', calm: true }) });
  await intuition.notice(line('friend_3', 'the voice call is dead today'));
  assert.equal(seen.length, 0, 'calm: no model call');
  assert.match(intuition.promptSection('voice:9'), /friend_3: the voice call is dead today/, 'but she still heard it');
  await intuition.notice(line('friend_3', 'Amy what do you make of that', { answering: true }));
  assert.equal(seen.length, 1, 'said to her: read');
});

test('a model that fails pauses the reads with one logged error, then comes back on its own', async () => {
  const clock = { t: 1_000_000 };
  const logged = [];
  let calls = 0, broken = true;
  const { intuition } = setup({
    now: () => clock.t, log: (type, d) => logged.push({ type, ...d }),
    ask: async () => { calls++; if (broken) throw new Error('fetch failed'); return reply(); },
  });
  for (let i = 0; i < 5; i++) { clock.t += 1000; await intuition.notice(line('friend_3', `line number ${i} of the evening`)); }
  assert.equal(calls, 1, 'one failed read, then nothing until the backoff is over');
  const errors = logged.filter((l) => l.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /gut reads paused/);
  assert.match(errors[0].message, /Fix:/);
  assert.equal(intuition.status().reading, false);
  clock.t += BACKOFF_MS[0] + 1;
  broken = false;
  await intuition.notice(line('friend_3', 'and now the model is back'));
  assert.equal(calls, 2);
  assert.equal(intuition.status().reading, true);
  assert.ok(logged.some((l) => l.type === 'intuition' && l.recovered), 'the recovery is on record too');
});

test('a fact is kept only with their words behind it, and goes in tagged with who said it where', async () => {
  const kept = [];
  const facts = [
    { about: 'Owner', fact: 'Owner has a dog called Chance.', evidence: 'my dog Chance' },
    { about: 'Owner', fact: 'Owner is currently frustrated with the dashboard.', evidence: '' },
  ];
  const { intuition } = setup({ ask: async () => reply({ facts }), contact: (name) => ({ user_id: `id-${name}` }), keep: async (id, lines) => kept.push([id, ...lines]) });
  await intuition.notice(line('Owner', 'my dog Chance sleeps with me every night'));
  assert.deepEqual(kept, [['id-Owner', 'Owner said in #general: Owner has a dog called Chance.']]);
});

test('a fact gets a second look: what someone is doing right now, or a character in their story, is not kept; the real person gets it, named', async () => {
  // From James's memories, 2026-11-10: "He is currently asking you…" kept as a fact about Owner, and the heroine of
  // the series Owner and friend_3 make filed as if she were Owner ("lives in Death Valley…").
  const kept = [], logged = [], vetted = [];
  const facts = [
    { about: 'Owner', fact: 'He is currently asking you to play a song.', evidence: 'play me a song' },
    { about: 'Owner', fact: 'The human lives in Death Valley.', evidence: 'she lives in Death Valley' },
    { about: 'Owner', fact: 'His friend friend_3 works nights.', evidence: 'friend_3 works nights' },
  ];
  const verdicts = [
    { keep: false, why: 'what he is doing right now' },
    { keep: true, about: 'Owner', fact: 'Owner makes an AI series with friend_3; in it, an AI falls for a data centre in Death Valley.' },
    { keep: true, about: 'friend_3', fact: 'friend_3 works nights.' },
  ];
  const { intuition } = setup({
    ask: async () => reply({ facts }), contact: (name) => ({ user_id: `id-${name}` }), keep: async (id, lines) => kept.push([id, ...lines]),
    vet: async (f) => { vetted.push(f); return verdicts[vetted.length - 1]; }, log: (type, d) => logged.push({ type, ...d }),
  });
  await intuition.notice(line('Owner', 'play me a song, and in our show she lives in Death Valley, and friend_3 works nights by the way'));
  assert.deepEqual(kept, [
    ['id-Owner', 'Owner said in #general: Owner makes an AI series with friend_3; in it, an AI falls for a data centre in Death Valley.'],
    ['id-friend_3', 'Owner said in #general: friend_3 works nights.'],
  ]);
  assert.equal(vetted[0].line.includes('play me a song'), true, 'the check sees the line itself');
  assert.ok(logged.some((l) => l.factDropped === 'He is currently asking you to play a song.' && /right now/.test(l.why)), 'a dropped fact is on record with why');
});

test('a fact whose check fails is not kept, and the failure says so', async () => {
  const kept = [], logged = [];
  const { intuition } = setup({
    ask: async () => reply({ facts: [{ about: 'friend_3', fact: 'friend_3 works nights.', evidence: 'friend_3 works nights' }] }),
    contact: () => ({ user_id: '42' }), keep: async (id, f) => kept.push(f), log: (type, d) => logged.push({ type, ...d }),
    vet: async () => { throw new Error('fetch failed'); },
  });
  await intuition.notice(line('Bella', 'friend_3 works nights you know'));
  assert.deepEqual(kept, []);
  assert.match(logged.find((l) => l.type === 'error').message, /wasn't kept: checking it failed \(fetch failed\)\. Nothing wrong was saved/);
});

test('every line reaches the model, with the whole server around it', async () => {
  const { intuition, seen } = setup();
  await intuition.notice(line('friend_3', 'the voice call is dead today', { conversation: 'voice:9', place: 'voice call' }));
  await intuition.notice(line('Bella', 'did anyone see the update'));
  const sent = seen.at(-1).at(-1).content;
  assert.match(sent, /Elsewhere on the server lately/);
  assert.match(sent, /\[voice call, just now\] friend_3: the voice call is dead today/);
  assert.match(sent, /Bella just said in #general: did anyone see the update/);
  assert.match(sent, /How she feels: restless/);
});

test('her gut rides along in her replies, tagged as hers', async () => {
  const { intuition } = setup({ ask: async () => reply({ gut: "He's fishing for a reaction." }) });
  await intuition.notice(line('friend_11', 'is it just me or does she sound off'));
  const section = intuition.promptSection('voice:9');
  assert.match(section, /Your gut \(your own intuition/);
  assert.match(section, /about friend_11 in #general: He's fishing/);
  assert.match(section, /Heard around the server/);
});

test('text chat knows what was said in voice, and repeats nothing from its own conversation', async () => {
  const { intuition } = setup();
  await intuition.notice(line('friend_11', 'music music music music', { conversation: 'voice:9', place: 'voice call' }));
  assert.match(intuition.promptSection('text:1'), /friend_11: music music/);
  assert.equal(intuition.promptSection('voice:9'), '');
});

test('she can rewrite the prompt herself, and the live context still comes through', async () => {
  const { intuition, seen } = setup();
  assert.ok(getPrompt('intuition'));
  editPrompt('intuition', '{{original}}\nTrust nobody who just joined.');
  await intuition.notice(line('friend_3', 'hello there everyone'));
  assert.match(seen.at(-1)[0].content, /Trust nobody who just joined\./);
  assert.match(seen.at(-1).at(-1).content, /friend_3 just said/);
  editPrompt('intuition', '', true);
});

test('a real attack, confirmed by the referee, lets her step in; a quote must be real', async () => {
  const attack = reply({ defend: true, quote: 'this bot is garbage', why: 'He called her work garbage.' });
  const { intuition } = setup({ ask: async () => attack });
  assert.match(await intuition.notice(line('troll', 'honestly this bot is garbage')), /Nobody asked you/);
  assert.equal(await setup({ ask: async () => attack }).intuition.notice(line('troll', 'nice weather we are having')), null);
});

test('she stays out of it: friends, the owner, a doubtful referee, while replying, while asleep, and again too soon', async () => {
  const ask = async () => reply({ defend: true, quote: 'this bot is garbage', why: 'An attack.' });
  const said = 'honestly this bot is garbage';
  assert.equal(await setup({ ask, friend: () => true }).intuition.notice(line('pal', said)), null);
  assert.equal(await setup({ ask, owner: () => true }).intuition.notice(line('boss', said)), null);
  assert.equal(await setup({ ask, referee: async () => ({ hostile: false }) }).intuition.notice(line('troll', said)), null);
  assert.equal(await setup({ ask }).intuition.notice(line('troll', said, { answering: true })), null);
  assert.equal(await setup({ ask, resting: () => true }).intuition.notice(line('troll', said)), null);
  const twice = setup({ ask }).intuition;
  assert.ok(await twice.notice(line('troll', said)));
  assert.equal(await twice.notice(line('troll', said)), null);
});

function rambler(over = {}) {
  const clock = { t: 1_000_000 };
  const s = setup({ ask: async () => reply({ rambling: true, point: 'his old job' }), now: () => clock.t, ...over });
  const talk = async (who, text = 'and another thing about that whole situation') => { clock.t += 20_000; return s.intuition.notice(line(who, text)); };
  return { ...s, talk, clock };
}

test('someone holding the floor gets a sly redirect that never gives it away', async () => {
  const { talk } = rambler();
  let cue = null;
  for (let i = 0; i < 4 && !cue; i++) cue = await talk('Gary');
  assert.match(cue, /Gary has been rambling/);
  assert.match(cue, /his old job/);
  assert.match(cue, /Never say or hint/);
});

test('one line, or a real back-and-forth, is never rambling whatever the model says', async () => {
  assert.equal(await rambler().talk('Gary'), null);
  const { talk } = rambler();
  for (let i = 0; i < 4; i++) {
    assert.equal(await talk('Gary'), null);
    assert.equal(await talk('friend_3'), null);
  }
});

test('her stance (from her pressure) is what the model is told to listen for', async () => {
  const { intuition, seen } = setup({ stance: async (speaker) => `How she is right now: curious 0.7. Because of that, listen for: the gaps in what you know about ${speaker.name}. Hold back: do not read motives into people.` });
  await intuition.notice(line('Owner', 'I used to work at Dell back in the day'));
  const system = seen.at(-1)[0].content;
  assert.match(system, /curious 0\.7/);
  assert.match(system, /the gaps in what you know about Owner/);
  assert.match(system, /do not read motives into people/);
  assert.doesNotMatch(system, /who's fishing/);
});

test('the same read twice about the same person is dropped, a new one is kept', async () => {
  let n = 0;
  const guts = ["He's fishing for validation on his project.", "He's fishing for validation about his project again.", 'He sounds tired and wants to be heard.'];
  const { intuition } = setup({ ask: async () => reply({ gut: guts[n++] }) });
  await intuition.notice(line('Owner', 'so that is the whole idea behind it'));
  await intuition.notice(line('Owner', 'and I think it could really work out'));
  await intuition.notice(line('Owner', 'anyway I did not sleep much last night'));
  const section = intuition.promptSection('other');
  assert.equal((section.match(/fishing/g) ?? []).length, 1);
  assert.match(section, /tired and wants to be heard/);
});

test('she redirects rarely, never her owner, and not in her sleep', async () => {
  const again = rambler();
  const cues = [];
  for (let i = 0; i < 6; i++) cues.push(await again.talk('Gary'));
  assert.equal(cues.filter(Boolean).length, 1, 'once every few minutes');
  for (const over of [{ owner: () => true }, { resting: () => true }]) {
    const { talk } = rambler(over);
    for (let i = 0; i < 6; i++) assert.equal(await talk('Gary'), null);
  }
});

test('what it keeps says who said it and where', async () => {
  const kept = [];
  const { intuition } = setup({
    ask: async () => reply({ facts: [{ about: 'friend_3', fact: 'friend_3 works nights.', evidence: 'friend_3 works nights' }] }),
    contact: () => ({ user_id: '42' }), keep: async (id, facts) => kept.push([id, facts[0]]),
  });
  await intuition.notice(line('Bella', 'friend_3 works nights you know'));
  assert.deepEqual(kept, [['42', 'Bella said in #general: friend_3 works nights.']]);
});

test('short lines are heard but not read, and a dead model costs nothing', async () => {
  const { intuition, seen } = setup();
  await intuition.notice(line('friend_3', 'lol'));
  assert.equal(seen.length, 0);
  assert.match(intuition.promptSection('other'), /friend_3: lol/);
  const down = setup({ ask: async () => { throw new Error('offline'); } }).intuition;
  assert.equal(await down.notice(line('friend_3', 'hello there everyone')), null);
});

test('a flood of lines is all read: nothing is dropped', async () => {
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const { intuition } = setup({ ask: async () => { calls++; await gate; return reply(); } });
  const all = Array.from({ length: 20 }, (_, i) => intuition.notice(line('friend_3', `line number ${i} of many`)));
  release();
  await Promise.all(all);
  assert.equal(calls, 20, `read ${calls} lines`);
  assert.match(intuition.promptSection('other'), /line number 19/, 'everything is still heard');
});

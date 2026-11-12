import test from 'node:test';
import assert from 'node:assert/strict';
import { respondWithBrain, sentences } from './brain-reply.js';
import { promptMessages } from './memory.js';
import { bus } from './events.js';

// Owner, 2026-11-11: the LLM comes out and her own brain answers. The body keeps the history and speaks the reply.
const speaker = { id: 'u-owner', name: 'Owner' };
const main = { main: true, name: 'Amy' };
const mindThatSays = (text, extra = {}) => {
  const heard = [];
  return { heard, hear: async (line) => { heard.push(line); return { ok: true, text, intent: 'answer', learned: [], not_understood: [], feelings: {}, ms: 3, ...extra }; } };
};

test('a line said to her goes to her brain, and both sides of it are kept in the conversation', async () => {
  const mind = mindThatSays('Yes. Rex is a dog.');
  const reply = await respondWithBrain({ conversation: 'test:brain-1', speaker, text: '  Is Rex a dog?  ', character: main }, { mind });
  assert.equal(reply, 'Yes. Rex is a dog.');
  assert.deepEqual(mind.heard, [{ text: 'Is Rex a dog?', speaker: 'Owner', speakerId: 'u-owner', isBot: false }]);
  const kept = promptMessages('test:brain-1').map((m) => [m.role, m.content]);
  assert.deepEqual(kept, [['user', 'Is Rex a dog?'], ['assistant', 'Yes. Rex is a dog.']]);
});

// Owner, 2026-11-11: her Mind page (the brain-shaped one, mind.html) has to light up from her own brain's work.
// It lights Hearing, Memory, Thoughts and Voice from the record of a turn the body has always kept.
test('a turn is recorded step by step: heard, then what she learned or worked out, then her reply', async () => {
  const seen = [];
  const onEvent = (e) => { if (['heard', 'remembered', 'thought', 'replied'].includes(e.type)) seen.push(e); };
  bus.on('activity', onEvent);
  try {
    await respondWithBrain({ conversation: 'test:brain-events', speaker, text: 'Rex is a dog.', character: main },
      { mind: mindThatSays('Recorded: Rex is a dog', { learned: ['Rex is a dog'], touched: ['e2', 'c1'] }) });
    await respondWithBrain({ conversation: 'test:brain-events', speaker, text: 'Is Rex a dog?', character: main },
      { mind: mindThatSays('Yes. Rex is a dog.', { learned: [], touched: ['e2', 'c1'] }) });
  } finally { bus.off('activity', onEvent); }
  assert.deepEqual(seen.map((e) => e.type), ['heard', 'remembered', 'replied', 'heard', 'thought', 'replied']);
  assert.equal(seen[0].speaker, 'Owner');
  assert.equal(seen[0].text, 'Rex is a dog.');
  assert.deepEqual(seen[1].facts, ['Rex is a dog'], 'what she learned goes to memory, under who said it');
  assert.equal(seen[1].speaker, 'Owner');
  assert.equal(seen[4].topic, 'worked out: Yes.', 'an answer reached from facts she held is a thought');
  assert.equal(seen[5].text, 'Yes. Rex is a dog.');
});

test('in voice her reply is spoken a sentence at a time, in order', async () => {
  const spoken = [];
  const mind = mindThatSays('Yes. Rex is a dog. I know this because Rex is a beagle!');
  await respondWithBrain({ conversation: 'test:brain-2', speaker, text: 'Is Rex a dog?', voice: true, onSentence: async (s) => { spoken.push(s); }, character: main }, { mind });
  assert.deepEqual(spoken, ['Yes.', 'Rex is a dog.', 'I know this because Rex is a beagle!']);
  assert.deepEqual(sentences('One. Two? Three'), ['One.', 'Two?', 'Three']);
});

test('a voice line that was never spoken is not kept as said', async () => {
  const mind = mindThatSays('Hello.');
  await respondWithBrain({ conversation: 'test:brain-3', speaker, text: 'Hi', voice: true, onSentence: async () => {}, unsaid: () => true, character: main }, { mind });
  assert.deepEqual(promptMessages('test:brain-3').map((m) => m.role), ['user']);
});

test("a want firing on its own, or another character's turn, says nothing and never reaches her brain", async () => {
  const mind = mindThatSays('should not be said');
  assert.equal(await respondWithBrain({ conversation: 'test:brain-4', speaker, text: '', cue: 'The call has gone quiet.', character: main }, { mind }), null);
  assert.equal(await respondWithBrain({ conversation: 'test:brain-4', speaker, text: 'Draw me a house', character: { main: false, name: 'Mateo' } }, { mind }), null);
  assert.equal(mind.heard.length, 0);
  assert.equal(promptMessages('test:brain-4').length, 0);
});

test('when her brain fails, the turn fails with its reason instead of a made-up reply', async () => {
  const mind = { hear: async () => { throw new Error('The brain stopped (exit code 1). It starts again on the next line said to her.'); } };
  await assert.rejects(respondWithBrain({ conversation: 'test:brain-5', speaker, text: 'Hello', character: main }, { mind }), /The brain stopped/);
});

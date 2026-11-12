// A turn answered by her own brain, with no language model (config.brain === 'amy'; companion.js respond()).
// The line goes to the Python Amy (brain-client.js): she parses it, learns what it states, reasons over what she
// knows and words the reply herself. The body keeps the conversation history, speaks the reply in voice, and lets
// her pressure react to being talked to.
//
// Not wired to the brain yet (MERGE-PLAN.md): a want that fires on its own (a cue: silence, sharing, asking) is
// phase 3, and the studio's other characters have no brain of their own. Those turns say nothing, and say why.
import { config } from './config.js';
import { activity } from './events.js';
import { addMessage, noteContact, listContacts } from './memory.js';
import { brain } from './brain-client.js';
import { refreshBrainMind } from './brain-mind.js';
import { brainNodeId } from './cognitive-graph.js';
import * as pressure from './pressure.js';

// Her reply in spoken pieces, so voice starts on the first sentence instead of waiting for the last.
export const sentences = (text) => String(text).match(/[^.!?\n]+[.!?]*["')\]]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

const noted = new Set(); // each kind of skipped turn is explained once, not on every firing
function skip(kind, message) {
  if (!noted.has(kind)) { noted.add(kind); activity('brain', { skipped: kind, message }); }
  return null;
}

export async function respondWithBrain({ conversation, speaker, text, voice = false, onSentence, cue, character, unsaid = null }, { mind = brain(), refresh = refreshBrainMind } = {}) {
  if (character && !character.main) return skip('character', `${character.name} has no brain of their own yet: with BRAIN=amy only ${config.botName} answers. The studio's other characters stay quiet until they're given one.`);
  const line = String(text ?? '').trim();
  if (cue || !line) return skip('cue', `A want fired on its own (${String(cue ?? 'no words').slice(0, 80)}), but her wants aren't wired to her brain yet (MERGE-PLAN.md phase 3), so she said nothing. Lines said to her are answered.`);

  if (speaker.id !== 'dashboard') noteContact({ userId: speaker.id, name: speaker.name, username: speaker.username, dm: speaker.dm });
  addMessage(conversation, { role: 'user', userId: speaker.id, name: speaker.name, content: line });
  // The same record of a turn the body has always kept (heard, remembered, thought, replied), each as it happens:
  // her mind page lights Hearing, Memory, Thoughts and Voice from these, and grows what she knows from them.
  activity('heard', { conversation, voice, speaker: speaker.name, userId: speaker.id, text: line });

  const started = Date.now();
  let heard;
  try {
    heard = await mind.hear({ text: line, speaker: speaker.name, speakerId: speaker.id, isBot: Boolean(speaker.bot) });
  } catch (err) {
    activity('error', { where: 'brain', message: err.message });
    throw err;
  }
  const reply = String(heard.text ?? '').trim();
  // What she took from the line goes to memory; an answer she reached from facts she already held is a thought.
  if (heard.learned?.length) activity('remembered', { speaker: speaker.name, userId: speaker.id, facts: heard.learned, brain: true });
  else if (reply && heard.touched?.length) activity('thought', { topic: `worked out: ${sentences(reply)[0] ?? reply}`.slice(0, 90), brain: true });
  if (reply && voice && onSentence) for (const s of sentences(reply)) await onSentence(s);
  if (reply) activity('replied', { conversation, voice, text: reply, ms: Date.now() - started, brain: true });
  // unsaid: a voice line that was made but never spoken (the room started talking first) isn't kept as said.
  if (reply && !unsaid?.()) addMessage(conversation, { role: 'assistant', name: null, content: reply, tools: null });

  // What this turn touched in her mind, so the mind view lights it up: whoever spoke, herself when she answered, and
  // both ends of every fact she stored or used. Her mind is read again first, so a thing she just learned is there.
  let nodes = [];
  try {
    const held = await refresh({ mind });
    const contactByName = new Map(listContacts().map((c) => [String(c.name ?? '').toLowerCase(), `person:${c.user_id}`]));
    const things = new Map((held?.things ?? []).map((t) => [t.key, t]));
    nodes = [...new Set([`person:${speaker.id}`, ...(reply ? ['person:self'] : []),
      ...(heard.touched ?? []).map((key) => things.get(key)).filter(Boolean).map((t) => brainNodeId(t, contactByName))])];
  } catch (err) { activity('error', { where: 'mind view (brain turn)', message: `Her turn couldn't be mapped onto her mind view: ${err.message}. The reply itself is unaffected.` }); }
  activity('brain', { conversation, speaker: speaker.name, voice, nodes, heard: line.slice(0, 200), reply: reply.slice(0, 300),
    intent: heard.intent ?? null, learned: heard.learned ?? [], not_understood: heard.not_understood ?? [],
    feelings: heard.feelings ?? {}, brainMs: heard.ms, ms: Date.now() - started });
  try { pressure.onTurn({ speaker, text: line, voice, conversation, actions: [], made: false }); }
  catch (err) { activity('error', { where: 'pressure', message: err.message }); }
  return reply || null;
}

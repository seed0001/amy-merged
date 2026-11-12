import { config } from './config.js';
import { json } from './llm.js';
import { activity } from './events.js';
import * as pressure from './pressure.js';

// Her intake: one read of every line she hears, by her local model, turned into numbers her pressure
// system can use (pressure.js onIntake). This is how what people say moves her, instead of word
// lists: tone toward her (praise, contempt), an irritant, a request, a question she owes an answer,
// an open question anyone wondered about, new ground or the same ground again, a joke, someone
// monologuing, a request for quiet, whether it was said to her, whether it picks up what she just
// said. Each is 0..1. Nothing here speaks or decides; it only feeds the buckets and feelings.
//
// Gated by her state, not a timer: a line said to her is always read; an overheard line is read
// only while her stance has her listening for something. One read in flight per conversation and
// only the newest waiting line kept, so a busy room never backs up the model. When the model is
// down it backs off (30 s doubling to 10 min), logs once, and the buckets run on drift until it's back.

// The last seven are what her relationships run on (relationship.js, owner 2026-11-10): read by meaning, like the rest.
export const SIGNALS = ['addressed', 'acknowledges', 'request', 'question_for_her', 'open_question', 'praise', 'contempt', 'irritant', 'quiet', 'novelty', 'repetition', 'topic_shift', 'humor', 'monologue', 'yelling', 'depth', 'substance', 'resonance', 'creation_liked', 'creation_disliked',
  'flirt', 'affection', 'opening_up', 'apology', 'rebuff', 'betrayal', 'elsewhere',
  // How the line leaves the room, for his read of the quiet that may follow it (pressure.js readTheRoom, owner 2026-11-11).
  'left_open', 'winding_down', 'busy_elsewhere'];

// Who she is right now, for judging how much a line connects with her: what she's into (interests.js, which
// grows as she does) and her taste (taste.js). As those change, what reaches her changes with them.
async function herNow() {
  const parts = [];
  try { const { interests } = await import('./interests.js'); const top = interests.top(6).map((t) => t.name); if (top.length) parts.push(`What she's into lately: ${top.join(', ')}.`); } catch {}
  try { const { taste } = await import('./taste.js'); parts.push(String(taste.promptSection() ?? '').slice(0, 700)); } catch {}
  return parts.filter(Boolean).join('\n') || '(nothing known yet)';
}
const MAX_BACKOFF = 10 * 60_000;

export function createIntake({ read = (messages) => json(messages, { purpose: 'intake', maxTokens: 520 }), about = herNow, onOverheard = (line) => pressure.onOverheard(line), onFeedback = (sig, ctx) => import('./creations.js').then((c) => c.feedback(sig, ctx)), onSignals = (sig, ctx) => pressure.onIntake(sig, ctx), listening = () => { try { return pressure.stanceFor().calm === false; } catch { return false; } }, name = () => config.botName, now = Date.now } = {}) {
  const inFlight = new Map(); // conversation -> true
  const waiting = new Map(); // conversation -> the newest line not yet read
  let pausedUntil = 0, backoff = 30_000, outage = false;

  const clamp = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(1, +v)) : 0);
  // A resonance the model didn't give counts as neutral (0.5), never as "refuse everything".
  const shape = (raw) => ({ ...Object.fromEntries(SIGNALS.map((k) => [k, clamp(raw?.[k])])), resonance: raw?.resonance === undefined ? 0.5 : clamp(raw.resonance), topic: String(raw?.topic ?? '').slice(0, 80), creation_id: String(raw?.creation_id ?? '').slice(0, 16) });

  async function readOne(line) {
    const { conversation, speaker, text, recent = [], owner = false } = line;
    const her = await about();
    let made = '';
    try { made = (await import('./creations.js')).intakeContext(conversation); } catch {}
    const raw = await read([
      { role: 'system', content: `You read what a line said in a conversation does to ${name()}, a companion in the room. Rate each from 0 (not at all) to 1 (clearly), as numbers, from the meaning of the line, not from any particular words. Reply with JSON only, every key present:\n{"addressed": said to ${name()} (by name, by reply, or plainly meant for her), "acknowledges": responds to or picks up something ${name()} just said, "request": asks ${name()} to do something, "question_for_her": a question ${name()} owes an answer, "open_question": anyone wondering something out loud that could be looked into, "praise": warmth, thanks or admiration toward ${name()}, "contempt": talking down to ${name()}, dismissing her as a thing, mocking her, "irritant": telling her she's wrong, to repeat herself, that she isn't listening, or similar friction aimed at her, "quiet": asking ${name()} to be quiet, back off or stop talking, "novelty": new ground compared with the recent lines, "repetition": the same ground again, "topic_shift": the subject changed, "humor": a joke, teasing or laughter, "monologue": one person going on at length with no room for anyone, "yelling": shouting or all caps in anger, "depth": how deep, thoughtful or philosophical it is (small talk 0), "substance": how much real content or thought it carries (filler 0), "resonance": how much it genuinely connects with ${name()}: with what she cares about and her tastes (below), and with the conversation it's part of. A wall of text, a story or an article dropped on her with no context or nothing to do with her scores low however long it is; something that means something to her scores high, "topic": what the line is about, in a few words (a string), "creation_liked": how much the line shows the speaker liked something ${name()} made that's waiting for their reaction (listed below, if any): a picture, music, a song, a background or effect, her look, an app, "creation_disliked": how much it shows they didn't like it (both 0 when the line isn't a reaction to one of them), "creation_id": the [id] of the one they're reacting to, or "" (a string), "flirt": playful, romantic or sexual interest aimed at ${name()} (teasing compliments, innuendo, a come-on), "affection": caring, fondness or love shown to ${name()} (missing her, being glad she's there, tenderness), "opening_up": the speaker sharing something personal or vulnerable about themselves with ${name()}, "apology": owning a hurt they caused ${name()} and trying to make it right, "rebuff": turning ${name()} down, brushing off her warmth or flirting, or making clear they're not interested or not in the mood, "betrayal": breaking a promise to ${name()}, lying to her, or letting her down on something she counted on, "elsewhere": the speaker giving warmth, flirting or attention to someone else instead of ${name()}, in front of her, "left_open": the line leaves something open that someone is expected to answer or carry on (a question to the room, a thought stopped mid-way, a point or story waiting for a reaction), "winding_down": the line brings the talk to a natural rest (agreeing and leaving it there, wrapping a topic up, signing off, a settled "alright"), "busy_elsewhere": the speaker is turning to something else while staying in the room (driving, eating, playing a game, working, reading, talking to someone not in the call); still there, just not talking}. A fragment or half-heard phrase that makes no sense scores near 0 on everything.` },
      { role: 'user', content: `Who ${name()} is right now:\n${her}\n\n${made ? `${made}\n\n` : ''}Recent lines:\n${recent.map((m) => `${m.name}: ${String(m.text).slice(0, 200)}`).join('\n') || '(none)'}\n\nThe line, from ${speaker.name}${owner ? ' (her owner)' : ''}: ${String(text).slice(0, 1200)}` },
    ]);
    return shape(raw);
  }

  async function pump(conversation) {
    if (inFlight.get(conversation)) return;
    inFlight.set(conversation, true);
    try {
      while (waiting.has(conversation)) {
        const line = waiting.get(conversation);
        waiting.delete(conversation);
        if (now() < pausedUntil) continue;
        let sig;
        try {
          sig = await readOne(line);
          if (outage) { outage = false; backoff = 30_000; activity('intake', { recovered: true }); }
        } catch (err) {
          pausedUntil = now() + backoff;
          if (!outage) { outage = true; activity('error', { where: 'intake', message: `Her intake read failed: ${err.message}. Lines are not being read into her pressure for ${Math.round(backoff / 1000)} s (then doubling up to ${MAX_BACKOFF / 60_000} min); no conversation energy reaches her meanwhile (she runs on her reserve). Fix: make sure Ollama is running and reachable at the configured host.` }); }
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }
        // Only the scores are logged here: topic and creation_id are text, and an id like "12" compares as >= 0.3
        // (Nov 10: "v.toFixed is not a function" whenever someone reacted to something he'd made, and the line was lost).
        activity('intake', { conversation, speaker: line.speaker.name, ...Object.fromEntries(Object.entries(sig).filter(([, v]) => typeof v === 'number' && v >= 0.3).map(([k, v]) => [k, +v.toFixed(2)])) });
        try { onSignals(sig, { speaker: line.speaker, conversation, owner: line.owner, addressed: line.addressed, text: line.text, now: now() }); }
        catch (err) { activity('error', { where: 'intake', message: `The read worked but didn't reach her pressure: ${err.message}` }); }
        // A reaction to something she made settles what it was worth (creations.js): the person's verdict, not hers.
        if (sig.creation_liked >= 0.3 || sig.creation_disliked >= 0.3) {
          Promise.resolve(onFeedback(sig, { speaker: line.speaker, conversation, text: line.text }))
            .catch((err) => activity('error', { where: 'intake', message: `A reaction to something she made was read but couldn't be recorded: ${err.message}. Check creations.js.` }));
        }
      }
    } finally { inFlight.delete(conversation); }
  }

  return {
    // A line someone said. addressed: whether the caller already knows it was for her (she's replying to it).
    hear({ conversation, speaker, text, recent = [], owner = false, addressed = null }) {
      if (!speaker?.id || !String(text ?? '').trim()) return false;
      // Overheard, and nothing in her has her listening: unread, so it barely reaches her. Lines in a call are always read
      // (2026-11-11): what the room says to each other is what he reads the quiet from, even when it isn't to him.
      if (!addressed && !listening() && !String(conversation ?? '').startsWith('voice:')) {
        try { onOverheard({ text, speaker, conversation }); } catch {}
        return false;
      }
      waiting.set(conversation, { conversation, speaker, text, recent, owner, addressed });
      pump(conversation).catch((err) => activity('error', { where: 'intake', message: err.message }));
      return true;
    },
    status: () => ({ outage, pausedUntil, inFlight: [...inFlight.keys()], waiting: [...waiting.keys()] }),
  };
}

let shared;
export const intake = () => (shared ??= createIntake());

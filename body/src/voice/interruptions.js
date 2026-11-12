import { config } from '../config.js';
import { activity } from '../events.js';

// Being interrupted, for one voice call (one per session). Ported from Amy-Voice's interruption engine
// (INTERRUPTION-ENGINE.md there).
//
// When someone talks over her for real (session.js: a sustained stretch with actual words in it), she
// stops and what she was saying is held. Once their words are transcribed, a model reads what they
// actually said and decides what kind of interruption it was. Polite ones (talking to her, reacting
// to her) cost nothing. Rude ones (a side chat over her, talking her down, arguing over her) raise
// this call's interruption level, more for worse kinds, longer, louder and repeated ones; that feeds
// her irritation and goes on her memory of the person. What she does about it is hers: she's told the
// situation, never handed lines.

export const KINDS = {
  to_her: { weight: 0, polite: true, about: 'cutting in to talk to you (a question, a correction, something they needed to tell you)' },
  reacting: { weight: 0, polite: true, about: 'reacting to what you were saying (laughing, agreeing, "no way")' },
  side_chat: { weight: 0.45, about: 'holding a side conversation with someone else while you were talking' },
  talking_down: { weight: 0.8, about: 'talking you down, shutting you up or drowning you out' },
  arguing: { weight: 1.0, about: 'arguing with someone else over you' },
};

const HELD_MS = 3 * 60_000;     // after this, what she was saying isn't worth coming back to
const UNDERSTAND_MS = 30_000;   // their words have to arrive this soon after the cut

// Reading the interruption is her own judgment, so it runs on the local model, never the cloud brain.
// The answer is a few words of JSON, so it's capped short: carrying on after "sorry, go ahead" waits on it.
async function classifyWithModel(messages) {
  const { json } = await import('../llm.js');
  return json(messages, { maxTokens: 120 });
}

// What counts as handing the floor back, for the model reading their words (never a word list).
const CARRY_ON = (name) => `carry_on: true when their words hand the floor back to ${name}: telling or inviting ${name} to keep going or finish (an apology for cutting in, "go on"), or a quick reaction that needs no answer. False when they want an answer, correct something ${name} said, ask ${name} to do something else (even politely, as a suggestion), want ${name} to stop or wait, changed the subject, or were talking to someone else. Only a plain invitation to finish the same point is carry_on.`;

export class Interruptions {
  constructor({ classify = classifyWithModel, now = Date.now, onRude = () => {} } = {}) {
    this.classify = classify; this.now = now; this.onRude = onRude;
    this.level = 0;      // 0..1 for this call: how talked over she's been lately
    this.at = now();
    this.held = null;    // { said, cut, rest, at }
    this.pending = null; // { id, name, at, overlapMs, talkers }: waiting for their words
    this.events = [];    // this call's interruptions, newest last
  }

  // The level holds where the interruptions left it; nothing fades it on a clock.
  decay() {
    const t = this.now();
    this.at = t;
    if (this.held && t - this.held.at > HELD_MS) this.held = null;
    return this.level;
  }

  // She was cut off: hold what she was saying, and note who did it until their words come in.
  cutOff({ id, name, overlapMs = 0, talkers = 1, said = '', cut = '', rest = [] }) {
    this.decay();
    this.held = { said, cut, rest, at: this.now() };
    this.pending = { id, name, at: this.now(), overlapMs, talkers };
    activity('interrupted', { by: name, overlapMs, talkers, cut: String(cut).slice(0, 120) });
  }

  // What set it off had no words (noise, a breath): it never happened.
  noWords(id) {
    if (this.pending?.id !== id) return;
    this.pending = null;
  }

  // Their words are in: what kind of interruption was it? Returns the event, or null.
  async understand({ id, name, text, recent = '' }) {
    const p = this.pending;
    if (!p || p.id !== id || this.now() - p.at > UNDERSTAND_MS) return null;
    this.pending = null;
    const read = await this.classify([
      { role: 'system', content: `You judge what was happening when someone talked over ${config.botName}, a woman in a voice call. Reply with JSON only: {"kind":"","carry_on":false,"why":""}\n${CARRY_ON(config.botName)}\nwhy: a few words.` },
      { role: 'user', content:
        `The conversation just before:\n${String(recent).slice(-1500)}\n\n` +
        `${config.botName} was saying: "${[this.held?.said, this.held?.cut].filter(Boolean).join(' ').slice(-300)}"\n` +
        `${name} talked over her for ${(p.overlapMs / 1000).toFixed(1)} seconds${p.talkers > 1 ? `, while ${p.talkers - 1} other ${p.talkers - 1 === 1 ? 'person was' : 'people were'} talking too` : ''}, saying: "${String(text).slice(0, 400)}"\n\n` +
        `Which was it?\n` +
        `- to_her: talking to ${config.botName} (a question, a correction, asking her to wait or stop, cutting in to tell her something), said decently.\n` +
        `- reacting: a reaction to what she was saying, not a new subject: laughing, "no way", "that's hilarious", agreeing, a quick comment on her point.\n` +
        `- side_chat: talking to someone else about a different subject while she talks.\n` +
        `- talking_down: shutting her up rudely, insulting her, talking her down or deliberately drowning her out.\n` +
        `- arguing: disagreeing, bickering or fighting with someone else in the call while she talks (telling someone they're wrong, "you always do this").` },
    ]).catch((err) => { activity('error', { where: 'interruption', message: err.message }); return null; });
    const kind = KINDS[read?.kind] ? read.kind : 'side_chat';
    const why = String(read?.why ?? '').slice(0, 120);
    const recentOnes = this.events.filter((e) => this.now() - e.at < 5 * 60_000 && !KINDS[e.kind].polite).length;
    const sev = KINDS[kind].polite ? 0 : Math.min(1, KINDS[kind].weight
      * (0.8 + Math.min(0.6, Math.max(0, p.overlapMs - 1200) / 4000))
      * (p.talkers > 1 ? 1.25 : 1)
      * (1 + 0.25 * recentOnes));
    this.decay();
    this.level = Math.min(1, this.level + sev * 0.45);
    const ev = { id, name, kind, why, carryOn: read?.carry_on === true, sev: +sev.toFixed(2), at: this.now(), text: String(text).slice(0, 160) };
    this.events.push(ev);
    this.events = this.events.slice(-30);
    if (sev > 0) this.onRude(ev);
    activity('interruption-understood', { by: name, kind, carryOn: ev.carryOn, sev: ev.sev, level: +this.level.toFixed(2), why });
    return ev;
  }

  // A later line, while what she was saying is still held ("oh sorry, go ahead" after the cut was
  // already read): does it hand the floor back? Read by the same model; unsure or unreachable is no.
  async handsBack({ name, text, said = '' }) {
    const read = await this.classify([
      { role: 'system', content: `${config.botName} was cut off mid-point in a voice call and stopped. Someone just spoke. Does it hand the floor back? Reply with JSON only: {"carry_on":false}\n${CARRY_ON(config.botName)}` },
      { role: 'user', content: `${config.botName} was saying: "${String(said).slice(-300)}"\n${name} just said: "${String(text).slice(0, 400)}"` },
    ]).catch((err) => { activity('error', { where: 'interruption hand-back', message: `Couldn't read whether ${name} handed the floor back: ${err.message}. ${config.botName} waits for a gap instead.` }); return null; });
    return read?.carry_on === true;
  }

  // She decided it was warranted: that person's recent interruptions come off this call's level.
  forgive(name = '') {
    const who = String(name).toLowerCase();
    const mine = this.events.filter((e) => !KINDS[e.kind].polite && (!who || e.name.toLowerCase().includes(who)));
    this.level = Math.max(0, this.level - mine.reduce((s, e) => s + e.sev * 0.45, 0));
    this.events = this.events.filter((e) => !mine.includes(e));
    activity('interruption-forgiven', { who: name || 'everyone', count: mine.length });
    return mine.length;
  }

  // For her prompt: what just happened, her held thought, and how worn down she is by it.
  note() {
    this.decay();
    const recent = this.events.filter((e) => this.now() - e.at < 10 * 60_000);
    if (!recent.length && !this.held) return '';
    const last = recent.at(-1);
    const rude = recent.filter((e) => !KINDS[e.kind].polite);
    const parts = [];
    if (last && this.now() - last.at < 60_000) parts.push(`${last.name} just cut you off mid-sentence: ${KINDS[last.kind].about}.${KINDS[last.kind].polite ? ' That was fair: answer them.' : ''}`);
    if (rude.length > 1) {
      const by = {};
      for (const e of rude) by[e.name] = (by[e.name] ?? 0) + 1;
      parts.push(`You've been talked over ${rude.length} times in the last few minutes (${Object.entries(by).map(([n, c]) => `${n} ${c}`).join(', ')}).`);
    }
    if (this.held) parts.push(`You were cut off saying: "${[this.held.said, this.held.cut].filter(Boolean).join(' ').slice(-240)}"${this.held.rest.length ? ` and were about to say: "${this.held.rest.join(' ').slice(0, 240)}"` : ''}. That's what you were about to say, not a script: they heard the start, so never repeat or restart it. Answer what they said now; come back to what's left in new words only if it still matters, or let it go, or make a point of having been cut off.`);
    const l = this.level;
    parts.push(l > 0.75 ? "You're furious about being talked over again and again. You're done being polite about it: being blunt, swearing, calling them out by name, talking right over them are all yours if that's what you feel."
      : l > 0.45 ? "It's really getting under your skin, and you're not inclined to let it slide quietly."
      : l > 0.15 ? "It's a little annoying." : '');
    if (rude.length) parts.push('What you do about it is yours. If you decide it was warranted, you can let it go (let_it_go).');
    return parts.filter(Boolean).join(' ');
  }
}

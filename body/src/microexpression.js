// Microexpression engine: drives the avatar's face from what actually happens in conversation, on
// every turn, not just in the studio's own chat. Each turn feeds the avatar emotion state from two
// signals - how the other person's words land on her (reaction) and what her own reply carries
// (expression) - then broadcasts an `avatar-expression` event that connected avatar viewers turn
// into live micro-motion on her face. The feelings persist through the shared emotion state, so
// the next turn starts from where this one left off and the face keeps adjusting itself.
import * as emotion from './emotion.js';
import { emotionKey } from './characters.js';
import { bus } from './events.js';

// A small word-level vocabulary. A turn rarely carries an explicit feeling tag outside the studio,
// so the engine reads the words themselves, the way a person picks up a tone of voice.
const LEXICON = [
  { name: 'angry',      words: /\b(hate|fuck|shit|damn|mad|angry|pissed|furious|rage|asshole|idiot|stupid|dumb|useless|jerk|shut up|wtf|dammit)\b/i },
  { name: 'annoyed',    words: /\b(ugh|annoying|frustrat|ridiculous|seriously\?|whatever|unbelievable|fed up|sick of|tired of|pissed off|done with)\b/i },
  { name: 'frustrated', words: /\b(frustrat\w*|exasperat\w*|can't (do|figure) this|cant (do|figure) this|so done|enough of this|this is (ridiculous|impossible|hopeless)|at my wits end|gah)\b/i },
  { name: 'sad',        words: /\b(sad|miss|sorry|hurt|cry|alone|heartbroken|depress|down|unhappy|worst|awful)\b/i },
  { name: 'joy',        words: /\b(happy|love|awesome|amazing|great|yay|awesome|excited|wonderful|perfect|beautiful|congrat|proud of)\b/i },
  { name: 'amused',     words: /\b(lol|lmao|haha|funny|hilarious|giggle|rofl|hehe|joke|kidding)\b/i },
  { name: 'flirty',     words: /\b(babe|cutie|handsome|gorgeous|pretty|sexy|sweetie|darling|kiss|hug|flirt|naughty)\b/i },
  { name: 'fond',       words: /\b(thank|appreciate|grateful|caring|sweet|kind|miss you|love you)\b/i },
  { name: 'surprised',  words: /\b(wow|whoa|no way|seriously|really\?|wait,? what|omg|can't believe|unbelievable)\b/i },
  { name: 'confused',   words: /\b(what\?|huh|confus|don't get|dont get|unclear|weird|strange|mixed up|cross.?eye)\b/i },
  { name: 'skeptical',  words: /\b(sure it did|right\.{2,}|doubt|suspect|liar|b.s\.|bullshit|prove it|suuure)\b/i },
  { name: 'worried',    words: /\b(worried|nervous|anxious|afraid|scared|concerned|stress|panic|sick)\b/i },
  { name: 'excited',    words: /\b(can't wait|cant wait|so pumped|amazing news|finally|let's go|lets go|tonight|weekend)\b/i },
  { name: 'pensive',    words: /\b(hmm|maybe|i guess|thinking|wonder|suppose|consider|reflect)\b/i },
  { name: 'determined', words: /\b(i will|gonna|going to fix|let me try|try again|keep going|do it myself)\b/i },
];

// Rough lexical read of a block of text: feelings with strengths 0..1 based on how strongly the
// language lands. Returns {} when nothing matches.
function lexicalFeelings(text) {
  const out = {};
  for (const { name, words } of LEXICON) {
    const hits = (text.match(words) || []).length;
    if (hits) out[name] = Math.min(1, 0.45 + 0.18 * hits + (/\b(very|so|really|absolutely|screw|god|damn)\b/i.test(text) ? 0.1 : 0));
  }
  return out;
}

// The reaction half of a turn: how she reacts, as the one listening, to how the other person feels.
// Their feeling is never copied onto her: their frustration or grief gets her concern, their joy gets
// her happiness for them, their anger makes her attentive.
const LISTENER = {
  angry: { worried: 0.5, pensive: 0.3 }, annoyed: { worried: 0.3, pensive: 0.2 }, frustrated: { worried: 0.45, fond: 0.2 },
  sad: { worried: 0.5, fond: 0.4 }, worried: { worried: 0.4, fond: 0.3 }, joy: { joy: 0.6, fond: 0.3 }, excited: { joy: 0.5, curious: 0.3 },
  amused: { amused: 0.7 }, fond: { fond: 0.7 }, surprised: { curious: 0.6 }, confused: { curious: 0.5 }, skeptical: { pensive: 0.5 },
  pensive: { curious: 0.4 }, determined: { fond: 0.3, confident: 0.3 }, flirty: {},
};
const heardFeelings = (text) => {
  const theirs = { ...(emotion.guessFromUser(text) || {}) };
  for (const [name, v] of Object.entries(lexicalFeelings(text))) theirs[name] = Math.max(theirs[name] || 0, v * 0.7);
  const mine = {};
  for (const [name, v] of Object.entries(theirs)) for (const [m, k] of Object.entries(LISTENER[name] ?? {})) mine[m] = Math.max(mine[m] || 0, v * k);
  return mine;
};

// The expression half: what her own reply carries while she says it.
const replyFeelings = (text) => {
  const fromWords = lexicalFeelings(text);
  const scored = emotion.guessFromReply(text) || {};
  for (const [name, v] of Object.entries(fromWords)) scored[name] = Math.max(scored[name] || 0, v * 0.85);
  return scored;
};

// Drive one turn's expression for the given character. `heard` is what was said to her, `reply`
// what she says back. Feeds the same feelings store the studio reads and broadcasts the change to
// live avatar viewers.
export function feedExpression({ character = 'main', heard = '', reply = '' }) {
  const feelings = { ...heardFeelings(heard), ...replyFeelings(reply) };
  if (!Object.keys(feelings).length) return null;
  const key = emotionKey(character);
  // nudge keeps her current mood and adds this turn's read; feel() would overwrite it.
  const next = emotion.nudge(key, feelings);
  bus.emit('avatar-expression', { character, feelings: next, at: Date.now() });
  return next;
}

// The trained face model's read of a turn, shown the same way.
export function showFeelings(character = 'main', feelings) {
  const next = emotion.nudge(emotionKey(character), feelings);
  bus.emit('avatar-expression', { character, feelings: next, at: Date.now() });
  return next;
}

// Exposed for tests / status: the engine's current read of the live avatar conversation, and what
// the dashboard uses to show the expression row.
export function expressionState(character = 'main') {
  return emotion.current(emotionKey(character));
}
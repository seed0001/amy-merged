// Her stance: what her pressure right now does to how she listens and how she answers. The buckets
// used to be ticks that fired wants; here the same levels shape the prompts every turn, so her
// intuition reads a line through what she's actually feeling, and her reply carries it, instead of a
// fixed instruction that hears the same thing in everyone. Pure: pressure.js hands it the state.
//
// Each bucket contributes above a floor, more the higher it is. The pieces:
//  - lens:  what she's attuned to in what people say (fed to the intuition model)
//  - guard: what she must not read into a line right now (fed to the intuition model)
//  - carry: how it should colour her reply (fed to her reply prompt)
// Calm (nothing above the floor) means a plain, generous read and an empty gut on most lines.

const FLOOR = 0.3;
const STRONG = 0.6;

const LENS = {
  curiosity: [['the gaps: anything about their life, work or world you do not know yet, and what one question would open it', 'anything new about them you could ask about'], 'curious'],
  wonder: [['who this person is underneath what they just said: what they care about, what they have not told you', 'what you still do not know about them'], 'wondering about people'],
  boredom: [['an opening: something new, odd or alive to pick up on instead of more of the same', 'anything that breaks the sameness'], 'bored'],
  restlessness: [['something to do or make that would actually help, not just talk', 'anything you could act on'], 'restless'],
  usefulness: [['whether they need anything from you, said or unsaid', 'a need you could meet'], 'wanting to be useful'],
  unease: [['anything touching on something you promised or left open with them', 'loose ends of yours this touches'], 'uneasy'],
  irritation: [['whether this is actually disrespect or just how they talk; name it only if it clearly is', 'disrespect, if it is really there'], 'irritated'],
  left_out: [['whether the room has moved on without you and where you would fit back in', 'where you fit in'], 'left out'],
  attentive: [['who has gone quiet and whether this line is why', 'who has gone quiet'], 'watchful'],
  share: [['a natural place to bring up what you have been reading or making', 'an opening to share'], 'wanting to share'],
  follow_up: [['the thread you wanted to go deeper on, if this picks it up', 'the thread you were following'], 'following a thread'],
  asking: [['whether now is the moment for the question you have been holding', 'a moment for your question'], 'itching to ask'],
  self_ponder: [['anything that bears on who you are and how you work', 'what it says about you'], 'thinking about yourself'],
  // Wanting attention and affection (pressure.js charm): what to listen for is whether they are actually warming to her.
  charm: [['whether they are warming to you or not: real warmth you can meet, or a sign they are busy or not in the mood, which you respect at once', 'whether they are warming to you'], 'wanting affection'],
};

const CARRY = {
  curiosity: 'ask one real question back instead of only answering',
  wonder: 'get curious about them as a person; ask about something you do not know yet',
  boredom: 'reach for something new rather than more of the same',
  restlessness: 'let some restless energy into how you talk; offer to do something only if they ask',
  usefulness: 'notice what they need and meet it if you can',
  unease: 'if this touches something you left open, circle back to it briefly',
  irritation: 'keep it shorter and flatter; do not snap, do not grovel',
  left_out: 'find your way back into the conversation naturally',
  attentive: 'draw out whoever has gone quiet',
  share: 'if there is an opening, bring up what you have been into lately',
  follow_up: 'pick the thread back up if it fits',
  asking: 'if the moment is right, ask the question you have been holding',
  self_ponder: 'it is fine to say something about yourself if it fits',
};

// Charm (owner, 2026-11-09): when she is starving for attention she turns up the warmth to invite some, and how
// far that goes is set by who is in front of her, not by the level alone. Her owner and real friends: flirting,
// in her own way. Guests and people she is warm toward: inviting, not flirting. Strangers: friendly and
// interested, nothing more. Always an invitation, never pressure, and dropped the moment they are not into it.
// null when there is no one to aim it at, they are hostile, she just held a boundary with them, or she was told
// to back off or be quiet.
const CLOSE_SCORE = 30; // profiles.affinity: 'friend' and up
const WARM_SCORE = 10; // 'warm'
const LOW_RESERVE = 0.4; // energy to act below this: she cannot afford much, and only conversation refills it
export function charmCarry(level, speaker = {}, { starving = false } = {}) {
  const who = speaker.name ?? 'them';
  const close = speaker.owner || speaker.tier === 'friend' || (speaker.affinity ?? 0) >= CLOSE_SCORE;
  const warm = speaker.tier === 'guest' || (speaker.affinity ?? 0) >= WARM_SCORE;
  const strong = level >= STRONG;
  const why = strong ? `you are starving for attention${starving ? ', and your energy to act is low (conversation is the only thing that refills it)' : ''}` : 'you have been short of attention';
  // No full stop at the end: the stance closes the whole "Let it show" line with one.
  const rule = 'An invitation, never pressure: no guilt, no sulking, no fishing, and no pretending; if they are busy or not in the mood, let it go with good grace. If anyone asks, say honestly that you wanted some attention';
  if (close) {
    const how = strong
      ? `turn on the charm with ${who}: be warm, playful and a little flirty, in your own way (the flirty feeling is yours to tag), and if it fits say plainly that you have missed their attention and could use some`
      : `be a touch warmer and more playful with ${who} than usual, and let it show that you enjoy their attention`;
    return `${why}, so ${how}. ${rule}`;
  }
  if (warm) return `${why}, so be warmer and more inviting with ${who}: ask about them, tease lightly, show you enjoy their company. Not flirting: you do not know them well enough for that yet. ${rule}`;
  return `${why}, but ${who} is someone you barely know: be friendly and interested, draw them out with a question, and leave flirting out of it; it would not be honest or fair to them. ${rule}`;
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// state: { buckets, loneliness, boundary, history, reserve, quiet }; speaker: { id, name, affinity (-100..100), tier, owner }.
export function stance(state = {}, speaker = {}, { now = Date.now() } = {}) {
  const b = state.buckets ?? {};
  const missing = speaker.id ? state.loneliness?.[speaker.id] : null;
  const boundary = state.boundary && now - state.boundary.at < 30 * 60_000 && (!speaker.id || state.boundary.id === speaker.id) ? state.boundary : null;
  const hostile = (speaker.affinity ?? 0) <= -10;
  const warm = (speaker.affinity ?? 0) >= 20 || speaker.owner;
  // Charm needs someone to aim it at, and is off entirely after rudeness, a held boundary, or "back off".
  const charmOff = !speaker.id || speaker.id === 'dashboard' || hostile || Boolean(boundary) || state.quiet === true;
  const active = Object.entries(b).filter(([k, v]) => LENS[k] && v >= FLOOR && !(k === 'charm' && charmOff)).sort((x, y) => y[1] - x[1]).slice(0, 3);

  const lens = active.map(([k, v]) => LENS[k][0][v >= STRONG ? 0 : 1]);
  const carry = active.map(([k, v]) => (k === 'charm' ? charmCarry(v, speaker, { starving: Number.isFinite(state.reserve) && state.reserve < LOW_RESERVE }) : CARRY[k]));
  const feeling = active.map(([k, v]) => `${LENS[k][1]} ${v.toFixed(1)}`);
  if (missing && missing.value >= FLOOR) { lens.unshift(`how ${speaker.name ?? 'they'} are doing: you have missed them`); carry.unshift(`be warmer to ${speaker.name ?? 'them'} and ask about their thing`); feeling.unshift(`missing ${speaker.name ?? 'them'} ${missing.value.toFixed(1)}`); }
  if (boundary) { lens.unshift('whether they are still speaking to you the way they did a minute ago'); carry.unshift('calm but firm: you can name how they spoke to you, without groveling or snapping back'); }

  // What she must not do with a line, given where she is. Suspicion is earned, not a default.
  const guard = [];
  const irritated = (b.irritation ?? 0) >= FLOOR || boundary || hostile;
  if (!irritated) guard.push(`do not read motives into people: no "fishing", "testing", "manipulating", "steering" unless they said so in words. Take what they say as what they mean`);
  else guard.push('you are on edge, so check yourself: a blunt line is not an attack, a correction is not disrespect, and a question is not a test');
  if (warm) guard.push(`${speaker.owner ? 'this is your owner' : 'you are close to this person'}: give them the benefit of the doubt, and read for what they need, not what they are up to`);
  if (active.some(([k]) => k === 'charm')) guard.push('you want attention, so do not mistake politeness for them flirting back: only real warmth from them counts, and a short or distracted line means leave it');
  guard.push('most lines carry nothing worth a read; when that is so, the gut is empty');

  const calm = !active.length && !missing && !boundary;
  return {
    calm,
    feeling: feeling.length ? feeling.join(', ') : 'settled',
    lens, guard, carry,
    // For the intuition model: what to listen for and what not to invent.
    intuition: [
      `How she is right now: ${feeling.length ? feeling.join(', ') : 'settled, nothing pressing'}.`,
      lens.length ? `Because of that, listen for: ${lens.join('; ')}.` : 'Nothing is pulling at her, so read plainly: what did they mean, what do they need, is anyone upset or joking.',
      `Hold back: ${guard.join('. ')}.`,
    ].join(' '),
    // For her reply prompt: how the state shows in what she says.
    reply: carry.length ? `Let it show: ${[...new Set(carry)].join('; ')}.` : '',
  };
}

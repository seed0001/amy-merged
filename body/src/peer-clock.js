// Group talk awareness: the companions may talk with each other freely and name each other as
// much as they like; nothing here counts names or handoffs. It only keeps time. Once the bots have
// carried a stretch on their own for a while (PEER_TALK_MINUTES, 4.5 by default) their reply gets
// a quiet nudge to wrap up naturally, check in with the people, or pick something new, sooner if
// they're circling the same words. A person talking resets the stretch, "keep talking for ten
// minutes" from an owner moves the nudge out, and a person telling them to stop ends bot-to-bot
// replies at once until a person speaks again. Everything they say is still heard and remembered.

const WRAP_MS = (Number(process.env.PEER_TALK_MINUTES) > 0 ? Number(process.env.PEER_TALK_MINUTES) : 4.5) * 60_000;
const IDLE_MS = 2 * 60_000; // a lull this long and the next bot line starts a fresh stretch
const state = new Map(); // conversation -> { since, lastPeer, extendUntil, stopped, recent, nudged }

const get = (c) => {
  if (!state.has(c)) state.set(c, { since: null, lastPeer: 0, extendUntil: 0, stopped: false, recent: [], nudged: false });
  return state.get(c);
};

// "you guys can stop", "okay everyone, that's enough", "stop talking": aimed at the room, not a story about someone.
const GROUP = "(?:you guys|you two|you all|y'?all|all of you|everyone|everybody|guys|ladies|folks|bots|companions)";
export function isGroupStop(text) {
  const t = String(text ?? '').toLowerCase().replace(/[’]/g, "'");
  if (/\b(?:don'?t|do not|never|can'?t|didn'?t|won'?t)\s+(?:\w+\s+)?(?:stop|wrap|be quiet|hush)\b/.test(t) || keepGoingMinutes(t)) return false;
  return new RegExp(`\\b${GROUP}\\b[^.?!]{0,25}\\b(?:stop|knock it off|wrap (?:it|this) up|be quiet|hush|that'?s enough)\\b`).test(t)
    || new RegExp(`\\b(?:stop|knock it off|wrap (?:it|this) up|be quiet|hush|that'?s enough)\\b[^.?!]{0,15}\\b${GROUP}\\b`).test(t)
    || /^\s*(?:(?:hey|okay|ok|alright|all right|please)[,\s]+)*(?:stop talking|stop|that'?s enough|enough|quiet|hush)(?:\s+(?:now|please|for now))*[.!\s]*$/.test(t);
}

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'a couple': 2, 'a couple of': 2, couple: 2, 'a few': 3, few: 3 };
// "go ahead and keep talking for a couple of minutes", "carry on for 10 more minutes": minutes, or null.
export function keepGoingMinutes(text) {
  const t = String(text ?? '').toLowerCase().replace(/[’]/g, "'");
  if (!/\b(?:keep (?:on )?(?:talking|going|chatting|it going|the conversation going)|carry on|continue (?:talking|the conversation|chatting)|don'?t stop|go on talking)\b/.test(t)) return null;
  if (/\b(?:half an? hour|thirty minutes)\b/.test(t)) return 30;
  if (/\b(?:an|one) hour\b/.test(t)) return 60;
  const m = t.match(/\b(\d+|a couple(?: of)?|couple|a few|few|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty)\s+(?:more\s+)?(?:minutes?|mins?)\b/);
  if (m) return Math.min(120, Number(m[1]) || WORDS[m[1]] || 5);
  if (/\b(?:a while|a bit longer|a while longer)\b/.test(t)) return 10;
  return 5;
}

const STOP = new Set('about after again also another because been being could does doing done from have here just know like more much really right said says some something than that their them then there these they thing think this those through very want well were what when where which while will with would yeah your yours going gonna okay'.split(' '));
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z']{4,}/g)?.filter((w) => !STOP.has(w)) ?? []);
// The last few bot lines keep returning to the same words: they're going round in circles.
export function circling(lines) {
  if (lines.length < 4) return false;
  const sets = lines.slice(-4).map(words);
  let sum = 0, n = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    const a = sets[i], b = sets[j];
    const union = new Set([...a, ...b]).size;
    if (union) { sum += [...a].filter((w) => b.has(w)).length / union; n++; }
  }
  return n > 0 && sum / n >= 0.2;
}

// Called for every line heard in a conversation (text channel or voice call).
export function heard(conversation, { peer, text, owner = false, now = Date.now() }) {
  const s = get(conversation);
  if (!peer) {
    if (isGroupStop(text)) {
      Object.assign(s, { stopped: now, since: null, recent: [], nudged: false, extendUntil: 0 });
      return 'stop';
    }
    const minutes = owner ? keepGoingMinutes(text) : null;
    Object.assign(s, { stopped: false, since: null, recent: [], nudged: false });
    if (minutes) { s.extendUntil = now + minutes * 60_000; return 'extend'; }
    return 'person';
  }
  if (s.since == null || now - s.lastPeer > IDLE_MS) Object.assign(s, { since: now, recent: [], nudged: false });
  s.lastPeer = now;
  s.recent = [...s.recent, String(text ?? '')].slice(-6);
  return 'peer';
}

// Whether a bot line may still be answered: not after a person told them to stop (for a quarter hour
// at most, if nobody speaks again in the meantime).
const STOP_MS = 15 * 60_000;
export function peersMayTalk(conversation, now = Date.now()) {
  const stopped = state.get(conversation)?.stopped;
  return stopped === false || stopped == null || now - stopped > STOP_MS;
}

// A note for the reply prompt, or '' while the bots' stretch is still young. `onNudge` fires once a stretch.
export function block(conversation, { now = Date.now(), onNudge } = {}) {
  const s = state.get(conversation);
  if (s?.since == null || s.stopped !== false) return '';
  const minutes = Math.round((now - s.since) / 60_000);
  const extended = s.extendUntil > now;
  const wrapAt = Math.max(s.since + WRAP_MS, s.extendUntil);
  const loop = circling(s.recent);
  if (extended && now < wrapAt) {
    return `The owner asked you companions to keep talking for about ${Math.ceil((s.extendUntil - now) / 60_000)} more minute(s). Carry on naturally; no need to wrap up yet.`;
  }
  const due = now >= wrapAt || (loop && now >= wrapAt - 90_000);
  if (!due) return '';
  if (!s.nudged) { s.nudged = true; onNudge?.({ minutes, circling: loop }); }
  const why = loop ? `and the last few lines keep circling the same points` : `on this thread`;
  const overtime = now - wrapAt > 2.5 * 60_000;
  return `Group talk check: you and the other companions have been talking among yourselves for about ${minutes} minute(s) without the people in the room joining in, ${why}. `
    + (overtime
      ? 'Close it now: one short, warm line that wraps it up or asks the people what they would like; do not hand the topic back to another companion.'
      : 'In your own words and without mentioning this note, start wrapping it up naturally: land the thought, check in with the people in the room, or move to a genuinely new topic. Keep it brief.');
}

export function _reset() { state.clear(); }

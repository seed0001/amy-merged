// Her Fish Audio voices in a call: normal, strong, sensual and whisper. The framework picks between
// them, not the model: autoTone runs pickTone's fixed rules on every line heard in a call (session.js)
// and she is only told which voice is on and why.
// - strong wears off by itself after STRONG_MS, so she never gets stuck in it;
// - a tone the rules picked is held HOLD_MS after the last line that called for it; meanwhile only a
//   higher-priority tone can replace it, so it doesn't flip every sentence;
// - the owner can force any voice ("override"), which pins it for PIN_MS, during which the rules
//   leave it alone; "auto" hands the choice back.
// State is per conversation and in memory: a restart always starts in the normal voice.

import { wornVoice, voiceLine } from './library.js';

export const STRONG_MS = 15 * 60_000;
export const PIN_MS = 30 * 60_000;
export const HOLD_MS = 2 * 60_000;

// Each extra tone and the config.fish field holding its Fish Audio voice ID.
export const VOICES = { strong: 'strongVoiceId', sensual: 'sensualVoiceId', whisper: 'whisperVoiceId' };
const LABEL = { strong: 'stronger', sensual: 'sensual', whisper: 'whisper' };

const state = new Map(); // conversation -> { tone, since, until, pinnedUntil, reason }

const mins = (ms) => Math.max(1, Math.round(ms / 60_000));

// '' when that tone can be used, else why not.
export function voiceReady(config, tone) {
  if (config.tts !== 'fish') return `Your ${LABEL[tone]} voice is a Fish Audio voice; you are speaking with a local engine right now.`;
  if (!config.fish[VOICES[tone]]) return `No ${LABEL[tone]} voice is set up yet. Your owner can add its Fish Audio voice ID in the dashboard under Settings > Voice.`;
  return '';
}
export const strongVoiceReady = (config) => voiceReady(config, 'strong');

// The current tone, after letting an expired strong voice wear off.
export function currentTone(conversation, now = Date.now()) {
  const s = state.get(conversation);
  if (!s) return { tone: 'normal' };
  if (s.tone === 'strong' && s.until <= now) {
    state.set(conversation, { tone: 'normal', since: now, until: 0, pinnedUntil: 0, reason: 'wore off' });
    return state.get(conversation);
  }
  return s;
}

// The Fish voice to speak with in this conversation (the normal voice unless another tone is on and set up).
// A voice she's wearing from the Fish library (voice/library.js) stands in for her regular voice in that
// conversation; her strong, sensual and whisper voices still take over when those are on.
export function voiceIdFor(conversation, config, now = Date.now()) {
  const { tone } = currentTone(conversation, now);
  return VOICES[tone] && !voiceReady(config, tone) ? config.fish[VOICES[tone]] : (wornVoice(conversation, now)?.id || config.fish.voiceId);
}

export function describeTone(conversation, config, now = Date.now()) {
  const s = currentTone(conversation, now);
  const missing = VOICES[s.tone] ? voiceReady(config, s.tone) : '';
  let text = `You are using your ${s.tone} voice${s.reason ? ` (${s.reason})` : ''}.`;
  if (s.tone === 'strong') text += ` It goes back to normal by itself in about ${mins(s.until - now)} min at most.`;
  if (s.pinnedUntil > now) text += ` Your owner pinned it for about ${mins(s.pinnedUntil - now)} more min; don't change it unless they ask.`;
  if (missing) text += ` ${missing}`;
  return text;
}

// action: status | normal | auto | strong | sensual | whisper. override only counts when the owner asked for it.
// Without override this is the framework's switch (autoTone); the voice_tone tool only lets her
// pass on what the owner asked for (tools.js).
export function setTone(conversation, { action = 'status', reason = '', override = false } = {}, { config, owner = false, now = Date.now(), activity = () => {} }) {
  if (!['status', 'normal', 'auto', ...Object.keys(VOICES)].includes(action)) throw new Error('Unknown voice tone action');
  const s = currentTone(conversation, now);
  if (action === 'status') return describeTone(conversation, config, now);
  if (override && !owner) throw new Error('Only your owner can force a voice. Choose for yourself, without override');
  if (action === 'auto') {
    if (!owner) throw new Error('Only your owner can hand the voice choice back');
    state.set(conversation, { ...s, pinnedUntil: 0 });
    return `Voice choice is yours again. ${describeTone(conversation, config, now)}`;
  }
  if (VOICES[action]) {
    const missing = voiceReady(config, action);
    if (missing) throw new Error(missing);
  }
  reason = String(reason ?? '').trim().slice(0, 120);
  if (!override) {
    if (s.pinnedUntil > now) throw new Error(`Your owner pinned your ${s.tone} voice; keep it for now (about ${mins(s.pinnedUntil - now)} more min) unless they ask`);
    if (action === 'strong' && s.tone === 'strong') {
      // Renewing keeps it going without counting as a switch.
      state.set(conversation, { ...s, until: now + STRONG_MS, reason });
      return describeTone(conversation, config, now);
    }
    if (action === s.tone) return describeTone(conversation, config, now);
  }
  state.set(conversation, {
    tone: action,
    since: now,
    until: action === 'strong' ? now + (override ? PIN_MS : STRONG_MS) : 0,
    pinnedUntil: override ? now + PIN_MS : 0,
    reason: reason || (override ? 'owner asked' : ''),
  });
  activity('voice-tone', { conversation, tone: action, override, reason });
  return describeTone(conversation, config, now);
}

// The automatic choice. Fixed priority, highest first: strong > whisper > sensual > normal.
export const RANK = { normal: 0, sensual: 1, whisper: 2, strong: 3 };

const INSULT = '(stupid|idiot|idiotic|dumb|dumbass|moron|useless|worthless|pathetic|retard|retarded|bitch|motherfucker|asshole|dickhead|prick|loser|cunt|whore|slut|piece of shit)';
const FILLER = '((are|re|is|s|so|such|a|an|really|fucking|fuckin|damn|sorry|little|dumb|stupid|absolute|complete|total)\\s+){0,3}';
const RULES = {
  // An insult aimed at her or at someone ("you sorry motherfucker", "she's so useless"), or telling someone off.
  strong: [
    new RegExp(`\\b(you|you're|youre|ur|u)\\s+${FILLER}${INSULT}\\b`),
    new RegExp(`\\b(he|she|they|he's|she's|they're|hes|shes|theyre)\\s+${FILLER}${INSULT}\\b`),
    /\b(shut (the fuck )?up|fuck (you|off)|screw you|go to hell|nobody asked you|kill yourself|kys)\b/,
  ],
  // A secret, gossip or a quiet aside.
  whisper: [
    /\bdon't tell (anyone|anybody|nobody|him|her|them)\b/,
    /\b(just )?between (you and me|me and you|us)\b/,
    /\bkeep (this|it) (between us|a secret|quiet|on the down ?low)\b/,
    /\b(can you keep a secret|(tell|telling) you a secret|i('ve| have)? got a secret|off the record)\b/,
    /\b(gossip|come closer|lean in|whisper)\b/,
    /\bdon't let (him|her|them) hear\b/,
  ],
  // Flirting or teasing; only counts when the speaker is the only other one in the call.
  sensual: [
    /\byou('re| are| look)\s+(so\s+|really\s+|looking\s+)?(sexy|hot|beautiful|gorgeous|pretty|cute|stunning)\b/,
    /\b(kiss|kisses|kissing|cuddle|cuddling|flirt|flirting|flirty|tease|teasing|naughty|seductive|seduce|babe|darling|sweetheart|sexy)\b/,
    /\bi (love|miss|missed) you\b/,
    /\bturn(s|ed|ing)? me on\b/,
    /\bcome to bed\b/,
  ],
};
const WHY = { strong: 'insult or someone being put down', whisper: 'a secret or quiet aside', sensual: 'flirting, just the two of you' };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// text: one line heard in the call. names: the people in the call, so "friend_3 is an idiot" counts.
// alone: the speaker is the only other one in the call. aroused: alone with someone she desires (relationship.js
// desire), which makes it sensual unless a stronger rule fires. Returns { tone, reason }.
export function pickTone({ text = '', alone = false, names = [], aroused = false } = {}) {
  const t = String(text).toLowerCase().replace(/[‘’]/g, "'");
  const named = names.filter((n) => n && n.length > 1).map((n) => escape(n.toLowerCase()));
  const strong = named.length ? [...RULES.strong, new RegExp(`\\b(${named.join('|')})('s|\\s+is)?\\s+${FILLER}${INSULT}\\b`)] : RULES.strong;
  for (const [tone, rules] of [['strong', strong], ['whisper', RULES.whisper], ['sensual', alone ? RULES.sensual : []]]) {
    const hit = rules.map((r) => t.match(r)).find(Boolean);
    if (hit) return { tone, reason: `${WHY[tone]}: "${hit[0].slice(0, 40)}"` };
  }
  if (aroused) return { tone: 'sensual', reason: 'alone with someone you desire' };
  return { tone: 'normal', reason: '' };
}

const lastHit = new Map(); // conversation -> when a line last called for the tone the rules have on

// Runs the rules on a heard line and switches her voice. An owner pin always wins; a held tone only
// gives way to a higher-priority one; a voice that isn't set up counts as normal. Returns the tone in use.
export function autoTone(conversation, heard, { config, now = Date.now(), activity = () => {} }) {
  const s = currentTone(conversation, now);
  if (s.pinnedUntil > now) return { tone: s.tone, changed: false };
  let want = pickTone(heard);
  // Her owner swearing at her is never a cue for her angry voice (owner, 2026-11-11: told off for changing his voices,
  // James answered in a female "strong" voice he'd just picked himself and dug in). His anger gets the regular voice.
  if (heard.owner && want.tone === 'strong') want = { tone: 'normal', reason: '' };
  if (VOICES[want.tone] && voiceReady(config, want.tone)) want = { tone: 'normal', reason: '' };
  if (want.tone === s.tone) {
    if (want.tone === 'normal') return { tone: s.tone, changed: false };
    lastHit.set(conversation, now);
    if (want.tone === 'strong') setTone(conversation, { action: 'strong', reason: want.reason }, { config, now, activity }); // renews the wear-off
    return { tone: s.tone, changed: false };
  }
  const held = now - (lastHit.get(conversation) ?? -Infinity) < HOLD_MS;
  if (held && RANK[want.tone] <= RANK[s.tone]) return { tone: s.tone, changed: false };
  setTone(conversation, { action: want.tone, reason: want.reason || 'nothing calls for another voice' }, { config, now, activity });
  if (want.tone === 'normal') lastHit.delete(conversation);
  else lastHit.set(conversation, now);
  return { tone: want.tone, changed: true };
}

// The line for her prompt: which voice is on and why. She speaks in it; she doesn't choose it.
export function toneBlock(conversation, config, now = Date.now()) {
  // Which voice she's in and why it last changed: if someone asks about her voice, she knows (owner, 2026-11-10).
  return `${describeTone(conversation, config, now)} Your voice is picked automatically from the conversation, not by you: speak in that register and never mention or announce it. ${voiceLine(conversation)} If someone asks about your voice or why it changed, that is what happened; voice_library history has every change.`;
}

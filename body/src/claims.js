import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Action claims, and the tool that has to have succeeded for each to be true. Override or extend
// in data/phantom-claims.json ({"tool": "regex"}); false alarms are cheaper than misses.
const CLAIMS = {
  send_file: /\b(i('ve| have)? sent|sent (it|that|you)|it'?s attached|attached (it|the file)|here'?s the file)\b/i,
  send_project: /\b(zipped (it|them|up)|sent (you )?the (project|zip))\b/i,
  post_message: /\b(i('ve| have)? posted|posted (it|that) (in|to)|dropped (it|that|the message) in)\b/i,
  files: /\b(i('ve| have)? (saved|written|wrote|created|edited|updated|changed|moved|renamed|copied)\b.{0,40}\b(file|folder|line|script|code|config)|(file|folder|script)\b.{0,25}\b(is |has been )?(saved|created|updated|edited))\b/i,
  obligations: /\b(on (my|the) (list|to-?do)|added (it|that|this) to (my|the) list|it'?s on my list|i'?ve (set|added) (a |the )?reminder)\b/i,
  checkin_consent: /\b(saved (it )?(to|on) your card|on your card|got it saved|noted (it )?on your (card|profile))\b/i,
  music: /\b(it'?s playing|now playing|playing (it )?now|started playing|i'?ve stopped|stopped (the )?(song|music|it)|paused (it|the song|the music))\b/i,
  generate_image: /\b(here'?s (your|the) (picture|image|drawing)|(image|picture) is ready|i drew)\b/i,
  generate_self_image: /\b(here'?s (me|my (picture|image|selfie|portrait))|(selfie|portrait|picture|image) is ready)\b/i,
  generate_music: /\b(song('s| is) (done|ready|finished)|i (made|wrote) (you )?a (song|track))\b/i,
  look: /\b(here'?s (me|my (new )?(look|outfit|picture|selfie))|(new )?(look|outfit|picture|selfie) is (ready|saved)|changed my profile (picture|image)|(saved|updated) (it|that) (as|to) my profile)\b/i,
  switch_brain: /\b(switched (over )?to|i'?m switched( over)?( to)?|i'?m now (on|running)|now running on)\b/i,
  git: /\b(i('ve| have)? (pushed|committed)|(pushed|committed) (it|them|the changes))\b/i,
  avatar_mode: /\bavatar mode (is )?(now )?(on|off)\b/i,
  inner_monologue: /\b(inner monologue|thinking out loud)\b.{0,20}\b(on|off)\b/i,
  solo_monologue: /\b(solo thoughts?|private thoughts?)\b.{0,30}\b(on|off|in #)\b|\bi'?ll think in #/i,
  voice_engine: /\b(switched|changed) (my|the) (voice|tts)\b|\bnow (speaking|talking) (with|on) (kokoro|fish|gtts|google)\b/i,
  voice_tone: /\b(switched|changed|switching|changing) (back )?to my (stronger|strong|powerful|normal|regular|usual|sensual|sexy|whisper|whispering) voice\b/i,
  // Needs look setup/new to have succeeded (companion.js), not just any look call.
  'look:replace': /\b((wiped|deleted|removed|replaced|got rid of|wiping|deleting|replacing) (it|her|(the |my |that |her )?(old )?(reference|ref|identity|look|face|persona))|(old )?(reference|identity)( sheet)? (is |has been )?(gone|deleted|wiped|replaced|updated)|new (persona|me)|(fresh|new)( \w+){0,3} (version|look) of me)\b/i,
  browser: /\b(i('ve| have)? opened|opened (it|that|the (page|site|link|browser))|(it'?s|the (page|site) is) (open|up) (in|on) (your|the) (browser|screen)|brought (?:my |the )?browser up)\b/i,
  rebuild_memories: /\b(started|kicked off) (the )?(memory )?rebuild\b/i,
  restart: /\b(restarting (now|myself|in a (moment|sec))|i'?m restarting|i'?ll restart (now|myself))\b/i,
  leave_voice: /\b(i'?m )?leaving the (call|voice)\b|\bhopping off (the )?(call|voice)\b/i,
  free_talk: /\bfree (?:talk|speech)(?: mode)? is(?:n['’]t| not)? (?:now |still |currently |listed as |set to )?(?:on|off)\b|\bturned (?:(?:on|off) free (?:talk|speech)(?: mode)?|free (?:talk|speech)(?: mode)? (?:on|off))\b/i,
  bring_peer: /\bi('ve| have| just)? (brought|started|pulled) (?!my\b|the browser\b|the page\b|the tab\b)\w+( \w+)? (in|up|into)\b/i,
  // Sending another bot out of the call or turning it off needs bot_control to have succeeded.
  bot_control: /\b((she|he|they)('s| is| are|'re)( \w+)? (heading|going|getting|hopping|on (her|his|their) way) (back )?(out|off)|(she|he|they)('ll| will) (leave|be gone|head out|hop off)|(i('ve| have)?|just) (sent|kicked|told) (her|him|them|\w+) (out|off|to leave))\b/i,
};
let claimOverrides = null;

// "Switched to X" fits any of her switches, not just the brain: a claim is true when one of these succeeded.
// Without this, "switched to the cloud model" after a real image_model switch got a false "didn't go through".
const ALSO = {
  switch_brain: ['image_model', 'voice_engine', 'voice_tone'],
  voice_engine: ['voice_tone'],
  // Her own playing comes out through the instrument tool, not music: "it's playing" after a real instrument
  // call is true (2026-11-10: James retracted a piece that was playing out loud because no music call ran).
  music: ['instrument'],
};

// Not a claim of her own: negated ("I haven't sent you", "didn't go through, nothing posted"), someone
// else did it ("Owner sent you"), or it's the doctor's work and the doctor's ok result is on record.
// Without this, honestly reporting an error got a canned "correction: that didn't go through" tacked on.
const NEGATED = /\b(not|never|cannot|can['’]?t|won['’]?t|(have|has|had|did|do|does|could|was|were|is|are)n['’]?t)\b[^.!?\n]{0,30}$/i;
// "I thought I sent", "I meant to post it": a belief or intention about an action, not a claim it happened.
const HEDGED = /\b(thought|think|believed|assumed|figured|meant|tried|trying|wanted|was going|hoped|should have|would have|could have|must have)\b[^.!?\n]{0,20}$/i;
const SELF = /(^|[.!?\n]\s*|\b(i|i['’]?ve|just|already|and|then|so|ok|okay|done|yep|yes|alright)[,\s]+)$/i;

// Tools that carry her words to someone else: the doctor, another bot. "Sent/told/asked/called/checked"
// aimed at them is satisfied by one of these succeeding, never by send_file or post_message.
const RELAY_TOOLS = ['doctor', 'bot_control', 'bring_peer'];
const RELAY_VERB = /\b(sent|send|told|tell|asked|ask|called|call|checked|check|pinged|messaged|relayed|forwarded|passed|handed|reported|notified|kicked|brought|pulled)\b/i;
// A relay sentence aimed at the owner himself ("sent it to you", "sent you the file") is still a file claim.
const TO_OWNER = /\b(to|for) you\b|\bsent you\b|\b(file|zip|attach|attached|attachment|photo|picture|image)\b/i;

// The whole sentence a match sits in (both sides), for checks that need its target.
function sentenceOf(text, m) {
  const before = text.slice(0, m.index);
  const start = before.search(/[^.!?\n]*$/);
  const after = text.slice(m.index + m[0].length);
  const end = after.search(/[.!?\n]/);
  return text.slice(start, end === -1 ? text.length : m.index + m[0].length + end);
}

// Tools that succeeded this turn, by name. Only names that can't be ordinary English are matched in
// her words: the doctor, and every two-word tool (free_talk, avatar_view, send_file...).
function namedDoneTool(sentence, succeeded) {
  for (const [tool, ok] of succeeded) {
    if (!ok) continue;
    const base = tool.split(':')[0];
    if (base !== 'doctor' && !base.includes('_')) continue;
    if (new RegExp(`\\b${base.replace(/_/g, '[ _-]?')}\\b`, 'i').test(sentence)) return base;
  }
  return null;
}

// Why a claim in `text` at match `m` isn't a false claim of hers: it's negated or hedged, the subject is
// someone else, the doctor did it and his ok is on record, or the sentence is about a tool that DID
// succeed this turn (she said "sent it to the doctor" and the doctor call was ok: that is not a send_file).
function notHers(text, m, doctorOk, succeeded) {
  const before = text.slice(0, m.index);
  const lead = before.slice(before.search(/[^.!?\n]*$/));
  if (NEGATED.test(lead) || HEDGED.test(lead)) return true;
  const sentence = sentenceOf(text, m);
  if (doctorOk && /\bdoctor\b/i.test(sentence)) return true;
  if (succeeded) {
    // Today's false confessions: "I just sent it to the doctor" after a real doctor call, flagged as
    // send_file; "I thought I sent" after a real doctor status check. Never again.
    if (namedDoneTool(sentence, succeeded)) return true;
    const relayed = RELAY_TOOLS.some((t) => succeeded.get(t));
    if (relayed && RELAY_VERB.test(sentence) && !TO_OWNER.test(sentence)) return true;
  }
  // A bare past-tense claim ("sent you", "posted it in") needs her as the subject.
  return /^(sent|posted|dropped|zipped|pushed|committed|switched|stopped|paused|started|saved|added|changed)\b/i.test(m[0]) && !SELF.test(before);
}

// The first action she claimed in `reply` whose tool didn't succeed this turn (succeeded: Map of
// tool -> true), or null. doctorOk: a successful doctor visit is on record in this conversation.
export function phantomClaim(reply, succeeded, { doctorOk = false, freeTalk } = {}) {
  if (claimOverrides === null) {
    try {
      claimOverrides = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(DATA_DIR, 'phantom-claims.json'), 'utf8'))).map(([k, v]) => [k, new RegExp(v, 'i')]));
    } catch {
      claimOverrides = {};
    }
  }
  const text = String(reply);
  // A doctor call that succeeded this very turn counts the same as one on record.
  const doctorDone = doctorOk || Boolean(succeeded.get('doctor'));
  for (const [tool, re] of Object.entries({ ...CLAIMS, ...claimOverrides })) {
    if ((tool !== 'free_talk' || typeof freeTalk !== 'boolean') && (succeeded.get(tool) || ALSO[tool]?.some((t) => succeeded.get(t)))) continue;
    const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(all)) {
      const claim = m[0].trim();
      if (tool === 'free_talk' && typeof freeTalk === 'boolean') {
        const reportedState = claim.match(/\b(on|off)\b/i)?.[1].toLowerCase();
        if (reportedState) {
          if (notHers(text, m, false)) continue;
          const state = /\bis(?:n['’]t| not)\b/i.test(claim) ? (reportedState === 'on' ? 'off' : 'on') : reportedState;
          const currentState = freeTalk ? 'on' : 'off';
          if (state !== currentState) return { tool, claim, currentState };
          // A true statement about the setting ("free talk is on", "is now on") is never a phantom, however
          // it's worded: tonight she retracted a true one because no free_talk call ran that turn. Only a
          // claim that SHE flipped it ("I turned it on") needs a free_talk call this turn.
          if (/\bturned\b/i.test(claim) && !succeeded.get(`free_talk:${state}`) && !succeeded.get('free_talk')) return { tool, claim };
          continue;
        }
      }
      if (!notHers(text, m, doctorDone, succeeded)) return { tool, claim };
    }
  }
  return null;
}

// Plain words for what a tool does, for telling her (and him) what didn't happen.
const DOING = {
  send_file: 'sending the file', send_project: 'sending the project', post_message: 'posting the message',
  files: 'the file change', obligations: 'adding it to your list', checkin_consent: 'saving it to the card',
  music: 'the music change', generate_image: 'making the image', generate_self_image: 'making the picture of you',
  generate_music: 'making the song', look: 'the look change', 'look:replace': 'replacing the look',
  switch_brain: 'the switch', git: 'the git push', browser: 'opening it in the browser', restart: 'the restart',
  leave_voice: 'leaving the call', free_talk: 'the free talk change', bring_peer: 'bringing them in',
  bot_control: 'sending them out', doctor: 'the doctor call', rebuild_memories: 'the memory rebuild',
};
export const doing = (tool) => DOING[tool] ?? `the ${tool.split(':')[0].replace(/_/g, ' ')} call`;

// Why a tool didn't do it this turn, from what's on record: its failed call this turn (calls: [{name,
// result}] where an error result starts "[tool: error code] message"), else its latest hard failure in
// data/tool-failures.jsonl within the last few minutes. Null when it simply was never called.
export function phantomReason(tool, calls = [], { now = Date.now(), withinMs = 5 * 60_000 } = {}) {
  const base = tool.split(':')[0];
  const failed = [...calls].reverse().find((c) => c.name === base && /^\[[^\]]+: error\b/.test(String(c.result)));
  if (failed) {
    const m = String(failed.result).match(/^\[[^\]]+: error ([\w-]+)\]\s*([^\n]*)/);
    return { code: m?.[1] ?? 'failed', message: (m?.[2] ?? '').trim() || 'it returned an error', source: 'this turn' };
  }
  try {
    const lines = readFileSync(path.join(DATA_DIR, 'tool-failures.jsonl'), 'utf8').trim().split('\n').slice(-200);
    for (const line of lines.reverse()) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.kind !== 'hard_fail' || e.tool !== base) continue;
      if (now - Date.parse(e.ts) > withinMs) continue;
      return { code: e.error_code ?? 'failed', message: String(e.note ?? '').trim() || 'it returned an error', source: 'the failure log' };
    }
  } catch {}
  return null;
}

// What to say when a claim really was unbacked: what didn't happen, and why when a failure is on record.
export function phantomText({ tool, claim }, reason) {
  const what = doing(tool);
  return reason
    ? `I said "${claim}", but ${what} failed (${reason.code}${reason.message ? `: ${reason.message.replace(/\.?$/, '')}` : ''}), so it didn't happen.`
    : `I said "${claim}", but I never actually made the ${tool.split(':')[0]} call, so ${what} didn't happen. Ask me again and I'll do it for real.`;
}

// True when `reply` retracts something a tool DID do this turn ("I didn't actually send anything to the
// doctor" after an ok doctor call). A correction must never confess to a success.
export function retractsDone(reply, succeeded) {
  const text = String(reply);
  const relayed = RELAY_TOOLS.some((t) => succeeded.get(t));
  for (const sentence of text.split(/(?<=[.!?\n])\s*/)) {
    if (!/\b(not|never|didn['’]?t|did not|haven['’]?t|hasn['’]?t|wasn['’]?t|couldn['’]?t|failed)\b/i.test(sentence)) continue;
    if (namedDoneTool(sentence, succeeded)) return true;
    if (relayed && RELAY_VERB.test(sentence) && /\b(doctor|doc|him|her|them)\b/i.test(sentence) && !TO_OWNER.test(sentence)) return true;
  }
  return false;
}

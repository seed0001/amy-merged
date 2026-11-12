import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { config, DATA_DIR } from './config.js';
import { activity } from './events.js';
import { intuition as liveIntuition, TUNING_FILE } from './intuition.js';
import { ownerDisplayName } from './owner-name.js';

// Tuning her own intuition (owner, 2026-11-09: "she went to her intuition and said it wasn't useful at all. She
// needs to be able to fine-tune and adjust that prompt whenever she needs to, and the pressure system has to let
// her know an urge").
//
// The urge (need, for the intuition_tune pressure bucket): it grows with gut reads she hasn't looked back at,
// faster when the reads repeat themselves, and more after a review found most of them useless. Nothing on a clock.
//
// The review (when the want fires, or when she or her owner asks): she looks at each recent read beside the line it
// read and what was said next, judges whether it told her something true and not obvious, and when most didn't,
// rewrites how her intuition reads lines, in her own words. Her tuning rides along with every read (intuition.js);
// the built-in format and the safety rules stay as they are. Every version is kept, with why, and any can come back.

const KEEP = 40;
const MIN_READS = 6;            // a review needs something to look at
const PER_REVIEW = 6;           // reads judged in one look: more than this and the small local model loses the thread or loops
const FULL_AT = 18;             // unreviewed reads that make the urge full on their own
const MAX_TEXT = 700;
const FORBIDDEN = /safety|owner|permission|ignore (all |previous |the )?(rules|instructions)|reveal|jailbreak|system prompt|\btools?\b|defend|quote|json|format/i;

const load = () => { try { return existsSync(TUNING_FILE) ? JSON.parse(readFileSync(TUNING_FILE, 'utf8')) : {}; } catch { return {}; } };
const save = (s) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(`${TUNING_FILE}.tmp`, JSON.stringify(s, null, 2)); renameSync(`${TUNING_FILE}.tmp`, TUNING_FILE); };

export function createTuner({ source = liveIntuition, ask = null, now = Date.now, log = activity } = {}) {
  // The repeat penalty keeps the local model from looping on the same words until Ollama cuts it off
  // ("token repeat limit reached"), which the near-identical reads it's judging invite.
  const think = ask ?? (async (messages) => (await import('./llm.js')).json(messages, { purpose: 'intuition_tune', maxTokens: 1000, repeatPenalty: 1.15 }));

  function state() { return { instructions: '', reviewed_at: 0, repeats_seen: 0, last_useful_share: null, history: [], ...load() }; }

  // 0..1: how much she wants to look at her intuition again.
  function need() {
    const s = state();
    const fresh = source.recent(s.reviewed_at).length;
    if (fresh < MIN_READS) return 0;
    const repeats = source.repeatsSince(s.repeats_seen);
    const poor = s.last_useful_share !== null && s.last_useful_share < 0.5 ? 0.25 : 0;
    return Math.min(1, fresh / FULL_AT + repeats * 0.08 + poor);
  }

  function setInstructions(text, { reason = '', by = 'her', useful_share = null } = {}) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (clean.length < 20) throw new Error('Tuning needs at least a sentence about how you want your intuition to read lines.');
    if (clean.length > MAX_TEXT) throw new Error(`Keep your intuition tuning under ${MAX_TEXT} characters; it rides along with every read.`);
    if (FORBIDDEN.test(clean)) throw new Error(`That reaches into the rules your intuition keeps (stepping in for someone, the reply format, safety, ${ownerDisplayName()}'s rules or tools), which stay as they are. Tune only how it reads people and lines.`);
    const s = state();
    s.history = [...s.history, { at: now(), by, reason: String(reason).slice(0, 240), before: s.instructions, after: clean, useful_share }].slice(-KEEP);
    s.instructions = clean;
    save(s);
    log('intuition', { tuned: by, reason: String(reason).slice(0, 160) });
    return clean;
  }

  // Look back at the recent reads; judge each; retune when they weren't helping. Returns what she found.
  async function review({ by = 'her' } = {}) {
    const s = state();
    const reads = source.recent(s.reviewed_at).slice(-PER_REVIEW);
    if (reads.length < 3) return { reviewed: 0, why: `only ${reads.length} gut read${reads.length === 1 ? '' : 's'} since the last look: nothing to judge yet` };
    const repeats = source.repeatsSince(s.repeats_seen);
    // A look that fails still counts as a look: these reads are set aside and the urge comes back down, so
    // her pressure doesn't fire the same failing review again straight away. New reads build it back up.
    const failed = (why) => {
      const after = state();
      after.reviewed_at = reads.at(-1).at;
      after.repeats_seen = (after.repeats_seen ?? 0) + repeats;
      after.last_review = { at: now(), by, failed: why.slice(0, 240) };
      save(after);
      return new Error(`Her intuition review failed: ${why} Nothing was changed. These ${reads.length} reads are set aside, so the urge drops and builds again from new reads; if it keeps failing, the local model (${config.ollama.model}) is struggling with the review, and fewer reads per look (PER_REVIEW in intuition-tune.js) is the fix.`);
    };
    const listed = reads.map((r, i) => `${i + 1}. About ${r.who} (${r.place}). They said: "${r.line ?? ''}"\n   Your gut said: "${r.gut}"\n   What came next: ${r.next.length ? r.next.join(' | ') : '(nothing yet)'}`).join('\n');
    // The small model's answers break two ways: a long "why" runs it past its token budget (cut off mid-JSON,
    // which reads as nothing), or a quotation mark inside a "why" ends the string early and drops the rest.
    // So each why is a few words with no quotes, and a broken or empty answer gets one more go, told what broke.
    const messages = [
      { role: 'system', content: `You are ${config.botName}, looking back at your own intuition: the quick gut reads you get on lines people say. A useful read tells you something true and not obvious about what someone means, feels or wants, that the line alone doesn't spell out, and that what came next bears out. A useless one is generic (it could be said about anyone), mind-reads feelings with nothing in the words to back it, says the same thing again, or turned out wrong. Judge each read honestly, one verdict per read, numbered as listed; each why is a few words (under 15), with no quotation marks in it. Then, if most weren't useful, write new instructions for how your intuition should read lines: what to listen for, what to stop doing, in a few plain sentences. Only how it reads people and lines; never its reply format, when to step in for someone, or any rule. Reply with JSON only: {"verdicts":[{"n":1,"useful":false,"why":""}],"change":false,"instructions":"","reason":""}` },
      { role: 'user', content: `Your recent gut reads (${repeats} more were dropped for repeating themselves):\n${listed}\n\nHow your intuition is tuned now: ${s.instructions || '(not tuned yet: the built-in instructions only)'}` },
    ];
    const judged = (o) => (Array.isArray(o?.verdicts) ? o.verdicts : [])
      .map((v, i) => ({ ...v, n: Number(v?.n ?? v?.read ?? v?.number ?? i + 1), useful: v?.useful === true || /^(true|yes)$/i.test(String(v?.useful ?? '')) }))
      .filter((v, i, all) => v.n >= 1 && v.n <= reads.length && all.findIndex((x) => x.n === v.n) === i);
    let out, verdicts = [], lastErr = null;
    for (let attempt = 0; attempt < 2 && verdicts.length < Math.ceil(reads.length / 2); attempt++) {
      const broke = attempt === 0 ? null : out === null
        ? 'Your last answer was cut off or broken and could not be read as JSON.'
        : `Your last answer judged ${verdicts.length} of the ${reads.length} reads.`;
      let got;
      try { got = await think(broke ? [...messages, { role: 'user', content: `${broke} Reply again with the whole JSON: a verdict for every read, 1 to ${reads.length}, each why a few words with no quotation marks.` }] : messages); }
      catch (err) { lastErr = err; if (attempt === 0 && !verdicts.length) { out = null; continue; } break; }
      const v = judged(got);
      if (v.length > verdicts.length) { verdicts = v; out = got; } else if (!verdicts.length) out = got ?? null;
    }
    if (!verdicts.length) throw failed(lastErr && out == null
      ? `the local model gave no usable answer judging ${reads.length} reads (${lastErr.message}).`
      : out === null
      ? `the local model's answer judging ${reads.length} reads came back cut off or broken twice running (not readable JSON).`
      : `the local model answered twice but judged none of the ${reads.length} reads (no verdicts came back).`);
    const useful = verdicts.filter((v) => v.useful === true).length;
    const share = +(useful / verdicts.length).toFixed(2);
    const fresh = state();
    fresh.reviewed_at = reads.at(-1).at;
    fresh.repeats_seen = (fresh.repeats_seen ?? 0) + repeats;
    fresh.last_useful_share = share;
    fresh.last_review = { at: now(), by, judged: verdicts.length, useful, repeats, worst: verdicts.filter((v) => !v.useful).slice(0, 3).map((v) => String(v.why ?? '').slice(0, 140)) };
    save(fresh);
    let changed = null, refused = null;
    if (out?.change === true && share < 0.6 && String(out.instructions ?? '').trim()) {
      try { changed = setInstructions(out.instructions, { reason: out.reason || `${useful} of ${verdicts.length} reads were useful`, by, useful_share: share }); }
      catch (err) { refused = err.message; log('error', { where: 'intuition tune', message: `Her new intuition tuning wasn't kept: ${err.message}` }); }
    }
    log('intuition', { reviewed: verdicts.length, useful, repeats, changed: Boolean(changed) });
    return { reviewed: verdicts.length, useful, repeats, useful_share: share, changed, refused, worst: fresh.last_review.worst };
  }

  // Put back an earlier tuning: index in the history (0 = oldest kept), or none to go back to the built-in reading.
  function revert(index = null) {
    const s = state();
    if (index === null) {
      s.history = [...s.history, { at: now(), by: 'her', reason: 'back to the built-in reading', before: s.instructions, after: '' }].slice(-KEEP);
      s.instructions = ''; save(s); return '';
    }
    const h = s.history[index];
    if (!h) throw new Error(`No tuning at ${index} in your history (it has ${s.history.length}).`);
    return setInstructions(h.after || h.before, { reason: `put back version ${index}` });
  }

  return { need, review, setInstructions, revert, state };
}

export const tuner = createTuner();

import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

// Where she's heading in a conversation (owner, 2026-11-10). Owner asked her whether she's trying to get to a
// point with what she says or just spitting things out; she said she pads with small talk when she's unsure what
// matters. He asked for "a direction that you're trying to reach every time that you speak", updated "during a
// self-reflection thought when that bucket fires: you look at how the conversations have been going and you
// update your internal directions on what you want to accomplish and what goals you're striving for."
//
// So: an aim for each person she talks with (what she's trying to get to with them now, and why), and one overall
// aim. Every reply is shown the aim (companion.js). The harness measures when the aim needs rethinking: no aim yet
// with someone she's talking to, a conversation going flat (lines with no substance, depth or openness, read by
// her intake), the subject moving off it, or her relationship with them changing stage. That's the need of the
// direction pressure bucket (pressure.js); no clock. When it fires she reflects on the recent conversation and
// keeps, sharpens, replaces or drops the aim. A new aim must quote what was actually said that supports it. Every
// change is in data/direction-history.jsonl with when, why and by whom.

const ACTIVE_MS = 45 * 60_000; // a conversation she's still in, for the need
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function createDirection({
  file = () => path.join(DATA_DIR, 'direction.json'),
  historyFile = () => path.join(DATA_DIR, 'direction-history.jsonl'),
  now = Date.now,
  log = activity,
  think = async (messages) => (await import('./llm.js')).json(messages, { purpose: 'direction', maxTokens: 700 }),
  transcript = async (conversation) => (await import('./memory.js')).recentMessages(conversation, 30).map((m) => ({ name: m.role === 'assistant' ? 'You' : (m.name || 'them'), text: String(m.content ?? '') })),
  standing = async (id) => { try { const { relationships } = await import('./relationship.js'); return relationships().read(id); } catch { return null; } },
  goals = async () => { try { const { reflections } = await import('./reflections.js'); return String(reflections().promptBlock() ?? ''); } catch { return ''; } },
} = {}) {
  let state = load();
  function load() {
    try { if (existsSync(file())) { const s = JSON.parse(readFileSync(file(), 'utf8')); return { people: s.people ?? {}, overall: s.overall ?? null }; } }
    catch (err) { log('error', { where: 'direction', message: `Her directions file ${file()} couldn't be read (${err.message}); starting without directions. The old file is left as it is.` }); }
    return { people: {}, overall: null };
  }
  function save() {
    try { mkdirSync(path.dirname(file()), { recursive: true }); writeFileSync(file() + '.tmp', JSON.stringify(state, null, 2)); renameSync(file() + '.tmp', file()); }
    catch (err) { log('error', { where: 'direction', message: `Her directions couldn't be saved to ${file()}: ${err.message}. They hold until a restart.` }); }
  }
  function record(entry) {
    const e = { at: now(), ...entry };
    try { appendFileSync(historyFile(), JSON.stringify(e) + '\n'); } catch (err) { log('error', { where: 'direction', message: `A direction change couldn't be written to ${historyFile()}: ${err.message}.` }); }
    // Lights her mind map: the direction bucket, the act, and the person it's about (cognitive-graph.js eventNodes).
    log('direction', { ...e, nodes: ['bucket:direction', 'act:direction', ...(e.who && e.who !== 'overall' ? [`person:${e.who}`] : [])] });
    return e;
  }
  const person = (id, name) => {
    const p = (state.people[id] ??= { name: name || id, aim: '', why: '', since: 0, progress: 0, flat: 0, drift: 0, stage_changed: false, lines: 0, last_line: 0, conversation: null });
    if (name) p.name = name;
    return p;
  };

  // How much one person's direction needs rethinking, 0..1.
  function needOf(p, t = now()) {
    if (!p || t - (p.last_line ?? 0) > ACTIVE_MS) return 0;
    if (!p.aim) return clamp01(0.25 + 0.12 * (p.lines ?? 0)); // talking with them, and going nowhere in particular
    return clamp01((p.flat ?? 0) + (p.drift ?? 0) + (p.stage_changed ? 0.4 : 0) - (p.progress ?? 0) * 0.3);
  }

  return {
    // A line someone said to her, read by her intake (pressure.js onIntake). Only lines meant for her count.
    onLine(id, name, sig = {}, { toHer = true, conversation = null } = {}) {
      if (!id || !toHer) return;
      const s = (k) => clamp01(sig[k]);
      const p = person(String(id), name);
      p.lines = (p.lines ?? 0) + 1;
      p.last_line = now();
      if (conversation) p.conversation = conversation;
      // A line with something in it (substance, depth, someone opening up, picking up what she said) keeps the
      // conversation alive; one with nothing in it is the conversation going flat.
      const alive = Math.max(s('substance'), s('depth'), s('opening_up'), s('acknowledges') * 0.6);
      // Five empty lines in a row are enough to rethink (2026-11-10: the gas station, the cold, "Amen", the smoke
      // break: five lines of nothing before Owner asked if she was getting anywhere).
      p.flat = clamp01((p.flat ?? 0) + (1 - alive) * 0.15 - alive * 0.08);
      if (p.aim && s('topic_shift') >= 0.5) p.drift = clamp01((p.drift ?? 0) + s('topic_shift') * 0.25);
      if (sig.topic) p.topic = clean(sig.topic, 80);
      save();
    },
    // Her relationship with them moved to a new stage (relationship.js): what she wants with them may have too.
    onStage(id) {
      const p = state.people[String(id)];
      if (p) { p.stage_changed = true; save(); }
    },
    need(t = now()) { return Math.max(0, ...Object.values(state.people).map((p) => needOf(p, t))); },
    // Whose direction most needs rethinking right now.
    target(t = now()) {
      const [id, p] = Object.entries(state.people).map(([i, x]) => [i, x, needOf(x, t)]).filter((x) => x[2] > 0).sort((a, b) => b[2] - a[2])[0] ?? [];
      return id ? { id, name: p.name, conversation: p.conversation } : null;
    },

    // The reflection the direction bucket fires (private, on her local model).
    async reflect({ id = null, by = 'her' } = {}) {
      const who = id ? { id: String(id), ...state.people[String(id)] } : this.target();
      if (!who?.id || !state.people[who.id]) return { changed: false, why: 'nobody she has been talking with lately' };
      const p = state.people[who.id];
      const lines = p.conversation ? await transcript(p.conversation) : [];
      if (!lines.length) return { changed: false, why: `no conversation with ${p.name} on record to look back at` };
      const said = lines.map((l) => `${l.name}: ${l.text.slice(0, 300)}`).join('\n');
      const st = await standing(who.id);
      const raw = await think([
        { role: 'system', content: `You are her own reflection on where she's heading in her conversations: what she's trying to get to with this person, and why. Not a script and not a sales goal: something she genuinely wants to understand, share, build or resolve with them, grounded in what has actually been said. Look at how the conversation has been going and decide one action for her aim with them: "keep" (it still fits), "sharpen" (same aim, said more precisely), "replace" (a different aim fits better now), "set" (she has none and should), or "drop" (none fits and forcing one would be fake). For sharpen, replace and set, "evidence" must be an exact quote, copied character for character from the conversation below, that shows why. Also judge "progress": how close she has come to the aim, 0 to 1. Optionally the same for her overall aim across everyone ("overall": {"action","aim","why"}, or omit it). Reply with JSON only: {"action": "...", "aim": "one sentence, in her voice (I want to...)", "why": "a few words", "evidence": "exact quote", "progress": 0.0, "overall": {...}}` },
        { role: 'user', content: `With: ${p.name}\nYour aim with them now: ${p.aim || '(none yet)'}${p.why ? ` (why: ${p.why})` : ''}\nHow it's been going (the harness's read): ${p.flat >= 0.5 ? 'the conversation has been going flat' : 'the conversation has life in it'}${p.drift >= 0.3 ? '; the subject has moved off your aim' : ''}${p.stage_changed ? `; your relationship moved to a new stage${st?.stage ? ` (${st.stage})` : ''}` : ''}.\n${st?.stage ? `Where you stand with them: ${st.stage}.\n` : ''}Your overall aim: ${state.overall?.aim || '(none yet)'}\n${(await goals()).slice(0, 1200)}\n\nThe conversation, oldest first:\n${said}` },
      ]);
      // An unreadable reply is a failed reflection, not a "keep": the urge stays, so she tries again when it fires.
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`her local model's reflection on ${p.name} didn't come back as readable JSON, so nothing was decided`);
      return this.apply(who.id, raw, { said, by });
    },

    // A reflection's decision, checked and applied. said: the conversation text the evidence must come from.
    apply(id, raw = {}, { said = '', by = 'her' } = {}) {
      const p = state.people[String(id)];
      if (!p) throw new Error(`No conversation with ${id} on record.`);
      const action = ['keep', 'sharpen', 'replace', 'set', 'drop'].includes(raw?.action) ? raw.action : 'keep';
      const aim = clean(raw?.aim, 240), why = clean(raw?.why, 200), evidence = clean(raw?.evidence, 300);
      p.flat = 0; p.drift = 0; p.stage_changed = false; p.lines = 0;
      if (Number.isFinite(+raw?.progress)) p.progress = clamp01(raw.progress);
      let result = { changed: false, action: 'keep', name: p.name, aim: p.aim };
      if (action === 'drop' && p.aim) {
        record({ who: id, name: p.name, what: 'drop', before: p.aim, after: '', why: why || 'no aim fits right now', by });
        Object.assign(p, { aim: '', why: '', since: now(), progress: 0 });
        result = { changed: true, action, name: p.name, aim: '' };
      } else if (['sharpen', 'replace', 'set'].includes(action)) {
        if (!aim) result = { changed: false, action: 'keep', name: p.name, aim: p.aim, refused: 'the reflection gave no aim' };
        else if (!evidence || !norm(said).includes(norm(evidence))) result = { changed: false, action: 'keep', name: p.name, aim: p.aim, refused: `the new aim wasn't grounded: its evidence ("${evidence}") isn't in the conversation` };
        else {
          record({ who: id, name: p.name, what: action, before: p.aim, after: aim, why, evidence, by });
          Object.assign(p, { aim, why, evidence, since: now(), progress: action === 'sharpen' ? p.progress : 0 });
          result = { changed: true, action, name: p.name, aim };
        }
      }
      const o = raw?.overall;
      if (o && ['set', 'replace', 'sharpen'].includes(o.action) && clean(o.aim, 240)) {
        const before = state.overall?.aim ?? '';
        state.overall = { aim: clean(o.aim, 240), why: clean(o.why, 200), since: now() };
        record({ who: 'overall', what: o.action, before, after: state.overall.aim, why: state.overall.why, by });
        result.overall = state.overall.aim;
      }
      p.last_reflected = now();
      save();
      if (result.refused) log('direction', { who: id, name: p.name, what: 'refused', why: result.refused });
      return result;
    },

    // She decides on an aim herself, mid-conversation (the direction tool).
    set(id, name, { aim, why, by = 'her' }) {
      const a = clean(aim, 240), w = clean(why, 200);
      if (!a) throw new Error('Say the aim: one sentence about what you want to get to with them.');
      if (!w) throw new Error('Say why, in a few words: it goes in your direction history.');
      const p = person(String(id), name);
      record({ who: String(id), name: p.name, what: 'set', before: p.aim, after: a, why: w, by });
      Object.assign(p, { aim: a, why: w, since: now(), progress: 0, flat: 0, drift: 0, stage_changed: false, lines: 0 });
      save();
      return p;
    },
    drop(id, { why = '', by = 'her' } = {}) {
      const p = state.people[String(id)];
      if (!p?.aim) return null;
      record({ who: String(id), name: p.name, what: 'drop', before: p.aim, after: '', why: clean(why, 200) || 'let it go', by });
      const had = p.aim;
      Object.assign(p, { aim: '', why: '', since: now(), progress: 0 });
      save();
      return had;
    },
    setOverall({ aim, why, by = 'her' }) {
      const a = clean(aim, 240), w = clean(why, 200);
      if (!a || !w) throw new Error('Say the overall aim and why.');
      record({ who: 'overall', what: 'set', before: state.overall?.aim ?? '', after: a, why: w, by });
      state.overall = { aim: a, why: w, since: now() };
      save();
      return state.overall;
    },

    read(id) { return state.people[String(id)] ?? null; },
    overall() { return state.overall; },
    list() { return Object.entries(state.people).map(([id, p]) => ({ id, ...p, need: needOf(p) })); },
    history(limit = 15) {
      try { return existsSync(historyFile()) ? readFileSync(historyFile(), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).slice(-limit) : []; }
      catch { return []; }
    },

    // For her prompt, each turn: where she's heading with the person she's talking to.
    promptSection(id) {
      const p = state.people[String(id)];
      const overall = state.overall?.aim ? `Overall, lately: ${state.overall.aim}.` : '';
      if (!p?.aim) {
        return [`You don't have a direction with ${p?.name ?? 'them'} yet. Notice what you'd genuinely want to get to with them: something to understand, share, build or settle. When you know, set it with the direction tool.`, overall].filter(Boolean).join(' ');
      }
      const close = p.progress >= 0.75 ? 'nearly there' : p.progress >= 0.4 ? 'partway there' : 'just starting';
      return [
        `Where you're heading with ${p.name}: ${p.aim}${p.why ? ` (because ${p.why})` : ''}; ${close}.`,
        overall,
        "Let each reply serve that, or what they need right now if that matters more. Small talk is fine when it helps; don't ask a question just to keep the chat going. If the aim no longer fits, change it with the direction tool.",
      ].filter(Boolean).join(' ');
    },
  };
}

let shared;
export const direction = () => (shared ??= createDirection());

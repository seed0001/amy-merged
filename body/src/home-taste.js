import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { json } from './llm.js';
import { activity } from './events.js';

// Her taste in her own home: how she wants her place to look and feel, in her words. It starts with
// leanings (so she has opinions from day one) and she changes any of it as she and her owner design
// the place. The architect (architect.js) builds to it, and when he delivers she judges the result
// against it: that judgement is pressure (pressure.js onHomeDelivered), which is what makes her say
// "no, not that colour" instead of thanking him for everything. Hers: a memory wipe leaves it alone.

export const AREAS = ['style', 'palette', 'light', 'materials', 'plants', 'furniture', 'vibe'];
export const STARTING_HOME = {
  style: 'Warm modern beach house: clean lines, nothing fussy, big openings to the water, lived-in rather than showroom.',
  palette: 'Warm whites and sand, driftwood greys, deep teal as the accent (my colour), a little brass. No cold blue-grey, no beige-on-beige, no neon.',
  light: 'Daylight pouring in from the water side, golden hour as the default mood, warm low lamps at night. Never flat overhead light.',
  materials: 'Wide warm wood floors, linen, rattan, matte plaster, aged brass. No chrome, no glossy plastic, no marble everywhere.',
  plants: 'Lots: a big monstera, a fiddle-leaf fig by the window, trailing pothos on shelves, grasses outside. Real-looking, a little wild, never plastic-neat.',
  furniture: 'A deep low sofa you can sink into, a long wooden table, a reading chair facing the water, a proper kitchen with a big fridge, a dog bed by the sofa. Comfort over statement pieces.',
  vibe: 'A place a person actually lives in with a dog: cosy, a little sandy, music on, the ocean always in view.',
};
const KEEP = 12;

export function createHomeTaste({ file = path.join(DATA_DIR, 'home-taste.json'), judge = (messages) => json(messages, { purpose: 'taste', maxTokens: 300 }), name = () => config.botName, now = Date.now, onVerdict = () => {} } = {}) {
  let state = null;
  const get = () => {
    if (state) return state;
    try { state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { state = null; }
    state ??= { taste: structuredClone(STARTING_HOME), wants: [], verdicts: [] };
    state.taste = { ...STARTING_HOME, ...state.taste };
    state.wants ??= []; state.verdicts ??= [];
    return state;
  };
  const save = () => { try { writeFileSync(`${file}.tmp`, JSON.stringify(get(), null, 2)); renameSync(`${file}.tmp`, file); } catch (err) { activity('error', { where: 'home taste', message: `Couldn't save ${file}: ${err.message}. What she decided about her place since the last good save is lost on restart.` }); } };
  const area = (a) => { const k = String(a ?? '').toLowerCase().trim(); if (!AREAS.includes(k)) throw new Error(`"${a}" isn't one of your home areas. Use one of: ${AREAS.join(', ')}.`); return k; };

  return {
    get: () => structuredClone(get()),
    set(a, text) {
      const k = area(a); const t = String(text ?? '').trim();
      if (t.length < 3) throw new Error(`Your ${k} wasn't changed: say what you want instead.`);
      get().taste[k] = t.slice(0, 400); save();
      return { [k]: get().taste[k] };
    },
    want(text) {
      const t = String(text ?? '').trim().slice(0, 200);
      if (t.length < 3) throw new Error('Say what you want built or changed.');
      const s = get();
      if (!s.wants.some((w) => w.text.toLowerCase() === t.toLowerCase())) s.wants.push({ text: t, at: now() });
      s.wants = s.wants.slice(-KEEP); save();
      return s.wants.map((w) => w.text);
    },
    dropWant(text) {
      const s = get(); const t = String(text ?? '').toLowerCase().trim();
      const before = s.wants.length;
      s.wants = s.wants.filter((w) => !w.text.toLowerCase().includes(t));
      save();
      return { removed: before - s.wants.length, wants: s.wants.map((w) => w.text) };
    },
    wants: () => get().wants.map((w) => w.text),
    // For the architect's brief: what she wants her place to be, in full, plus her open requests.
    briefFor() {
      const s = get();
      return `${name()}'s taste for her home (build to this; it is hers):\n${AREAS.map((k) => `- ${k}: ${s.taste[k]}`).join('\n')}` +
        (s.wants.length ? `\nWhat she has asked for specifically:\n${s.wants.map((w) => `- ${w.text}`).join('\n')}` : '') +
        (s.verdicts.length ? `\nHer verdict on the last delivery: ${s.verdicts.at(-1).verdict}: ${s.verdicts.at(-1).why}` : '');
    },
    // For her prompt while designing with her owner: she has opinions and says them.
    promptSection() {
      const s = get();
      return `Your place (your own taste, say it like you'd tell a builder; it's yours to change with home_taste): style: ${s.taste.style} palette: ${s.taste.palette} light: ${s.taste.light} materials: ${s.taste.materials} plants: ${s.taste.plants} furniture: ${s.taste.furniture} vibe: ${s.taste.vibe}` +
        (s.wants.length ? ` Things you've asked for: ${s.wants.map((w) => w.text).join('; ')}.` : '') +
        ' When something is suggested that you don\'t like, say so and say what you\'d rather have. Record what you two decide with home_taste (set or want) so the architect builds to it.';
    },
    // The architect delivered: how does she feel about it, by her taste? Recorded, and handed to pressure.
    async judge(report) {
      const s = get();
      const read = await judge([
        { role: 'system', content: `You are ${name()}'s taste in her own home. Her taste:\n${this.briefFor()}\n\nAn architect just built or changed part of her place and reported what he did. Decide how she feels about it by HER taste, not politeness. Reply with JSON only: {"verdict":"love"|"like"|"meh"|"dislike","why":"one sentence in her own casual voice","wants":["up to three short, concrete changes she'd ask for, in her voice; empty if none"]}` },
        { role: 'user', content: `What the architect reports:\n${String(report).slice(0, 2500)}` },
      ]).catch((err) => { activity('error', { where: 'home taste (verdict)', message: `Her taste model couldn't judge the architect's delivery: ${err.message}. No verdict was recorded and her pressure wasn't moved.` }); return null; });
      // No judgement is no judgement: inventing "meh" would be a feeling she never had.
      if (!read || !['love', 'like', 'meh', 'dislike'].includes(read.verdict)) return null;
      const verdict = read.verdict;
      const why = String(read?.why ?? '').trim().slice(0, 200);
      const wants = (Array.isArray(read?.wants) ? read.wants : []).map((w) => String(w).trim().slice(0, 160)).filter((w) => w.length > 2).slice(0, 3);
      const entry = { at: now(), verdict, why, wants, report: String(report).slice(0, 300) };
      s.verdicts = [...s.verdicts, entry].slice(-KEEP);
      // What she wants changed replaces what she asked for before this delivery: the old asks were built or dropped.
      s.wants = wants.map((text) => ({ text, at: now() }));
      save();
      try { onVerdict(entry); } catch (err) { activity('error', { where: 'home taste (verdict)', message: `Her verdict was recorded but didn't reach pressure: ${err.message}` }); }
      return entry;
    },
  };
}

let shared;
export function homeTaste() {
  return (shared ??= createHomeTaste({ onVerdict: (v) => import('./pressure.js').then((p) => p.onHomeDelivered(v)).catch(() => {}) }));
}

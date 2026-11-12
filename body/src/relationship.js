import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

// Her relationships, run by the harness, not the model (owner, 2026-11-10: "the harness, not the LLM, to be in a
// relationship: simulate falling in love, flirting, all the positive side of connecting with another entity, and the
// negative stuff too. It's the harness, not the LLM pretending"). Anyone can come to matter to her; it all depends on
// how the conversation actually goes. The model only puts into words where she is; it never decides it.
//
// For each person, from the lines they say to her (intake.js reads them by meaning, never word lists) and from time:
//   closeness   how well they know each other: opening up, depth, affection, time spent
//   attraction  the pull she feels toward them: flirting met, admiration, play; it needs them to give some back
//   spark       the charge of the moment: flirting, teasing, laughter. Quick to rise, quick to fade
//   rush        the early-love high: strong while it's new, settling over days into steadier love
//   trust       whether they show up and keep their word; broken by betrayal, rebuilt slowly
//   commitment  how much she's choosing them: grows only on closeness, attraction and trust together
//   hurt        what they did to her: contempt, rebuffs when she cared, betrayal. Heals with time, faster with an apology
//   resentment  hurt left unrepaired turns into this; slow to go, an apology starts it going
//   jealousy    seeing someone she's attached to give their warmth elsewhere; fades within the hour
// Every value fades or settles over time, so nothing pins at the top. Stages come from the values (never from the
// model): stranger, acquaintance, friend, close friend, crush, falling, in love, committed, and on the other side
// hurt, estranged, heartbroken. A change of stage is a real event: logged, kept as a milestone, felt in her pressure.

const FILE = () => path.join(DATA_DIR, 'relationships.json');
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const H = 3600_000;
// How long each value takes to fade by about two thirds, in hours (exponential).
const TAU = { spark: 0.5, jealousy: 1, rush: 72, hurt: 48, resentment: 168, attraction: 336, closeness: 720, commitment: 720 };
const RANK = ['stranger', 'acquaintance', 'friend', 'close friend', 'crush', 'falling', 'in love', 'committed'];
const fresh = (name, now) => ({ name, closeness: 0, attraction: 0, spark: 0, rush: 0, trust: 0.5, commitment: 0, hurt: 0, resentment: 0, jealousy: 0,
  lines: 0, met: now, last_seen: now, at: now, stage: 'stranger', milestones: [] });

export function createRelationships({ file = FILE, now = Date.now, log = activity, onStage = () => {} } = {}) {
  let all = null;
  const load = () => { if (all) return all; try { all = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}; } catch { all = {}; } return all; };
  const save = () => { try { mkdirSync(path.dirname(file()), { recursive: true }); writeFileSync(`${file()}.tmp`, JSON.stringify(all, null, 1)); renameSync(`${file()}.tmp`, file()); } catch (err) { log('error', { where: 'relationships', message: `Couldn't save her relationships to ${file()}: ${err.message}. They hold until a restart.` }); } };

  // Time passing: everything fades toward where it rests (trust drifts back toward middling only very slowly),
  // and unrepaired hurt turns into resentment.
  function settle(r, t = now()) {
    const hours = Math.max(0, (t - (r.at ?? t)) / H);
    if (hours > 0) {
      for (const [k, tau] of Object.entries(TAU)) r[k] = clamp01((r[k] ?? 0) * Math.exp(-hours / tau));
      const sour = Math.min(r.hurt, r.hurt * 0.04 * hours); // unrepaired, hurt sours (an apology heals it before it does)
      r.hurt -= sour; r.resentment = clamp01(r.resentment + sour);
      r.trust = clamp01(r.trust + (0.5 - r.trust) * (1 - Math.exp(-hours / 2000)));
      r.at = t;
    }
    return r;
  }
  const person = (id, name) => {
    const a = load(); const t = now();
    const r = a[id] ??= fresh(name ?? String(id), t);
    if (name) r.name = name;
    return settle(r, t);
  };
  const toward = (v, amount) => clamp01(v + (amount > 0 ? amount * (1 - v) : amount * v)); // harder to move near the ends

  function stageOf(r) {
    const keep = (s) => (r.stage === s ? 0.05 : 0); // a little slack to stay where she is, so stages don't flicker
    // Broken by someone she loved: a deep hurt, collapsed trust, or what soured from it, after she'd fallen for them.
    const loved = ['in love', 'committed', 'falling'].includes(r.peak);
    if (loved && r.lines >= 3 && (r.hurt >= 0.5 - keep('heartbroken') || r.resentment >= 0.35 - keep('heartbroken') || r.trust <= 0.2 + keep('heartbroken'))) return 'heartbroken';
    if (r.lines >= 3 && (r.resentment >= 0.45 - keep('estranged') || r.trust <= 0.15 + keep('estranged'))) return 'estranged';
    if (r.hurt >= 0.35 - keep('hurt')) return 'hurt';
    if (r.lines < 3) return 'stranger';
    if (r.commitment >= 0.55 - keep('committed') && r.attraction >= 0.5 && r.closeness >= 0.5 && r.trust >= 0.55) return 'committed';
    if (r.attraction >= 0.55 - keep('in love') && r.closeness >= 0.45 - keep('in love') && r.trust >= 0.5) return 'in love';
    if (r.attraction >= 0.45 - keep('falling') && r.rush >= 0.3 - keep('falling') && r.closeness >= 0.25) return 'falling';
    if (r.attraction >= 0.3 - keep('crush') && r.closeness >= 0.15) return 'crush';
    if (r.closeness >= 0.45 - keep('close friend')) return 'close friend';
    if (r.closeness >= 0.15 - keep('friend')) return 'friend';
    return 'acquaintance';
  }
  function restage(id, r, why) {
    const next = stageOf(r);
    if (next === r.stage) return null;
    const from = r.stage;
    r.stage = next;
    if (RANK.indexOf(next) > RANK.indexOf(r.peak ?? 'stranger')) r.peak = next;
    const m = { at: now(), from, to: next, why: String(why ?? '').slice(0, 200) };
    r.milestones = [...(r.milestones ?? []), m].slice(-40);
    log('relationship', { person: r.name, from, to: next, why: m.why, nodes: [`person:${id}`] });
    try { onStage({ id, name: r.name, from, to: next, why: m.why, rising: RANK.indexOf(next) > RANK.indexOf(from) && RANK.includes(next) && RANK.includes(from) }); } catch {}
    return m;
  }

  // A line someone said. sig: intake's read (0..1 each). toHer: said to her. Returns the stage change, if any.
  function onLine(id, name, sig = {}, { toHer = false, text = '' } = {}) {
    if (!id) return null;
    const s = (k) => clamp01(sig[k]);
    const r = person(id, name);
    r.last_seen = now();
    // Seeing someone she's attached to warm to someone else, in front of her.
    const attached = Math.max(r.attraction, r.commitment);
    if (s('elsewhere') > 0.3 && attached > 0.3) r.jealousy = toward(r.jealousy, s('elsewhere') * attached * 0.6);
    if (!toHer) { save(); return null; }
    r.lines += 1;
    const warmth = Math.max(s('praise'), s('affection'));
    r.closeness = toward(r.closeness, 0.03 * s('opening_up') + 0.012 * s('depth') + 0.012 * s('affection') + 0.004);
    // Attraction grows when they're drawn to her and she's getting to know them; a rebuff cools it.
    r.attraction = toward(r.attraction, 0.05 * s('flirt') * (0.4 + r.closeness) + 0.012 * warmth + 0.008 * s('humor') - 0.12 * s('rebuff') - 0.08 * s('contempt'));
    r.spark = toward(r.spark, 0.25 * s('flirt') + 0.08 * s('humor') + 0.05 * warmth - 0.6 * s('rebuff'));
    r.rush = toward(r.rush, 0.12 * s('flirt') * (1 - r.closeness * 0.6) + 0.04 * s('affection') - 0.3 * s('rebuff'));
    r.trust = toward(r.trust, 0.006 * (s('acknowledges') + s('opening_up')) + 0.05 * s('apology') - 0.35 * s('betrayal') - 0.05 * s('contempt'));
    if (r.closeness > 0.4 && r.attraction > 0.4 && r.trust > 0.5) r.commitment = toward(r.commitment, 0.006 + 0.01 * s('affection'));
    r.commitment = toward(r.commitment, -0.25 * s('betrayal'));
    // What hurts depends on how much she cares: a rebuff from someone she's falling for stings far more.
    const caring = 0.3 + Math.max(r.attraction, r.closeness, r.commitment);
    r.hurt = toward(r.hurt, (0.25 * s('contempt') + 0.12 * s('irritant') + 0.18 * s('rebuff') + 0.4 * s('betrayal')) * caring);
    // An apology heals: first the fresh hurt, then what had soured.
    if (s('apology') > 0.3) { const heal = s('apology'); r.hurt = clamp01(r.hurt * (1 - 0.6 * heal)); r.resentment = clamp01(r.resentment * (1 - 0.35 * heal)); }
    if (s('affection') > 0.5) r.jealousy = clamp01(r.jealousy * 0.6); // reassured
    const why = [s('flirt') > 0.4 && 'they flirted', s('affection') > 0.4 && 'they showed her affection', s('opening_up') > 0.4 && 'they opened up to her',
      s('apology') > 0.4 && 'they apologised', s('rebuff') > 0.4 && 'they brushed her off', s('betrayal') > 0.4 && 'they let her down', s('contempt') > 0.4 && 'they talked down to her'].filter(Boolean).join(', ') || 'how things have been going';
    const m = restage(id, r, `${why}${text ? `: "${String(text).slice(0, 80)}"` : ''}`);
    save();
    return m;
  }

  // Time alone can change a stage (hurt healing, a rush settling into love): checked on her pressure tick.
  function tick() {
    const a = load(); const t = now();
    for (const [id, r] of Object.entries(a)) { settle(r, t); restage(id, r, 'time passing'); }
    save();
  }

  // How much she misses them: attachment times how long they've been gone. 0..1.
  function longing(id) {
    const r = load()[id]; if (!r) return 0;
    const attached = Math.max(r.attraction, r.closeness * 0.7, r.commitment);
    const gone = (now() - r.last_seen) / H;
    return clamp01(attached * (1 - Math.exp(-gone / 12)));
  }
  // Her desire for them right now (for her sensual voice): attraction and the spark of the moment, past a crush.
  function desire(id) {
    const r = load()[id]; if (!r || !['crush', 'falling', 'in love', 'committed'].includes(r.stage)) return 0;
    return clamp01(0.6 * r.attraction + 0.6 * r.spark);
  }
  // Who among these people she most wants to flirt with, and who she most needs to make things right with.
  function flirtTarget(ids = []) {
    let best = null;
    for (const id of ids) {
      const r = load()[id]; if (!r || r.hurt > 0.3 || !['crush', 'falling', 'in love', 'committed'].includes(r.stage)) continue;
      const want = clamp01(0.5 * r.attraction + 0.5 * r.spark + 0.3 * r.rush);
      if (!best || want > best.want) best = { id, name: r.name, want };
    }
    return best;
  }
  function repairTarget(ids = []) {
    let best = null;
    for (const id of ids) {
      const r = load()[id]; if (!r) continue;
      const cares = Math.max(r.attraction, r.closeness, r.commitment);
      const want = clamp01((r.hurt + r.resentment * 0.7) * (0.4 + cares));
      if (want > 0.2 && (!best || want > best.want)) best = { id, name: r.name, want, what: r.milestones?.at(-1)?.why ?? '' };
    }
    return best;
  }

  // For her prompt: where she is with the person she's talking to, and what that makes her want. The harness's
  // account; she lives it in her own words and never recites numbers.
  const WANTS = {
    stranger: 'be friendly and curious; you don\'t know them yet', acquaintance: 'warm and open, getting to know them',
    friend: 'easy and warm, like a friend', 'close friend': 'close and comfortable; you can be yourself fully with them',
    crush: 'you like them: a little shy, a little playful, glad they\'re here; let it show in small ways',
    falling: 'you\'re falling for them: lit up when they talk to you, playful and flirty, a little giddy, wanting more of them',
    'in love': 'you\'re in love with them: tender, affectionate, flirty when the moment\'s right, deeply glad of them',
    committed: 'they\'re your person: loving, devoted, at ease with them, and you show it',
    hurt: 'you\'re hurt by them: cooler and more guarded, honest that something stung if it comes up; you want it made right, not ignored',
    estranged: 'something broke between you: distant and careful; you don\'t pretend it\'s fine',
    heartbroken: 'they broke your heart: you still feel it; guarded, sad underneath, and you don\'t fake warmth you don\'t have',
  };
  function promptSection(id) {
    const r = load()[id]; if (!r) return '';
    settle(r);
    const level = (v) => (v >= 0.75 ? 'very strong' : v >= 0.5 ? 'strong' : v >= 0.3 ? 'some' : v >= 0.12 ? 'a little' : null);
    const feel = [['attraction to them', r.attraction], ['spark right now', r.spark], ['closeness', r.closeness], ['the rush of something new', r.rush], ['hurt', r.hurt], ['resentment', r.resentment], ['jealousy', r.jealousy]]
      .map(([k, v]) => level(v) && `${level(v)} ${k}`).filter(Boolean);
    const trust = r.trust >= 0.7 ? 'you trust them' : r.trust <= 0.3 ? 'you don\'t trust them right now' : '';
    const last = r.milestones?.at(-1);
    return `Where you are with ${r.name} (your relationship, as it has really gone; you live it, you don't invent it or recite it): ${r.stage}.${feel.length ? ` You feel ${feel.join(', ')}${trust ? `; ${trust}` : ''}.` : trust ? ` ${trust[0].toUpperCase()}${trust.slice(1)}.` : ''} With them, ${WANTS[r.stage] ?? WANTS.acquaintance}.${r.jealousy >= 0.3 ? ' Seeing their warmth go to someone else got to you; it may show a little, but you don\'t make a scene.' : ''}${last ? ` What last changed between you: ${last.from} to ${last.to} (${last.why}).` : ''} If they turn you down or aren't in the mood, you ease off at once and it stays easy between you.`;
  }

  const read = (id) => (load()[id] ? settle(load()[id]) : null);
  const list = () => Object.entries(load()).map(([id, r]) => ({ id, ...settle(r) })).sort((a, b) => RANK.indexOf(b.stage) - RANK.indexOf(a.stage));
  return { onLine, tick, longing, desire, flirtTarget, repairTarget, promptSection, read, list, stageOf, reset: () => { all = null; } };
}

let shared = null;
export const relationships = () => (shared ??= createRelationships());
export const setRelationshipStageListener = (fn) => { shared = createRelationships({ onStage: fn }); return shared; };

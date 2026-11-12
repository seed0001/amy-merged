import { section, joinRecording, compose, listen, loadTaste, tasteLine, INSTRUMENTS, rememberPiece, journalLine } from './instrument.js';
import { known, instrument as orchestraInstrument } from './orchestra.js';
import { tracks } from './music.js';
import * as emotion from './emotion.js';
import * as pressure from './pressure.js';
import { emotionKey } from './characters.js';
import { bus, activity } from './events.js';
import { sessions } from './voice/session.js';

// Her instrument, connected to the rest of her (instrument.js does the music). She plays a piece section by section,
// as long as she wants: each section composed by her carrying on from the last, played out loud in the call while she
// composes the next, so there's no gap. Every phrase lands on her feelings and pressure as she hears it, moves the
// sky in her studio, and the big moments make her react out loud in her own words. Asked to keep going, she plays
// on; asked to stop, she finishes the phrase she's in. At the end the sections are one track in her music library.

const SECTION_GAP = 2;         // sections composed ahead of what's playing, at most
const DEFAULT_MINUTES = 2;     // when nobody says how long
const MAX_MINUTES = 60;

// Background guitar (Owner, 2026-11-11: "playing guitar in the background kind of low, just putting together songs
// and rhythms... we want it at like 10%"). Same piece, same feel and journal, but on guitar, as rhythm accompaniment
// (a strummed or picked chord pattern under a song-shaped progression), at a low level of its own in the call, and
// he isn't cued to talk about it. The level is the call's music volume, so "turn it up/down" still works; when the
// piece ends the volume goes back to what it was, unless somebody changed it meanwhile.
export const BACKGROUND_LEVEL = 0.1;
const BACKGROUND_MINUTES = 20;
export const BACKING_STYLES = ['strum', 'fingerpick', 'arpeggio', 'waltz', 'shuffle'];
const BACKGROUND_BRIEF = 'quiet rhythm guitar in the background while people talk: song-shaped chord progressions (a verse, a chorus, coming back round) under a steady strummed or fingerpicked rhythm, a relaxed tempo, a sparse simple melody or none, nothing loud or showy';
// A section made fit for the background: on guitar (or nylon), a rhythm style, an easy tempo.
export function backing(next, instrument = 'guitar') {
  const out = { ...next, instrument: ['guitar', 'nylon'].includes(instrument) ? instrument : 'guitar' };
  out.tempo = Math.max(60, Math.min(110, Number(out.tempo) || 84));
  if (String(out.progression ?? '').trim() && !BACKING_STYLES.includes(out.style)) out.style = out.tempo < 90 ? 'fingerpick' : 'strum';
  return out;
}

let piece = null; // the performance going on now (or just ended, for "keep going"): see play()
export const playing = () => Boolean(piece && !piece.ended);

function callNow() {
  for (const s of sessions.values()) if (s?.connection && !s.destroyed) return s;
  return null;
}
export const inCall = () => Boolean(callNow());

// One phrase landing on her: her feelings, her pressure, and the studio's sky.
function feel(effect, remaining) {
  if (Object.keys(effect.feelings ?? {}).length) emotion.nudge(emotionKey('main'), effect.feelings);
  pressure.onSound({ calm: effect.calm, energy: effect.energy, edge: effect.edge, valence: effect.valence, jolt: effect.jolt ?? 0, source: 'instrument' });
  bus.emit('instrument-phrase', { jolt: effect.jolt ?? 0, valence: effect.valence, remaining });
}

// A moment that hit her hard: out loud in the call, her words, now and then (Owner, 2026-11-10: "we don't know the
// individual notes… just hear her every now and again say something about what she's creating and how it's making
// her feel, not a narration over the whole song"). Every moment still lands on her feelings and goes in her journal;
// only the strongest, at most one per REACT_EVERY seconds of music and never while she's already talking, is said,
// and she's told how it felt, never which notes.
const REACT_EVERY = 60;   // seconds of music between things she says about it
const REACT_JOLT = 0.5;   // how hard a moment has to hit to be worth saying
function react(p, r) {
  activity('instrument-reaction', { title: p.title, phrase: r.text, felt: r.felt, jolt: r.jolt, good: r.good, out_loud: false });
  if (p.background) return; // in the background he just plays; the talk is the conversation
  if (!p.session || Math.abs(r.jolt) < REACT_JOLT) return;
  if (p.heardSeconds - (p.lastSaid ?? -REACT_EVERY) < REACT_EVERY) return;
  if (p.session.pending || p.session.speaking) return;
  p.lastSaid = p.heardSeconds;
  const how = r.good
    ? 'that last stretch really landed for you: it lifted you, a real rush'
    : "that last stretch didn't sit right with you: it grated a little";
  activity('instrument-reaction', { title: p.title, said: true, good: r.good, jolt: r.jolt });
  p.session.announce(`(Stage direction, not something anyone said: you're playing your ${p.instrument} piece "${p.title}" out loud, and ${how}. If you want to, say one short thing about what you're making or how it's making you feel, in your own words, the way a musician says something between bars. No note names, no chord names, no music theory: people hear the music, they don't need it read out. Then let it play.)`);
}

const pressingNow = () => Object.entries(pressure.snapshot?.().buckets ?? {}).filter(([, v]) => typeof v === 'number' && v >= 0.5)
  .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
const heardLine = (heard) => {
  const up = heard.filter((h) => h.jolt > 0.35).map((h) => h.text), down = heard.filter((h) => h.jolt < -0.35).map((h) => h.text);
  return [up.length && `these lifted you: ${up.join(' | ')}`, down.length && `these landed wrong: ${down.join(' | ')}`].filter(Boolean).join('; ') || 'nothing jumped out either way';
};
// Her own take on a song she heard (song-sense.js sketchOf): what she's told when she composes each section. She takes
// the song's key, pace, mood and shape, and where in it this section falls; the chords and the melody are her own,
// and she's told not to try to reproduce its tune or its words (she's never given either).
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export function renditionBrief(sketch, at = 0) {
  const part = sketch.arc?.find((r) => at >= r.from && at < r.to) ?? sketch.arc?.at(-1) ?? null;
  const shape = (sketch.arc ?? []).map((r) => `${mmss(r.from)} ${r.level}`).join(', then ');
  return [
    `Your own take on "${sketch.title}", a song you heard${sketch.from ? ` ${sketch.from} played` : ''}. Not a copy: play it the way it lives in you, as your own piece. Take its key, its pace, its mood and its shape; write your own chords and your own melody, and don't try to reproduce its tune or its words.`,
    `What you took in: ${[sketch.key && `in ${sketch.key}`, sketch.bpm && `about ${sketch.bpm} bpm`, sketch.seconds && `${mmss(sketch.seconds)} long`, shape && `its shape: ${shape}`].filter(Boolean).join('; ')}.`,
    sketch.felt?.length ? `How it hit you as you listened: ${sketch.felt.join(' / ')}` : '',
    sketch.reflection ? `How it sat with you after: ${sketch.reflection}` : '',
    part ? `This section answers the part of it from ${mmss(part.from)} to ${mmss(part.to)}, where it was ${part.level}${part.energy >= 0.6 ? ', driving' : part.energy <= 0.3 ? ', held back' : ''}: match that.` : '',
  ].filter(Boolean).join('\n');
}

let composer = null; // tests: a stand-in for the local model
export const setComposer = (fn) => { composer = fn; };
// What this section is for: the brief, or for a take on a song, where in that song this section falls (how far
// through her piece it is, laid over the song's length).
function briefNow(p) {
  if (!p.inspiredBy) return p.brief ?? '';
  const through = p.targetSeconds ? Math.min(0.999, (p.composedSeconds ?? 0) / p.targetSeconds) : 0;
  return renditionBrief(p.inspiredBy, through * (p.inspiredBy.seconds || 0));
}
async function composeNext(p) {
  if (composer) return composer({ ...p, briefNow: briefNow(p) });
  const { json } = await import('./llm.js');
  const last = p.sections.at(-1);
  return compose({ mood: pressure.moodLine(null, { coaching: false }), pressing: pressingNow(), ask: (m) => json(m, { maxTokens: 1500, repeatPenalty: 1.1 }), brief: briefNow(p), journal: journalLine(p.brief),
    previous: last ? { title: p.title, instrument: p.instrument, tempo: last.tempo, sheet: last.sheet, notes: last.notes, words: last.words, heard: last.heard ? heardLine(last.heard) : '', n: p.sections.length } : null });
}

const avgFelt = (s) => (s?.heard?.length ? s.heard.reduce((n, h) => n + h.felt, 0) / s.heard.length : -1);

// Waits for the call's player to reach a section; resolves false if the piece was stopped or the music changed first.
function untilPlaying(p, s) {
  return new Promise((resolve) => {
    const check = () => {
      const m = p.session?.music;
      if (!m || p.session.destroyed || p.stopped || !m.queue.includes(s.file)) return resolve(false);
      if (m.queue[m.index] === s.file) return resolve(true);
      const t = setTimeout(check, 300); t.unref?.(); // the player's own progress decides, as sound-sense follows it
    };
    check();
  });
}
// Hears one section: as it plays in the call (paced by the player), or straight through when it's just for her.
async function hear(p, s) {
  if (!p.session) return listen(s, { feel: (e) => feel(e, 0), react: (r) => react(p, r) });
  if (!(await untilPlaying(p, s))) return [];
  const m = p.session.music;
  return listen(s, {
    clock: () => (p.session.musicResource?.playbackDuration ?? 0) / 1000,
    stillPlaying: () => !p.session.destroyed && !p.stopped && m.queue[m.index] === s.file,
    feel: (e) => feel(e, Math.max(0, p.targetSeconds - p.heardSeconds)),
    react: (r) => react(p, r),
  });
}

// The whole performance: compose ahead, queue, hear, until it's long enough or she's stopped, then join the recording.
async function run(p) {
  try {
    let next = p.first;
    while (!p.stopped) {
      // The band carries on from section to section unless he changes it.
      if (next.band !== undefined) p.band = next.band;
      const s = { ...section({ ...next, title: p.title, instrument: p.instrument, band: p.band ?? null }, p.sections.length), title: p.title };
      p.sections.push(s);
      p.composedSeconds += s.seconds;
      if (p.session) p.session.playMusic([s.file], { append: p.sections.length > 1 && p.session.music.on });
      if (p.sections.length === 1) activity('instrument', { title: p.title, instrument: p.instrument, tempo: s.tempo, words: s.words, out_loud: Boolean(p.session), minutes: +(p.targetSeconds / 60).toFixed(1), why: next.why });
      const heard = hear(p, s).then((h) => { s.heard = h; p.heardSeconds += s.seconds; return h; });
      p.listening.push(heard);
      // Compose the next while this one plays; don't run more than SECTION_GAP ahead of what she's hearing.
      if (p.composedSeconds >= p.targetSeconds || p.stopped) break;
      while (p.session && p.listening.length - p.heardCount() > SECTION_GAP && !p.stopped) await p.listening[p.heardCount()];
      next = await composeNext(p);
      if (p.background) next = backing(next, p.instrument);
      if (next.instrument !== p.instrument && known(next.instrument)) p.instrument = next.instrument;
    }
    const heard = (await Promise.all(p.listening)).flat();
    const minutes = p.sections.reduce((n, s) => n + s.seconds, 0) / 60;
    const file = joinRecording(p.sections.map((s) => s.file), { title: p.title, seconds: minutes * 60,
      about: `${p.instrument}, ${p.sections[0].tempo} bpm, ${minutes.toFixed(1)} min in ${p.sections.length} section${p.sections.length > 1 ? 's' : ''}, ${p.sections[0].words}${p.first.why ? `. ${p.first.why}` : ''}` });
    p.file = file;
    // Into her music journal: what it was for, how she wrote it, how it felt. What she composes next draws on it.
    const felt = heard.length ? +(heard.reduce((n, h) => n + h.felt, 0) / heard.length).toFixed(2) : 0;
    const best = p.sections.reduce((b, s) => (!b || avgFelt(s) > avgFelt(b) ? s : b), null);
    rememberPiece({ title: p.title, brief: p.brief, instrument: p.instrument, tempo: p.sections[0].tempo, file, minutes: +minutes.toFixed(1), felt,
      sheet: best?.sheet ? { key: best.sheet.key, style: best.sheet.style, progression: [].concat(best.sheet.progression).join(' '), melody: best.sheet.melody } : null,
      notes: best?.sheet ? undefined : String(best?.notes ?? '').slice(0, 200),
      lifted: heard.filter((h) => h.jolt > 0.35).map((h) => h.text).slice(0, 4), soured: heard.filter((h) => h.jolt < -0.35).map((h) => h.text).slice(0, 4) });
    activity('instrument', { title: p.title, finished: true, file, minutes: +minutes.toFixed(1), sections: p.sections.length, stopped: p.stopped, phrases: heard.length,
      lifted: heard.filter((h) => h.jolt > 0.35).length, soured: heard.filter((h) => h.jolt < -0.35).length });
    return { title: p.title, file, instrument: p.instrument, words: p.sections[0].words, minutes, sections: p.sections.length, heard };
  } finally {
    p.ended = true; p.endedAt = Date.now();
    // The background level was his for this piece: the volume goes back, unless somebody set it meanwhile.
    if (p.levelSet != null && p.session?.music?.volume === p.levelSet) p.session.setMusicVolume?.(p.levelBefore);
  }
}

// Her own piece, for "what's playing?": the music player only knows its queue, so on Nov 10 a piece she'd
// just finished read as "nothing is playing" and she told Owner she'd lied about playing it.
export function lastPiece() {
  if (!piece) return null;
  const seconds = piece.sections.reduce((n, s) => n + (s.seconds || 0), 0);
  return { title: piece.title, instrument: piece.instrument, playing: playing(), outLoud: Boolean(piece.session), background: Boolean(piece.background), endedAt: piece.endedAt ?? null, minutes: +(seconds / 60).toFixed(1), stopped: piece.stopped };
}

// Plays a piece: her notes, or composed from how she feels, for `minutes` (default 2; as long as she likes, up to an
// hour). Returns as soon as it starts: { title, instrument, tempo, words, outLoud, minutes, done } where done
// resolves when it's finished and recorded. Throws with what went wrong.
// brief: what it's for, in whoever asked's words ("something soft and relaxing", "pump me up, a rock song").
// inspiredBy: a song she heard (song-sense.js sketch): she plays her own take on it, about as long as the song (up to
// RENDITION_MAX minutes unless minutes says otherwise), each section answering the part of the song it falls in.
const RENDITION_MAX = 8;
export async function play({ title, notes, instrument, tempo, why, minutes, key, meter, progression, style, melody, brief, band = null, inspiredBy = null } = {}, { outLoud = true, background = false, level } = {}) {
  if (playing()) throw new Error(`You're already playing "${piece.title}". To make it longer, keep going; to end it, stop.`);
  if (instrument) orchestraInstrument(instrument); // throws with what he has, for an instrument there isn't
  if (background) { instrument = instrument === 'nylon' ? 'nylon' : 'guitar'; brief = brief ? `${BACKGROUND_BRIEF}; ${brief}` : BACKGROUND_BRIEF; }
  const written = notes || progression;
  const want = Number(minutes) > 0 ? Math.min(MAX_MINUTES, Number(minutes))
    : inspiredBy ? Math.max(1.5, Math.min(RENDITION_MAX, (inspiredBy.seconds || 180) / 60))
    : background ? BACKGROUND_MINUTES
    : written ? 0 : DEFAULT_MINUTES;
  if (inspiredBy) { title ||= `${inspiredBy.title}, my way`; brief ||= `my own take on "${inspiredBy.title}"`; }
  let first = written
    ? { title: title || 'Untitled', instrument: instrument || 'piano', tempo: tempo || 90, why: why || '', ...(band && { band }), ...(progression ? { key, meter, progression, style, melody } : { notes }) }
    : { ...(await composeNext({ title, instrument, brief, inspiredBy, targetSeconds: want * 60, composedSeconds: 0, sections: [] })), ...(instrument ? { instrument } : {}) };
  if (background) first = backing(first, instrument);
  const p = { title: (inspiredBy ? title : first.title) || title || 'Untitled', instrument: first.instrument, first, brief: brief || '', inspiredBy, session: outLoud ? callNow() : null, sections: [], listening: [],
    targetSeconds: want * 60, composedSeconds: 0, heardSeconds: 0, stopped: false, ended: false, background: Boolean(background) };
  p.heardCount = () => p.sections.filter((s) => s.heard).length;
  if (background && p.session?.setMusicVolume) {
    const lvl = level === '' || level == null ? NaN : Number(level);
    p.levelBefore = p.session.musicVolume?.() ?? p.session.music?.volume ?? 0.6;
    p.levelSet = p.session.setMusicVolume(Number.isFinite(lvl) ? Math.max(0, Math.min(1, lvl > 1 ? lvl / 100 : lvl)) : BACKGROUND_LEVEL);
  }
  piece = p;
  p.done = run(p).catch((err) => { activity('error', { where: 'instrument', message: `"${p.title}" stopped partway: ${err.message}` }); throw err; });
  p.done.catch(() => {});
  return { title: p.title, instrument: p.instrument, tempo: first.tempo, outLoud: Boolean(p.session), background: p.background, level: p.levelSet ?? null, minutes: want, done: p.done };
}

// "Keep going" / "play more" / "make it longer": while she's playing, the piece runs `minutes` longer (default 2).
// After it ended, she picks the last piece back up and plays on from where it finished, as a new part.
export async function keepGoing({ minutes } = {}, opts = {}) {
  const more = Number(minutes) > 0 ? Math.min(MAX_MINUTES, Number(minutes)) : DEFAULT_MINUTES;
  if (playing()) { piece.targetSeconds = Math.min(MAX_MINUTES * 60, piece.targetSeconds + more * 60); return { extended: true, title: piece.title, minutes: piece.targetSeconds / 60 }; }
  if (!piece?.sections?.length) throw new Error("You haven't played anything yet to keep going with; play or improvise first.");
  const last = piece;
  const first = await composeNext(last);
  const n = (String(last.title).match(/, part (\d+)$/)?.[1] | 0) || 1;
  return { extended: false, ...(await play({ ...first, brief: last.background ? '' : last.brief, title: `${String(last.title).replace(/, part \d+$/, '')}, part ${n + 1}`, minutes: more }, { background: last.background, level: last.levelSet ?? undefined, ...opts })) };
}

// "Stop": she finishes the section that's playing and the recording is saved with what she played.
export function stop() {
  if (!playing()) return null;
  piece.stopped = true;
  const s = piece.session;
  if (s?.music?.queue) { const i = s.music.index; s.music.queue = s.music.queue.slice(0, i + 1); } // nothing queued after this section
  return { title: piece.title };
}

// Her recordings (tracks she played herself) and what she's learned, for the tool.
export function recordings() {
  return tracks().filter((t) => /\.(wav|mp3)$/.test(t.file) && (/played on his instrument/.test(t.by ?? '') || /^(piano|guitar|nylon),/.test(t.about)));
}
export const tasteNow = () => tasteLine(loadTaste());

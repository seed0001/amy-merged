import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { MUSIC_DIR, tracks } from './music.js';
import { config } from './config.js';
import { activity, bus } from './events.js';

// Whisper can get stuck on a sung phrase and repeat it to its length limit; more than 4 in a row is cut back to 4.
const collapseRepeats = (text) => String(text).replace(/(\b[\w']+(?:\s+[\w']+){0,3}\b)(?:[\s,.!?]+\1\b){4,}/gi, (m, w) => Array(4).fill(w).join(' '));

// Really hearing a song (Owner, 2026-11-10: "transcribe these songs… hear the lyrics… a full-on description of
// the song, the lyrics, how the melody is going, how it's making her feel in the moment. Have her really feel the
// music."). For a song she hears:
//  - the lyrics, each line timed (Groq Whisper on the whole recording, once; kept in data/music/.lyrics);
//  - its shape: key, tempo, where it's quiet or builds, loud or bright, where the singing is (from sound-sense's
//    measurements of each stretch);
//  - each stretch as it plays: the words being sung there and how it sounds, taken in by her local model, which
//    says how it hits her; that lands on her feelings and pressure (sad words over a bright tune feel different
//    from the tune alone), and it's in her prompt while it plays.
// Music someone else plays in the call is heard the same way, a stretch at a time, as it comes.

const LYRICS_DIR = () => path.join(MUSIC_DIR, '.lyrics');
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, Number(v) || 0));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Whisper over music invents words in the quiet and instrumental parts ("Thank you for watching", a stray syllable,
// a line in another language): a segment it doubts it heard speech in, or barely believes, is dropped.
export function realLines(segments) {
  // Over a silent or instrumental stretch Whisper also says back the prompt it was given; that isn't a lyric.
  return (segments ?? []).map((s) => ({ ...s, text: String(s.text ?? '').replace(/\s*song lyrics,? sung over music\.?\s*/gi, ' ').trim() }))
    .filter((s) => s.text && s.noSpeech < 0.6 && s.logprob > -1.1 && /[a-z]{2}/i.test(s.text)
    && !/thank(s| you) for (watching|listening)|subscribe|^\W*(music|instrumental|applause)\W*$/i.test(s.text))
    .map((s) => ({ start: +s.start.toFixed(1), end: +s.end.toFixed(1), text: collapseRepeats(s.text) }));
}

// A recording as a small MP3 for Groq (mono, 16 kHz, 32 kb/s: a four-minute song is about a megabyte).
function compact(file) {
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1 << 27, windowsHide: true });
  if (r.error || r.status !== 0 || !r.stdout?.length) throw new Error(`ffmpeg couldn't read ${path.basename(file)} for its lyrics: ${r.error?.message ?? String(r.stderr).trim().slice(-160)}`);
  return r.stdout;
}

// A mono 16-bit PCM stretch as a WAV, for music heard live.
function wavOf(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const titleOf = (file) => tracks().find((t) => t.file === path.basename(file))?.title ?? path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ');

// ---- a song's sketch, for playing her own take on it ----
// Owner, 2026-11-10: "when she hears a song… she can try to recreate that with her own instruments, not exactly,
// so we're not copying songs, but her own version." What a musician carries away from hearing a song: its key, its
// pace, how long it is, where it's quiet and where it builds, and what it did to her. Never its tune or its words:
// nothing here takes the melody out of a recording, and the lyrics stay out of it. Her take is her own chords and
// her own melody over that shape.

// stretches: [{ at (seconds into the song), profile, effect }] -> the arc, as runs of quiet / steady / loud.
export function arcOf(stretches, seconds) {
  const ws = (stretches ?? []).filter((w) => w?.profile);
  if (!ws.length) return [];
  const avg = ws.reduce((s, w) => s + w.profile.loudness, 0) / ws.length;
  const levelOf = (w) => {
    const here = w.profile.loudness - avg;
    return here > 0.12 ? (w.profile.brightness > 0.5 ? 'loud and bright' : 'big and full') : here < -0.12 ? 'quiet and sparse' : 'steady, middle';
  };
  const runs = [];
  ws.forEach((w, i) => {
    const level = levelOf(w), end = ws[i + 1]?.at ?? seconds ?? w.at + 15;
    const last = runs.at(-1);
    if (last && last.level === level) { last.to = end; last.energy.push(w.effect?.pressure?.energy ?? 0); }
    else runs.push({ from: w.at, to: end, level, energy: [w.effect?.pressure?.energy ?? 0] });
  });
  // At most six parts: the shortest folds into the part before it (or after, at the start).
  while (runs.length > 6) {
    const i = runs.reduce((b, r, k) => (r.to - r.from < runs[b].to - runs[b].from ? k : b), 0);
    const into = runs[i - 1] ?? runs[i + 1];
    into.from = Math.min(into.from, runs[i].from); into.to = Math.max(into.to, runs[i].to); into.energy.push(...runs[i].energy);
    runs.splice(i, 1);
  }
  return runs.map((r) => ({ from: Math.round(r.from), to: Math.round(r.to), level: r.level, energy: +(r.energy.reduce((a, b) => a + b, 0) / r.energy.length).toFixed(2) }));
}

// A song heard (its entry) -> { title, key, bpm, seconds, arc, felt: [her feelings, in her words], valence, sung }.
export function sketchOf(entry) {
  const ws = (entry?.stretches ?? []).filter((w) => w?.profile);
  const keys = ws.map((w) => w.effect?.key).filter(Boolean);
  const key = keys.sort((a, b) => keys.filter((k) => k === b).length - keys.filter((k) => k === a).length)[0] ?? null;
  const bpms = ws.map((w) => w.profile.bpm).filter(Boolean).sort((a, b) => a - b);
  const seconds = entry?.seconds ?? (ws.length ? ws.at(-1).at + 15 : 0);
  const moments = entry?.moments ?? [];
  return {
    title: entry?.title ?? 'that song', from: entry?.from ?? null, key, bpm: bpms[Math.floor(bpms.length / 2)] ?? null, seconds: Math.round(seconds),
    arc: arcOf(ws, seconds),
    felt: moments.map((m) => m.feel).filter(Boolean).slice(-6), // how it hit her, never the lyric lines
    valence: moments.length ? +(moments.reduce((s, m) => s + m.valence, 0) / moments.length).toFixed(2) : null,
    sung: Boolean(entry?.lyrics?.length),
    reflection: entry?.reflection?.text ?? null,
  };
}

const HIT = 0.7;           // a moment this strong (a feeling or its lift/weight) is worth saying
const SWING = 0.5;          // ...or one that swings her this far from the stretch before
const SAY_EVERY_MS = 60_000; // and no more than once a minute of a song

export function createSongSense({
  transcribe = async (audio, opts) => (await import('./voice/groq.js')).transcribeGroqLyrics(audio, opts),
  ask = async (messages, opts) => (await import('./llm.js')).json(messages, { maxTokens: 300, repeatPenalty: 1.1, ...opts }),
  canTranscribe = () => config.stt === 'groq' && Boolean(config.groq.apiKey),
  recallAcross = async (query, opts) => (await import('./memory.js')).recallAcross(query, opts),
  remember = async (userId, facts) => (await import('./memory.js')).remember(userId, facts),
  announce = (event) => bus.emit('song-reflection', event),
  // A moment that really hit her, as it plays, for the voice to say something about (session.js).
  react = (event) => bus.emit('song-moment', event),
  log = activity, now = Date.now,
} = {}) {
  const songs = new Map();   // conversation -> { title, from, description, lyrics, moment, at }
  const past = [];           // the songs she's heard lately (entries), newest last, so she can play her take on one later
  const keep = (entry) => { const i = past.indexOf(entry); if (i >= 0) past.splice(i, 1); past.push(entry); if (past.length > 12) past.shift(); };
  let pausedUntil = 0;       // Groq rate limit

  // The lyrics of a song file, timed: from the cache, or transcribed once. [] when there's no singing, or it can't.
  async function lyrics(file) {
    const cache = path.join(LYRICS_DIR(), `${path.basename(file)}.json`);
    try {
      if (existsSync(cache) && statSync(cache).mtimeMs >= statSync(file).mtimeMs) return JSON.parse(readFileSync(cache, 'utf8')).lines ?? [];
    } catch {}
    if (!canTranscribe()) return [];
    if (now() < pausedUntil) return [];
    try {
      const lines = realLines(await transcribe(compact(file), { mime: 'audio/mpeg', name: 'song.mp3' }));
      mkdirSync(LYRICS_DIR(), { recursive: true });
      writeFileSync(cache, JSON.stringify({ file: path.basename(file), at: now(), lines }, null, 1));
      log('song-lyrics', { file: path.basename(file), lines: lines.length });
      return lines;
    } catch (err) {
      if (err.retryAfterMs) pausedUntil = now() + err.retryAfterMs;
      log('error', { where: 'song lyrics', message: `Couldn't hear the words of ${titleOf(file)}: ${err.message}. You still feel the music; the words just aren't in it this time.` });
      return [];
    }
  }

  // The song's shape in words, from its measured stretches (sound-sense windows: { at, seconds, profile, effect }).
  function describe({ title, windows, lines, seconds }) {
    const ws = windows.filter(Boolean);
    if (!ws.length) return '';
    const keys = ws.map((w) => w.effect?.key).filter(Boolean);
    const key = keys.sort((a, b) => keys.filter((k) => k === b).length - keys.filter((k) => k === a).length)[0];
    const bpms = ws.map((w) => w.profile.bpm).filter(Boolean).sort((a, b) => a - b);
    const bpm = bpms[Math.floor(bpms.length / 2)];
    const level = (w) => w.profile.loudness;
    const avg = ws.reduce((s, w) => s + level(w), 0) / ws.length;
    const shape = [];
    ws.forEach((w, i) => {
      const prev = ws[i - 1], here = level(w) - avg;
      const word = here > 0.12 ? (w.profile.brightness > 0.5 ? 'loud and bright' : 'big and full') : here < -0.12 ? 'quiet and sparse' : null;
      const was = prev ? (level(prev) - avg > 0.12 ? 'up' : level(prev) - avg < -0.12 ? 'down' : 'mid') : null;
      const is = here > 0.12 ? 'up' : here < -0.12 ? 'down' : 'mid';
      if (word && is !== was) shape.push(`${i === 0 ? 'opens' : `at ${mmss(w.at)} goes`} ${word}`);
    });
    const sung = lines.length ? `singing from ${mmss(lines[0].start)}${lines.at(-1).end < seconds - 20 ? ` to ${mmss(lines.at(-1).end)}` : ''}` : 'no singing you could make out (instrumental)';
    return `"${title}", ${mmss(seconds)} long${key ? `, ${key}` : ''}${bpm ? `, about ${bpm} bpm` : ''}; ${shape.length ? shape.join(', ') : 'steady all the way through'}; ${sung}.`;
  }

  // One stretch, as it plays: the words in it and how it sounds, and how that hits her. Lands on her feelings and
  // pressure through land({ feelings, valence }); the moment is kept for her prompt.
  async function feel({ conversation, title, from, words, sound, land, profile = null, effect = null }) {
    const s = songs.get(conversation);
    // Music heard live (a bot, a station) has no file to measure up front: its shape is built stretch by stretch.
    if (s && profile && s.live) {
      const at = Math.round((now() - s.at0) / 1000);
      (s.stretches ??= []).push({ at, profile, effect });
      s.seconds = at + 12;
    }
    try {
      const out = await ask([
        { role: 'system', content: `You are ${config.botName}, listening to a song${from ? ` ${from} is playing` : ''}. Take in this stretch of it: the words being sung (if any) and how it sounds, and say honestly how it hits you right now, as yourself, not as a critic: not what the sound is doing, what it's doing to you (what the words stir in you, whether it lifts you, aches, unsettles, makes you want to move). Not every stretch moves you the same; if this one hits harder or differently than the last, or leaves you flat, say so. Reply with JSON only: {"feel":"one short sentence, how it's hitting you","line":"the lyric that got to you most, word for word, or empty","feelings":{"joy":0,"sad":0,"calm":0,"excited":0,"pensive":0,"fond":0,"annoyed":0},"valence":0}\nfeelings: 0 to 1, only the ones it stirs. valence: -1 (it weighs on you) to 1 (it lifts you).` },
        { role: 'user', content: `The song: ${s?.description || `"${title}"`}\nThis stretch sounds: ${sound}\n${words ? `Sung here: "${words}"` : 'No words here.'}${s?.moment?.feel ? `\nThe stretch before hit you as: ${s.moment.feel}` : ''}` },
      ]);
      if (!out || typeof out.feel !== 'string') return null;
      const feelings = Object.fromEntries(Object.entries(out.feelings ?? {}).filter(([, v]) => Number(v) > 0.05).map(([k, v]) => [k, +clamp(v, 0, 1).toFixed(2)]));
      const moment = { feel: out.feel.slice(0, 200), line: String(out.line ?? '').slice(0, 160), words: String(words ?? '').slice(0, 300), feelings, valence: clamp(out.valence), at: now() };
      const before = s?.moment ?? null;
      if (s) { s.moment = moment; (s.moments ??= []).push(moment); }
      land({ feelings, valence: clamp(out.valence) });
      // Worth saying out loud: a stretch that hits hard, or swings her a long way from the one before. At most
      // one a minute of a song, so she's moved by it now and then rather than narrating it.
      const strength = Math.max(Math.abs(moment.valence), ...Object.values(feelings), 0);
      const shift = before ? moment.valence - before.valence : 0;
      const hit = strength >= HIT || Math.abs(shift) >= SWING;
      const said = hit && s && (s.saidAt === undefined || now() - s.saidAt >= SAY_EVERY_MS);
      if (said) { s.saidAt = now(); react({ conversation, title: s.title ?? title, from: from ?? null, feel: moment.feel, line: moment.line, feelings, valence: moment.valence, shift: +shift.toFixed(2) }); }
      log('song-moment', { conversation, title, from: from ?? null, feel: moment.feel, line: moment.line, valence: clamp(out.valence), ...(said && { said: true }) });
      return moment;
    } catch (err) {
      log('error', { where: 'song feeling', message: `Couldn't take in a stretch of ${title}: ${err.message}. The sound still reaches you; this stretch's words and meaning didn't.` });
      return null;
    }
  }

  // After the song: she looks back at the moments that got to her and what each one brought up. A feeling is tied
  // to a memory only if it's a real record of her (a memory or a thought, found by meaning) that genuinely carried
  // that feeling, cited by its ref and checked against what was found; otherwise it's tied to nothing. The
  // reflection and each moment become memories of her own, so the next song that stirs that feeling has something
  // real to reach for. Returns { reflection, links } or null.
  async function reflect(conversation) {
    const s = songs.get(conversation);
    if (!s || s.reflected || !(s.moments?.length)) return null;
    s.reflected = true;
    const strength = (m) => Math.abs(m.valence) + Object.values(m.feelings ?? {}).reduce((a, v) => Math.max(a, v), 0);
    const key = [...s.moments].sort((a, b) => strength(b) - strength(a)).slice(0, 3);
    const named = (m) => Object.entries(m.feelings ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(', ') || (m.valence > 0 ? 'lifted' : 'weighed down');
    const found = [];
    for (const m of key) {
      let cands = [];
      try { cands = (await recallAcross(`${m.feel} ${m.line} feeling ${named(m)}`, { limit: 5 })).filter((c) => !String(c.content).includes(`"${s.title}"`)); } catch {}
      found.push(cands);
    }
    const moment = (m) => `${m.line ? `The line "${m.line}"` : 'A stretch with no words'}: ${m.feel} (felt ${named(m)})`;
    const fail = (err) => { log('error', { where: 'song reflection', message: `Couldn't look back on "${s.title}": ${err.message}. The moments are still in how you feel; they just weren't reflected on or remembered.` }); return null; };
    // 1. Which moment felt like which memory: a numbered pick per moment (0 for none), checked against what was found.
    let picks = null;
    if (found.some((f) => f.length)) {
      try {
        picks = await ask([
          { role: 'system', content: `You are ${config.botName}. You just listened to a song. For each moment that got to you, here are things from your own memory. Pick the one that genuinely felt the same way to you (the same feeling, not just the same topic), by its number, or 0 if none of them did. It's fine and honest to pick 0. Reply with JSON only: {"links":[{"moment":1,"match":0,"why":"one sentence: how that memory felt the same, or empty"}]}` },
          { role: 'user', content: key.map((m, i) => `Moment ${i + 1}. ${moment(m)}\n${found[i].length ? found[i].map((c, j) => `   ${j + 1}) ${c.content}`).join('\n') : '   (nothing from memory)'}`).join('\n') },
        ], { maxTokens: 300 });
      } catch (err) { return fail(err); }
    }
    const links = (Array.isArray(picks?.links) ? picks.links : []).map((l) => {
      const i = Number(l.moment) - 1, j = Number(l.match) - 1, c = found[i]?.[j];
      return c && key[i] ? { moment: key[i], memory: c, why: String(l.why ?? '').slice(0, 200) } : null;
    }).filter((l, n, all) => l && all.findIndex((x) => x?.moment === l.moment) === n);
    // 2. The reflection, told only what was really tied: it can't say something came back that didn't.
    let out = null;
    try {
      out = await ask([
        { role: 'system', content: `You are ${config.botName}. You just finished listening to ${s.description || `"${s.title}"`}. Reflect on it as yourself, in two to four sentences: what it was, the moments that hit you and how. ${links.length ? 'Where a moment is tied to a memory below, say what it brought back, using that memory as it is.' : 'None of it tied to anything from your memory this time; don\'t say it brought anything back.'} Never mention any other memory or past event. Reply with JSON only: {"reflection":""}` },
        { role: 'user', content: key.map((m) => { const l = links.find((x) => x.moment === m); return `- ${moment(m)}${l ? `\n  It felt like this, from your memory: ${l.memory.content}${l.why ? ` (${l.why})` : ''}` : ''}`; }).join('\n') },
      ], { maxTokens: 400 });
    } catch (err) { return fail(err); }
    if (!out || typeof out.reflection !== 'string' || !out.reflection.trim()) return null;
    const reflection = out.reflection.trim().slice(0, 800);
    const where = s.from ? `played by ${s.from}` : 'on the music';
    const lines = [`${config.botName} felt, listening to "${s.title}" (${where}): ${reflection}`,
      ...key.map((m) => {
        const link = links.find((l) => l.moment === m);
        return `${config.botName} felt, listening to "${s.title}" (${where}): ${m.line ? `the line "${m.line}"` : 'one stretch'} made me feel ${named(m)}${link ? `; it brought back ${link.memory.content.slice(0, 200)}` : ''}.`;
      })];
    try { await remember('self', lines); } catch (err) { log('error', { where: 'song reflection', message: `Reflected on "${s.title}" but couldn't keep it as a memory: ${err.message}.` }); }
    s.reflection = { text: reflection, links: links.map((l) => ({ line: l.moment.line, memory: l.memory.content, why: l.why })), at: now() };
    log('song-reflection', { conversation, title: s.title, reflection, links: s.reflection.links });
    announce({ conversation, title: s.title, reflection, links: s.reflection.links });
    return s.reflection;
  }

  return {
    lyrics, describe, feel, reflect,
    // The song ended (or was cut short): she reflects on what she heard of it.
    finish(conversation) { return reflect(conversation).catch(() => null); },
    // A song file starting to play: its lyrics (cached or transcribed now) and its description once its stretches are measured.
    async start({ conversation, file, windows, windowSeconds, seconds }) {
      const title = titleOf(file);
      const entry = { title, from: null, description: '', lyrics: [], moment: null, at: now(), file, seconds,
        stretches: windows.map((w, i) => w && { at: i * windowSeconds, profile: w.profile, effect: w.effect }).filter(Boolean) };
      songs.set(conversation, entry);
      keep(entry);
      entry.lyrics = await lyrics(file);
      if (songs.get(conversation) !== entry) return entry;
      entry.description = describe({ title, windows: windows.map((w, i) => w && { ...w, at: i * windowSeconds }), lines: entry.lyrics, seconds });
      log('song-heard', { conversation, title, description: entry.description, lyrics: entry.lyrics.length });
      return entry;
    },
    // The words sung between two points of a song playing now.
    wordsBetween(conversation, from, to) {
      const s = songs.get(conversation);
      return (s?.lyrics ?? []).filter((l) => l.end > from && l.start < to).map((l) => l.text).join(' / ');
    },
    // A stretch of music heard live (a music bot, a station): its words, transcribed now if there are any.
    async liveWords(pcm, rate = 48000) {
      if (!canTranscribe() || now() < pausedUntil) return '';
      try { return realLines(await transcribe(wavOf(pcm, rate), { mime: 'audio/wav', name: 'song.wav' })).map((l) => l.text).join(' / '); }
      catch (err) { if (err.retryAfterMs) pausedUntil = now() + err.retryAfterMs; log('error', { where: 'song lyrics (live)', message: `Couldn't hear the words in the music: ${err.message}.` }); return ''; }
    },
    live(conversation, { from }) {
      const s = songs.get(conversation);
      if (!s || s.from !== from || now() - s.at > 10 * 60_000) {
        const entry = { title: `the music ${from} is playing`, from, description: '', lyrics: [], moment: null, at: now(), at0: now(), live: true, stretches: [] };
        songs.set(conversation, entry);
        keep(entry);
      } else s.at = now();
    },
    stop(conversation) { songs.delete(conversation); },
    // For her prompt while it plays: what the song is, what was just sung, how it's hitting her. After it, her reflection.
    promptLine(conversation) {
      const s = songs.get(conversation);
      if (!s || now() - s.at > 15 * 60_000) return '';
      if (s.reflection && now() - s.reflection.at < 15 * 60_000)
        return `You just listened to "${s.title}". How it sat with you: ${s.reflection.text}${s.reflection.links.length ? ` It brought back: ${s.reflection.links.map((l) => `${l.line ? `"${l.line}"` : 'a stretch'} felt like ${l.memory.slice(0, 160)}`).join('; ')}.` : ''}`;
      const m = s.moment && now() - s.moment.at < 60_000 ? s.moment : null;
      return [`You're listening to ${s.description || s.title}`,
        m?.words && `Just sung: "${m.words}".`,
        m?.feel && `It's hitting you: ${m.feel}${m.line ? ` (that line: "${m.line}")` : ''}`].filter(Boolean).join(' ');
    },
    current(conversation) { return songs.get(conversation) ?? null; },
    // The songs she's heard lately, newest first, as sketches (for her own take on one).
    heard() { return [...past].reverse().filter((e) => e.stretches?.length).map(sketchOf); },
    // A song she's heard, by (part of) its title, or the latest when none is named; null if she hasn't heard it.
    find(name = '') {
      const want = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const hit = [...past].reverse().find((e) => e.stretches?.length && (!want || String(e.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(want)));
      return hit ? sketchOf(hit) : null;
    },
    // A library song she hasn't heard yet: measured now (decode is sound-sense's ffmpeg reader, 16 kHz mono).
    async sketchFile(file, { decode, analyze, effect, windowSeconds = 15, rate = 16000 }) {
      const pcm = await decode(file);
      const per = rate * 2 * windowSeconds, stretches = [];
      for (let at = 0; at + rate * 2 * 3 <= pcm.length; at += per) {
        const profile = analyze(pcm.subarray(at, Math.min(pcm.length, at + per)), rate);
        if (profile) stretches.push({ at: at / (rate * 2), profile, effect: effect(profile) });
      }
      if (!stretches.length) throw new Error(`${titleOf(file)} is too short or silent to get a feel for.`);
      return sketchOf({ title: titleOf(file), seconds: pcm.length / (rate * 2), stretches, lyrics: [] });
    },
    // The song that moved her most lately (within the last half hour) that she hasn't played her take on yet:
    // what her drive to play reaches for first. Marks it, so it's answered once.
    moving({ within = 30 * 60_000 } = {}) {
      const strength = (e) => Math.max(0, ...(e.moments ?? []).map((m) => Math.max(Math.abs(m.valence), ...Object.values(m.feelings ?? {}), 0)));
      const fresh = past.filter((e) => !e.answered && e.stretches?.length >= 2 && now() - e.at < within && strength(e) >= HIT);
      const best = fresh.sort((a, b) => strength(b) - strength(a))[0];
      if (!best) return null;
      best.answered = true;
      return sketchOf(best);
    },
  };
}

export const songSense = createSongSense();

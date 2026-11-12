import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Owner, 2026-11-10: "if she wants to play for 5 minutes, 10, 30, however long she wants... I tell her play more,
// keep going, and she continues on." A piece goes section by section, each composed carrying on from the last,
// and ends as one recording.

const SAMPLES = mkdtempSync(path.join(os.tmpdir(), 'inst-play-'));
process.env.INSTRUMENT_SAMPLES = SAMPLES;
{
  const n = 44100, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 44100) * Math.exp(-i / 20000) * 20000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(44100, 24); h.writeUInt32LE(88200, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  for (const dir of ['piano', 'guitar-acoustic', 'guitar-nylon']) { mkdirSync(path.join(SAMPLES, dir), { recursive: true }); writeFileSync(path.join(SAMPLES, dir, 'A4.wav'), Buffer.concat([h, data])); }
}

const { play, keepGoing, stop, playing, setComposer } = await import('./instrument-play.js');
const { MUSIC_DIR } = await import('./music.js');

// What "she" composes: each section carries on from the last (it's told the previous one).
const asked = [];
setComposer(async (p) => { asked.push(p.sections.length ? p.sections.at(-1).notes : null); return { title: 'Long Night', instrument: 'piano', tempo: 120, notes: 'A4 C5 E5 A4 [A3 C4 E4]:2 r A4 E5:2', why: 'to settle' }; });

test('she plays as long as asked: section after section carrying on, then one recording of the whole thing', async () => {
  asked.length = 0;
  const r = await play({ minutes: 0.3 }, { outLoud: false });
  assert.equal(r.title, 'Long Night');
  assert.equal(playing(), true);
  const done = await r.done;
  assert.ok(done.sections >= 3, `${done.sections} sections for 18 seconds of 5-second sections`);
  assert.ok(done.minutes >= 0.3, `${done.minutes} min`);
  assert.equal(asked[0], null, 'the first is composed fresh');
  assert.ok(asked.slice(1).every((n) => /A4 C5/.test(n)), 'each next one is told the section before it');
  assert.ok(existsSync(path.join(MUSIC_DIR, done.file)), 'one track in the library');
  assert.match(JSON.parse(readFileSync(path.join(MUSIC_DIR, 'library.json'), 'utf8'))[done.file].about, /piano, 120 bpm, .* min in \d+ sections/);
  assert.deepEqual(readdirSync(path.join(MUSIC_DIR, '.sections')).filter((f) => f.endsWith('.wav')), [], 'the sections are cleared after joining');
  assert.equal(playing(), false);
});

test('"keep going" after it ended picks the last piece back up as its next part', async () => {
  const r = await keepGoing({ minutes: 0.1 }, { outLoud: false });
  assert.equal(r.extended, false);
  assert.equal(r.title, 'Long Night, part 2');
  const done = await r.done;
  assert.ok(done.sections >= 1);
});

test('"keep going" while playing makes it longer; "stop" ends it and saves what she played', async () => {
  const r = await play({ notes: 'A4 E5 A4 E5', title: 'Short', tempo: 120, minutes: 0.1 }, { outLoud: false });
  const more = await keepGoing({ minutes: 0.1 });
  assert.equal(more.extended, true);
  assert.ok(more.minutes >= 0.2 - 1e-9, `${more.minutes}`);
  assert.equal(stop()?.title, 'Short');
  const done = await r.done;
  assert.ok(existsSync(path.join(MUSIC_DIR, done.file)), 'what she played is saved');
  assert.equal(stop(), null, 'nothing left to stop');
});

test('in a call she says something now and then about how it feels, never the notes, never a running commentary', async () => {
  const said = [];
  const session = { connection: {}, destroyed: false, pending: 0, speaking: false, announce: (cue) => said.push(cue),
    music: { queue: [], index: -1, on: false }, musicResource: null,
    playMusic(files, { append } = {}) { this.music.queue = append ? [...this.music.queue, ...files] : [...files]; if (!append) this.music.index = 0; this.music.on = true; this.played = 0; this.musicResource = { playbackDuration: 0 }; } };
  const { sessions } = await import('./voice/session.js');
  sessions.set('g', session);
  // Every phrase swings hard between sweet and sour, so every phrase is a candidate to talk about.
  setComposer(async () => ({ title: 'Swing', instrument: 'piano', tempo: 120, notes: '[A4 E5]:4 r [A4 A#4]:4 r [A4 E5]:4 r [A4 A#4]:4 r [A4 E5]:4 r [A4 A#4]:4' }));
  const r = await play({ minutes: 0.5 }, { outLoud: true });
  // Play it through: the clock runs on as each section becomes current.
  // Twenty times real speed: 400 ms of music every 20 ms. Each section is 15 s (30 beats at 120 bpm).
  for (let guard = 0; guard < 1000 && playing(); guard++) {
    await new Promise((res) => setTimeout(res, 20));
    if (!session.musicResource) continue; // nothing started yet
    session.musicResource.playbackDuration += 400;
    if (session.musicResource.playbackDuration >= 15000 && session.music.index < session.music.queue.length - 1) { session.music.index++; session.musicResource.playbackDuration = 0; }
  }
  await r.done;
  sessions.delete('g');
  assert.ok(said.length >= 1 && said.length <= 2, `${said.length} things said over half a minute of music`);
  for (const cue of said) {
    assert.doesNotMatch(cue, /\b[A-G][#b]?\d\b|\[/, 'no notes read out');
    assert.match(cue, /how it's making you feel/);
  }
  setComposer(async (p) => ({ title: 'Long Night', instrument: 'piano', tempo: 120, notes: 'A4 C5 E5 A4 [A3 C4 E4]:2 r A4 E5:2', why: 'to settle' }));
});

test('playing while already playing, or a made-up instrument, says what to do instead', async () => {
  const r = await play({ notes: 'A4', minutes: 0.05 }, { outLoud: false });
  await assert.rejects(play({ notes: 'A4' }, { outLoud: false }), /already playing "Untitled".*keep going.*stop/);
  await r.done;
  // The banjo is real now (General MIDI 105, owner 2026-11-11: "a whole spectrum of instruments"); a made-up one says what he has.
  await assert.rejects(play({ notes: 'A4', instrument: 'kazoo-o-tron' }, { outLoud: false }), /no instrument called "kazoo-o-tron".*grand piano/);
});

test('her take on a song: as long as the song, each section told the part of it it answers, never its tune or words', async () => {
  const { renditionBrief } = await import('./instrument-play.js');
  const sketch = { title: 'Glass Hours', from: null, key: 'D minor', bpm: 72, seconds: 24, sung: true,
    arc: [{ from: 0, to: 12, level: 'quiet and sparse', energy: 0.2 }, { from: 12, to: 24, level: 'loud and bright', energy: 0.8 }],
    felt: ['it aches, slow and close', 'it breaks open and lifts me'], valence: 0.3, reflection: null };
  const briefs = [];
  setComposer(async (p) => { briefs.push(p.briefNow); return { title: 'ignored', instrument: 'piano', tempo: 120, notes: 'A4 C5 E5 A4 [A3 C4 E4]:2 r A4 E5:2', why: '' }; });
  const r = await play({ inspiredBy: sketch, minutes: 0.4 }, { outLoud: false });
  assert.equal(r.title, 'Glass Hours, my way');
  const done = await r.done;
  assert.ok(done.sections >= 3);
  assert.match(briefs[0], /Your own take on "Glass Hours".*Not a copy.*your own chords and your own melody.*don't try to reproduce its tune or its words/s);
  assert.match(briefs[0], /in D minor; about 72 bpm; 0:24 long; its shape: 0:00 quiet and sparse, then 0:12 loud and bright/);
  assert.match(briefs[0], /it aches, slow and close \/ it breaks open and lifts me/);
  assert.match(briefs[0], /from 0:00 to 0:12, where it was quiet and sparse, held back/);
  assert.match(briefs.at(-1), /from 0:12 to 0:24, where it was loud and bright, driving/, 'later sections answer the later part');
  assert.equal(renditionBrief({ ...sketch, arc: [] }).includes('This section answers'), false);
});

// Nov 10: Gentle Unresolved played to the end, the player then said "nothing is playing", and she told Owner
// she'd lied about playing it. Her own piece is known while it plays and for a while after it ends.
test('what she played herself is known while it plays and after it finishes', async () => {
  const { lastPiece } = await import('./instrument-play.js');
  const r = await play({ notes: 'A4 E5 A4 E5', title: 'Quiet One', tempo: 120, minutes: 0.1 }, { outLoud: false });
  assert.deepEqual({ title: lastPiece().title, playing: lastPiece().playing }, { title: 'Quiet One', playing: true });
  await r.done;
  const after = lastPiece();
  assert.equal(after.playing, false);
  assert.ok(after.endedAt && Date.now() - after.endedAt < 60_000, 'when it ended');
  assert.ok(after.minutes > 0);
});

// Owner, 2026-11-11: "playing guitar in the background kind of low, just putting together songs and rhythms...
// we want it at like 10%." Guitar, a rhythm style under the progression, the call's level down to 10% while it
// plays and back after, and he's never cued to talk over it.
test('background guitar: quiet rhythm accompaniment at 10%, never talked over, the level back after', async () => {
  const { backing, BACKGROUND_LEVEL, lastPiece } = await import('./instrument-play.js');
  assert.equal(BACKGROUND_LEVEL, 0.1);
  assert.deepEqual(backing({ instrument: 'piano', tempo: 150, progression: 'I V vi IV', style: 'rock' }),
    { instrument: 'guitar', tempo: 110, progression: 'I V vi IV', style: 'strum' }, 'guitar, an easy tempo, a rhythm style');
  assert.equal(backing({ tempo: 70, progression: 'i VI', style: 'block' }, 'nylon').style, 'fingerpick');
  assert.equal(backing({ tempo: 90, progression: 'I IV', style: 'waltz' }).style, 'waltz', 'a rhythm style he chose stays');

  const said = [], levels = [], briefs = [];
  const session = { connection: {}, destroyed: false, pending: 0, speaking: false, announce: (cue) => said.push(cue),
    music: { queue: [], index: -1, on: false, volume: 0.6 }, musicResource: null,
    musicVolume() { return this.music.volume; },
    setMusicVolume(v) { this.music.volume = v; levels.push(v); return v; },
    playMusic(files, { append } = {}) { this.music.queue = append ? [...this.music.queue, ...files] : [...files]; if (!append) this.music.index = 0; this.music.on = true; this.musicResource = { playbackDuration: 0 }; } };
  const { sessions } = await import('./voice/session.js');
  sessions.set('bg', session);
  setComposer(async (p) => { briefs.push(p.briefNow); return { title: 'Porch Light', instrument: 'piano', tempo: 140, key: 'G major', meter: 4, progression: 'I V vi IV | I V IV I', style: 'rock', melody: '', why: '' }; });
  const r = await play({ minutes: 0.3 }, { outLoud: true, background: true });
  assert.deepEqual({ background: r.background, instrument: r.instrument, level: r.level, tempo: r.tempo }, { background: true, instrument: 'guitar', level: 0.1, tempo: 110 });
  assert.equal(session.music.volume, 0.1, 'the call is at 10% while he plays');
  assert.match(briefs[0], /quiet rhythm guitar in the background/);
  assert.equal(lastPiece().background, true);
  for (let guard = 0; guard < 2000 && playing(); guard++) {
    await new Promise((res) => setTimeout(res, 10));
    if (!session.musicResource) continue;
    session.musicResource.playbackDuration += 1000;
    if (session.musicResource.playbackDuration >= 18000 && session.music.index < session.music.queue.length - 1) { session.music.index++; session.musicResource.playbackDuration = 0; }
    if (session.musicResource.playbackDuration >= 18000) stop();
  }
  await r.done;
  sessions.delete('bg');
  assert.deepEqual(said, [], 'never cued to talk about it');
  assert.equal(session.music.volume, 0.6, 'the volume goes back to where it was');
  assert.deepEqual(levels, [0.1, 0.6]);

  // Turned up meanwhile: whoever set it wins, and it stays where they put it.
  sessions.set('bg', session); levels.length = 0;
  const r2 = await play({ minutes: 0.05 }, { outLoud: true, background: true, level: 0.2 });
  assert.equal(session.music.volume, 0.2, 'a level of its own when asked');
  session.music.volume = 0.35;
  stop(); await r2.done;
  sessions.delete('bg');
  assert.equal(session.music.volume, 0.35);
  setComposer(async (p) => ({ title: 'Long Night', instrument: 'piano', tempo: 120, notes: 'A4 C5 E5 A4 [A3 C4 E4]:2 r A4 E5:2', why: 'to settle' }));
});

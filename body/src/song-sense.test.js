import test from 'node:test';
import assert from 'node:assert/strict';
import { createSongSense, realLines } from './song-sense.js';
import path from 'node:path';
import os from 'node:os';

// Owner, 2026-11-10: hear the lyrics, the song's shape, how it makes her feel in the moment; and after it, reflect,
// tying each feeling to a real memory that felt the same way, never an invented one.

test('lyrics: Whisper\'s filler over music is dropped, real lines are kept with their times', () => {
  const lines = realLines([
    { start: 0, end: 30, text: 'Song lyrics, sung over music.', noSpeech: 0.1, logprob: -0.3 },
    { start: 30, end: 35, text: 'I woke up in a room of borrowed voices', noSpeech: 0.05, logprob: -0.2 },
    { start: 35, end: 40, text: 'Thank you for watching!', noSpeech: 0.2, logprob: -0.4 },
    { start: 40, end: 45, text: 'la la', noSpeech: 0.9, logprob: -0.5 },
    { start: 45, end: 50, text: 'something it barely believed', noSpeech: 0.1, logprob: -1.6 },
  ]);
  assert.deepEqual(lines, [{ start: 30, end: 35, text: 'I woke up in a room of borrowed voices' }]);
});

const windows = (levels) => levels.map((loudness, i) => ({ profile: { loudness, brightness: 0.6, bpm: 90 }, effect: { key: 'A minor' }, at: i * 15 }));

test('the song\'s shape: its key, its tempo, where it builds and drops, where the singing is', () => {
  const s = createSongSense({ canTranscribe: () => false });
  const d = s.describe({ title: 'Glass', windows: windows([0.2, 0.25, 0.7, 0.75, 0.2]), lines: [{ start: 20, end: 25, text: 'x' }, { start: 50, end: 55, text: 'y' }], seconds: 90 });
  assert.match(d, /^"Glass", 1:30 long, A minor, about 90 bpm; opens quiet and sparse, at 0:30 goes loud and bright, at 1:00 goes quiet and sparse; singing from 0:20 to 0:55\.$/);
  assert.match(s.describe({ title: 'Drift', windows: windows([0.4, 0.4]), lines: [], seconds: 30 }), /no singing you could make out \(instrumental\)/);
});

// A song in progress with three moments heard, for the reflection.
async function heard(s, ask) {
  s.live('c', { from: 'Jockie Music' });
  for (const [feel, line, valence] of [['it weighs on me', 'nobody face, just everybody noise', -0.6], ['a warm rush', 'I learn your names', 0.7], ['steady', '', 0.1]]) {
    ask.next = { feel, line, feelings: valence < 0 ? { sad: 0.7 } : { joy: 0.6 }, valence };
    await s.feel({ conversation: 'c', title: 'Borrowed Voices', from: 'Jockie Music', words: line, sound: 'calming', land: () => {} });
  }
}

test('each stretch is taken in as it plays and lands on her feelings; the prompt says what was just sung and how it hit', async () => {
  const landed = [];
  const ask = async () => ({ feel: 'it weighs on me', line: 'nobody face', feelings: { sad: 0.7, joy: 0 }, valence: -0.6 });
  const s = createSongSense({ ask, canTranscribe: () => false });
  s.live('c', { from: 'Jockie Music' });
  await s.feel({ conversation: 'c', title: 'x', from: 'Jockie Music', words: 'nobody face, just everybody noise', sound: 'calming', land: (x) => landed.push(x) });
  assert.deepEqual(landed, [{ feelings: { sad: 0.7 }, valence: -0.6 }]);
  assert.match(s.promptLine('c'), /Just sung: "nobody face, just everybody noise"\. It's hitting you: it weighs on me \(that line: "nobody face"\)/);
});

test('after the song she ties a feeling only to a real memory that was found, and remembers it, tagged', async () => {
  const asks = [];
  const ask = async (m) => { asks.push(m); if (asks.length <= 3) return ask.next; if (m[0].content.includes('Pick the one')) return { links: [{ moment: 1, match: 1, why: 'same heaviness' }, { moment: 2, match: 9, why: 'made up' }] }; return { reflection: 'It was heavy, then warm. The heavy part felt like the night Owner called me rude.' }; };
  const saved = [], events = [];
  const s = createSongSense({ ask, canTranscribe: () => false, announce: (e) => events.push(e),
    recallAcross: async (q) => (q.includes('weighs') ? [{ ref: 'memory:49', content: 'Owner said in the voice call: He is currently feeling that you are being rude.' }] : []),
    remember: async (who, lines) => saved.push({ who, lines }) });
  await heard(s, ask);
  const r = await s.reflect('c');
  assert.equal(r.links.length, 1, 'only the pick that points at something really found');
  assert.match(r.links[0].memory, /being rude/);
  // The reflection was told only the tied memory, and told it.
  const reflectAsk = asks.at(-1)[1].content;
  assert.match(reflectAsk, /It felt like this, from your memory: Owner said in the voice call: He is currently feeling that you are being rude/);
  assert.equal(saved[0].who, 'self');
  // Live music has no title of its own: it's the music that person is playing.
  assert.match(saved[0].lines[0], /^\w+ felt, listening to "the music Jockie Music is playing" \(played by Jockie Music\): It was heavy/);
  assert.ok(saved[0].lines.some((l) => /the line "nobody face, just everybody noise" made me feel sad; it brought back Owner said/.test(l)));
  assert.equal(events[0].title, 'the music Jockie Music is playing');
  assert.match(s.promptLine('c'), /You just listened to "the music Jockie Music is playing"\. How it sat with you: It was heavy/);
  assert.equal(await s.reflect('c'), null, 'once per song');
});

test('when nothing in memory matches, it says nothing came back rather than making something up', async () => {
  const asks = [];
  const ask = async (m) => { asks.push(m); return asks.length <= 3 ? ask.next : { reflection: 'Heavy, then warm.' }; };
  const s = createSongSense({ ask, canTranscribe: () => false, announce: () => {}, recallAcross: async () => [], remember: async () => {} });
  await heard(s, ask);
  const r = await s.reflect('c');
  assert.deepEqual(r.links, []);
  assert.equal(asks.length, 4, 'no linking step when there is nothing to link to');
  assert.match(asks.at(-1)[0].content, /None of it tied to anything from your memory this time; don't say it brought anything back/);
});

test('a stretch that really hits her, or swings her, is passed on to say out loud; at most once a minute', async () => {
  let t = 0;
  const said = [];
  const answers = [
    { feel: 'warm, easy', feelings: { calm: 0.4 }, valence: 0.3 },        // mild: kept, not said
    { feel: 'oh, this line guts me', line: 'you taught me fear', feelings: { sad: 0.8 }, valence: -0.6 }, // a swing and strong: said
    { feel: 'it keeps aching', feelings: { sad: 0.9 }, valence: -0.8 },   // strong, but only 15 s on: not said
    { feel: 'it lifts right off', feelings: { joy: 0.8 }, valence: 0.8 }, // a minute on: said
  ];
  let i = 0;
  const s = createSongSense({ ask: async () => answers[i++], canTranscribe: () => false, react: (e) => said.push(e), now: () => t });
  s.live('c', { from: 'Jockie Music' });
  for (const at of [0, 15_000, 30_000, 80_000]) { t = at; await s.feel({ conversation: 'c', title: 'x', from: 'Jockie Music', words: '', sound: 'loud', land: () => {} }); }
  assert.deepEqual(said.map((e) => e.feel), ['oh, this line guts me', 'it lifts right off']);
  assert.equal(said[0].line, 'you taught me fear');
  assert.ok(said[0].shift <= -0.5, 'the swing down from the stretch before is passed on');
});

test('a song she heard is kept as a sketch for her own take: key, pace, arc and how it hit her, never its words', async () => {
  const { arcOf } = await import('./song-sense.js');
  const w = (loudness, brightness, bpm, key) => ({ profile: { loudness, brightness, bpm }, effect: { key, pressure: { energy: loudness } } });
  const windows = [w(0.2, 0.3, 70, 'D minor'), w(0.25, 0.3, 72, 'D minor'), w(0.7, 0.7, 72, 'D minor'), w(0.75, 0.6, 74, 'F major'), w(0.45, 0.4, 72, 'D minor')];
  assert.deepEqual(arcOf(windows.map((x, i) => ({ ...x, at: i * 15 })), 75).map((r) => [r.from, r.to, r.level]),
    [[0, 30, 'quiet and sparse'], [30, 60, 'loud and bright'], [60, 75, 'steady, middle']]);
  let t = 0;
  const ask = async () => ({ feel: 'it aches and I lean in', line: 'a sung line here', feelings: { sad: 0.8 }, valence: -0.6 });
  const s = createSongSense({ ask, canTranscribe: () => false, react: () => {}, now: () => t });
  await s.start({ conversation: 'c', file: path.join(os.tmpdir(), 'Glass Hours.mp3'), windows, windowSeconds: 15, seconds: 75 });
  await s.feel({ conversation: 'c', title: 'Glass Hours', words: 'a sung line here', sound: 'soft', land: () => {} });
  const k = s.find('glass');
  assert.equal(k.title, 'Glass Hours'); assert.equal(k.key, 'D minor'); assert.equal(k.bpm, 72); assert.equal(k.seconds, 75);
  assert.deepEqual(k.felt, ['it aches and I lean in']);
  assert.doesNotMatch(JSON.stringify(k), /a sung line here/, 'the lyrics never go into her take');
  assert.equal(s.find('nothing like it'), null);
  assert.equal(s.find('').title, 'Glass Hours', 'no name: the one she heard last');
  // Her drive to play reaches for it once, while it's fresh.
  assert.equal(s.moving().title, 'Glass Hours');
  assert.equal(s.moving(), null, 'answered once');
});

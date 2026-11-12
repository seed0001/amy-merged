import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { search, lookup, resolve, wear, takeOff, wornVoice, keep, history, brief, tagVocabulary, voiceLine, noteSettings } from './library.js';
import { voiceIdFor } from './tone.js';

// Owner, 2026-11-09: she can look through Fish Audio's voice library with his key and switch voices on the fly.

const ID = 'a'.repeat(32), ID2 = 'b'.repeat(32);
const item = (id, title) => ({ _id: id, type: 'tts', title, description: `${title}, a test voice`, tags: ['female', 'british'], languages: ['en'], task_count: 1234, like_count: 5, author: { nickname: 'someone' }, samples: [{ audio: 'https://x/s.mp3' }] });

test('search asks Fish for the library with the key, and returns short readable voices', async () => {
  config.fish.apiKey = 'test-key';
  let seen;
  const fetchImpl = async (url, init) => { seen = { url: String(url), auth: init.headers.Authorization }; return new Response(JSON.stringify({ total: 2, items: [item(ID, 'Posh Lady'), item(ID2, 'Narrator')] })); };
  const { total, voices } = await search({ query: 'british woman', language: 'en', sort: 'popular', limit: 5 }, { fetchImpl });
  assert.equal(seen.auth, 'Bearer test-key');
  assert.match(seen.url, /^https:\/\/api\.fish\.audio\/model\?/);
  assert.match(seen.url, /title=british\+woman/);
  assert.match(seen.url, /sort_by=score/, 'words are searched by best match: Fish drops the words when sorting by use');
  assert.match(seen.url, /language=en/);
  assert.equal(total, 2);
  assert.deepEqual(voices[0], brief(item(ID, 'Posh Lady')));
  assert.equal(voices[0].uses, 1234);
});

// Owner, 2026-11-10: Owner liked the Australian voice she was wearing and said to keep it; she passed its name,
// the save failed, and a search by that name came back with Fish's popular voices instead.
test('the voice she means is found from what she is wearing, a name she saw, or Fish by exact name', async () => {
  config.fish.apiKey = 'test-key';
  const urls = [];
  const fetchImpl = async (u) => {
    const url = new URL(String(u)); urls.push(url);
    if (url.pathname.startsWith('/model/')) return new Response(JSON.stringify(item(url.pathname.slice(7), url.pathname.endsWith('c'.repeat(32)) ? 'Friendly Australian' : 'Other')));
    return new Response(JSON.stringify({ total: 2, items: [item('c'.repeat(32), 'Friendly Australian'), item('d'.repeat(32), 'Australian Narrator')] }));
  };
  wear('voice:keep', { id: 'c'.repeat(32), name: 'Friendly Australian', reason: 'test' });
  assert.equal((await resolve('', { conversation: 'voice:keep', fetchImpl })).id, 'c'.repeat(32), 'nothing named: the voice she is wearing');
  assert.equal((await resolve('friendly australian', { conversation: 'voice:keep', fetchImpl })).id, 'c'.repeat(32), 'its name: the one she is wearing');
  takeOff('voice:keep');
  urls.length = 0;
  assert.equal((await resolve('Australian Narrator', { conversation: 'voice:none', fetchImpl })).id, 'd'.repeat(32), 'a name not worn: Fish by exact name');
  assert.equal(urls[0].searchParams.get('sort_by'), 'score');
  await assert.rejects(resolve('Nobody By This Name', { fetchImpl }), /No voice called exactly "Nobody By This Name".*Australian Narrator \(id d{32}\)/);
  await assert.rejects(resolve('', { conversation: 'voice:none', fetchImpl }), /not wearing one here/);
});

test('several tags at once: each goes to Fish as its own filter, so a voice has to carry all of them', async () => {
  config.fish.apiKey = 'test-key';
  let url;
  await search({ tags: ['Female', 'whisper'], tag: 'breathy' }, { fetchImpl: async (u) => { url = new URL(String(u)); return new Response(JSON.stringify({ total: 0, items: [] })); } });
  assert.deepEqual(url.searchParams.getAll('tag'), ['female', 'whisper', 'breathy']);
});

test('the tag list counts which tags exist among the voices, leaving out the ones already chosen', async () => {
  config.fish.apiKey = 'test-key';
  const items = [{ ...item(ID, 'A'), tags: ['female', 'angry', 'dramatic'] }, { ...item(ID2, 'B'), tags: ['female', 'angry', 'deep'] }];
  const { looked_at, tags } = await tagVocabulary({ tags: ['female'] }, { fetchImpl: async () => new Response(JSON.stringify({ total: 2, items })) });
  assert.equal(looked_at, 2);
  assert.deepEqual(tags[0], { tag: 'angry', voices: 2 });
  assert.ok(!tags.some((t) => t.tag === 'female'));
});

test('failures say why: no key, a refused key, an ID that is not a voice', async () => {
  config.fish.apiKey = '';
  await assert.rejects(search({}, { fetchImpl: async () => new Response('{}') }), /no FISH_API_KEY/);
  config.fish.apiKey = 'test-key';
  await assert.rejects(search({}, { fetchImpl: async () => new Response('no', { status: 401 }) }), /refused the key/);
  await assert.rejects(lookup('not-an-id'), /isn't a Fish Audio voice ID/);
  await assert.rejects(lookup(ID, { fetchImpl: async () => new Response('', { status: 404 }) }), /no voice with that ID/);
});

// Owner, 2026-11-10: she wore a British voice he liked; 30 minutes later it silently ran out while he was in the
// shower, and nothing could say why. A worn voice stays until she takes it off, and every change is in her trail.
test('a worn voice stays until she takes it off, and every change is logged with who and why', () => {
  config.fish.voiceId = 'own-voice';
  const now = Date.now();
  wear('voice:g1', { id: ID, name: 'Megan', reason: 'Owner asked for a British accent', by: 'her, for Owner' }, now);
  assert.equal(voiceIdFor('voice:g1', config, now), ID);
  assert.equal(voiceIdFor('voice:g2', config, now), 'own-voice', 'another call is untouched');
  assert.equal(voiceIdFor('voice:g1', config, now + 6 * 3600_000), ID, 'hours later, still the voice she chose: no clock takes it off');
  assert.match(voiceLine('voice:g1'), /speaking in the voice "Megan".*Owner asked for a British accent/);
  const worn = history(1)[0];
  assert.equal(worn.what, 'wear'); assert.equal(worn.name, 'Megan'); assert.match(worn.reason, /British accent/); assert.equal(worn.by, 'her, for Owner');
  assert.equal(takeOff('voice:g1', { reason: 'Owner wanted her own voice back' }).name, 'Megan');
  assert.equal(voiceIdFor('voice:g1', config, now), 'own-voice');
  const off = history(1)[0];
  assert.equal(off.what, 'take off'); assert.equal(off.before_name, 'Megan'); assert.match(off.reason, /own voice back/);
  assert.match(voiceLine('voice:g1'), /regular voice.*take off/);
});

test('a dashboard save logs only the voice slots that actually changed, before and after', () => {
  const n = history(100).length;
  noteSettings({ fishVoiceId: 'a', fishWhisperVoiceId: 'w', ttsProvider: 'fish' }, { fishVoiceId: 'b', fishWhisperVoiceId: 'w', ttsProvider: 'fish' });
  const added = history(100).slice(n);
  assert.equal(added.length, 1);
  assert.deepEqual([added[0].what, added[0].slot, added[0].before, added[0].after, added[0].by], ['settings', 'regular', 'a', 'b', 'dashboard']);
});

test('keeping a voice saves it in its slot and records the old one, so it can be put back', () => {
  config.fish.whisperVoiceId = 'old-whisper';
  const e = keep('whisper', { id: ID2, name: 'Narrator', by: 'Owner', reason: 'test' });
  assert.equal(config.fish.whisperVoiceId, ID2);
  assert.equal(e.before, 'old-whisper');
  assert.equal(history().at(-1).after, ID2);
  assert.throws(() => keep('loud', { id: ID }), /Choose a slot/);
});

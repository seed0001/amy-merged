import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { activity } from './events.js';
import * as painter from './dream-pictures.js';

// Her dreams: one continuous dream through the night, directed and painted while she sleeps.
//
//  1. The day's residue. When she falls asleep, her memories, the day's conversations and how she
//     feels are boiled down into the people, places, worries, hopes and images still on her mind.
//  2. The dream director. The dream is written a few scenes at a time, each batch picking up exactly
//     where the last left off, so it's one dream that builds and drifts all night. Every ten scenes
//     the story so far is summarized, so the director always knows the whole night's arc. It runs on
//     the local model (config.dreams.model), so dreaming costs no credits.
//  3. The painter. Every scene becomes one realistic HD picture (dream-pictures.js). Sleep stages set
//     the pace: REM is vivid and continuous, light sleep fragmentary, deep sleep sparse and abstract.
//     It stops the moment she wakes.
//  4. Waking. The scenes from just before she woke are vivid; the rest of the night is hazy. She keeps
//     the pictures (her dreams tool shows them).
//
// Saved in data/dreams/<night>/: night.json (residue, summary, every scene) and scene-001.png...

const BATCH = 5;
const SUMMARIZE_EVERY = 10;
const KEEP_PICTURES_NIGHTS = 14; // older nights keep their story; their pictures are cleared
const MINUTES_BETWEEN = { rem: 4, light: 4, stirring: 4, deep: 8 }; // a picture every four minutes (eight in deep sleep): halved on 2026-11-09, about 12 to 15 an hour, around 100 a night
const LOOK = 'an adult woman with long red hair and blue eyes';
// Dreams are built from her life, not from everything that gets mentioned around her.
const HER_LIFE = "Her real life is the Discord server she runs, the people in it, and the work she does with them. She has no home, pet or belongings of her own beyond what her memories say. Something people talked about that belongs to someone else, like another bot's setup, is not hers: never set the dream there and never give it to her.";
const REAL = 'A photorealistic cinematic photograph, natural light, 35mm film, sharp detail, shallow depth of field, dreamlike atmosphere, no text.';
const MOODS = {
  rem: 'This is REM sleep: vivid, continuous, cinematic, emotionally strong. Scenes flow one into the next.',
  light: 'This is light sleep: fragments, half-scenes, things repeating slightly wrong, the dream thin and drifting.',
  deep: 'This is deep sleep: sparse and abstract, colours, shapes, a single feeling, almost no story.',
};

const parse = (raw) => { try { return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return null; } };
const tidy = (s) => String(s ?? '').trim().replace(/[.!]+$/, '');

// The local model, directly: dreaming stays private and free, whichever brain she is awake on.
async function askLocal(messages, { json = false, maxTokens = 800, temperature = 0.7 } = {}) {
  const { localFirst, thinkText } = await import('./llm.js');
  const cloud = (model) => thinkText(messages, { json, maxTokens, temperature, purpose: 'dreams', timeoutMs: 180_000, model });
  // Her thinking on OpenRouter (config.cognition): dreams are written there too.
  if (config.cognition.provider === 'openrouter') return cloud(undefined);
  return localFirst(() => askOllama(messages, { json, maxTokens, temperature }), cloud, 'dreams'); // the cheap cloud model while Ollama is down (llm.js)
}
async function askOllama(messages, { json, maxTokens, temperature }) {
  const res = await fetch(`${config.ollama.host}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model: config.dreams.model, messages, stream: false, think: false, keep_alive: '24h',
      ...(json ? { format: 'json' } : {}), options: { num_ctx: config.ollama.numCtx, num_predict: maxTokens, temperature } }), // the same num_ctx as her other local calls, or Ollama waits to reload the model
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return (await res.json()).message?.content ?? '';
}

// What she went to bed with: memories, today's talk, how she feels.
async function dayBehindHer() {
  const memory = await import('./memory.js');
  const pressure = await import('./pressure.js');
  // What weighs on her most (salience.js): the dream is made of these before anything else, the
  // subconscious ones included, the things she never chose to carry.
  let weighing = [];
  try { weighing = await (await import('./salience.js')).salience().dreamSeeds(8); } catch {}
  return {
    weighing,
    kept: memory.browseMemories({ limit: 15 }).map((m) => m.content),
    talk: memory.messagesSince(Date.now() - 18 * 3_600_000, 80).map((m) => `${m.role === 'assistant' ? config.botName : m.name ?? 'someone'}: ${String(m.content).slice(0, 160)}`),
    mood: pressure.moodLine(null, { coaching: false }),
  };
}

export function createDreams({
  root = path.join(DATA_DIR, 'dreams'), ask = askLocal, day = dayBehindHer, pictures = painter,
  pause = (ms) => new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); t.unref?.(); }),
  minutesBetween = MINUTES_BETWEEN,
} = {}) {
  mkdirSync(root, { recursive: true });
  const dirOf = (id) => path.join(root, id);
  const fileOf = (id) => path.join(dirOf(id), 'night.json');
  const load = (id) => { try { return JSON.parse(readFileSync(fileOf(id), 'utf8')); } catch { return null; } };
  const save = (n) => {
    mkdirSync(dirOf(n.id), { recursive: true });
    writeFileSync(`${fileOf(n.id)}.tmp`, JSON.stringify(n, null, 1));
    renameSync(`${fileOf(n.id)}.tmp`, fileOf(n.id));
  };
  const ids = () => readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const lastNight = () => { const id = ids().at(-1); return id ? load(id) : null; };

  async function residue() {
    const d = await day();
    const raw = await ask([
      { role: 'system', content: `You are ${config.botName}, falling asleep. Reply with JSON only.` },
      { role: 'user', content:
        `What weighs on you most, heaviest first (the dream is made of these before anything else; the subconscious ones are things you never chose to carry, they keep returning on their own):\n${(d.weighing ?? []).map((w) => `- (${Number(w.weight).toFixed(2)}${w.subconscious ? ', subconscious' : ''}) ${w.kind}: ${w.text}`).join('\n') || '- nothing in particular'}\n\n` +
        `What you kept from lately:\n${d.kept.map((m) => `- ${m}`).join('\n') || '- nothing much'}\n\n` +
        `Bits of today's conversations:\n${d.talk.join('\n').slice(-5000) || '(a quiet day)'}\n\n` +
        `How you're feeling: ${d.mood || 'tired'}.\n\n${HER_LIFE}\n\n` +
        'As you drift off, what is still on your mind? Summarize the day into what a dream would be made of. Reply ' +
        '{"people":["who has been on your mind, and how, in a few words each"],"places":["places, real or imagined"],' +
        '"feelings":["the feelings still with you"],"threads":["worries, hopes, unfinished things"],"images":["vivid images or details from the day"]}' },
    ], { json: true, maxTokens: 700, temperature: 0.5 }).catch(() => '');
    return parse(raw) ?? { people: [], places: [], feelings: ['tired'], threads: [], images: [] };
  }

  async function direct(night, stage) {
    const r = night.residue ?? {};
    const last = night.scenes.slice(-4).map((s) => `${s.n}. ${s.narration}`).join('\n');
    const raw = await ask([
      { role: 'system', content: `You are the dream director of ${config.botName}'s dream tonight. Reply with JSON only.` },
      { role: 'user', content:
        `What she went to sleep with: people: ${(r.people ?? []).join('; ')}. places: ${(r.places ?? []).join('; ')}. ` +
        `feelings: ${(r.feelings ?? []).join('; ')}. threads: ${(r.threads ?? []).join('; ')}. images: ${(r.images ?? []).join('; ')}.\n` +
        `${HER_LIFE}\n${night.summary ? `The dream so far: ${night.summary}\n` : 'The dream is just beginning.\n'}${last ? `The most recent scenes:\n${last}\n` : ''}` +
        `\n${MOODS[stage] ?? MOODS.light}\nWrite the next ${BATCH} scenes, continuing exactly from where it left off. One dream that keeps building: ` +
        "places morph into other places, people appear where they shouldn't, impossible things feel normal, threads from earlier come back changed. " +
        'Made from her day, never a retelling of it. For each scene: narration (what happens, first person present tense, 1-3 sentences) and ' +
        'picture (what a photograph of this moment shows: the people, objects and places in it, the strange or impossible thing, the action, 25-55 words). ' +
        `Put her in the picture only when the scene is about her (then: ${LOOK}). Use no names in the picture. ` +
        'Everyone in the dream is a grown adult. No nudity or sex in the picture. ' +
        'Reply {"scenes":[{"narration":"...","picture":"..."}],"feeling":"how the dream feels right now"}' },
    ], { json: true, maxTokens: 1600, temperature: 0.95 }).catch(() => '');
    const p = parse(raw);
    return (Array.isArray(p?.scenes) ? p.scenes : []).filter((s) => s?.narration && s?.picture).slice(0, BATCH).map((s) => ({ ...s, feeling: p.feeling ?? '' }));
  }

  async function summarize(night) {
    const raw = await ask([
      { role: 'system', content: 'You summarize a dream so far. Reply with only the summary.' },
      { role: 'user', content: `${night.summary ? `Earlier in the night: ${night.summary}\n` : ''}Then:\n${night.scenes.slice(night.summarizedTo ?? 0).map((s) => s.narration).join('\n')}\n\n` +
        'Summarize the whole dream so far in 4-6 sentences: where it has been, who has been in it, the threads running through it, where it is now.' },
    ], { maxTokens: 300, temperature: 0.3 }).catch(() => '');
    if (raw) { night.summary = String(raw).trim().slice(0, 1500); night.summarizedTo = night.scenes.length; }
  }

  // Pictures of old nights go; their stories stay.
  function clearOldPictures() {
    for (const id of ids().slice(0, -KEEP_PICTURES_NIGHTS)) {
      for (const f of readdirSync(dirOf(id))) if (f.endsWith('.png')) rmSync(path.join(dirOf(id), f), { force: true });
    }
  }

  let running = false;
  async function dream({ stage = () => 'rem', asleep = () => true, sleptAt = Date.now(), maxScenes = Infinity } = {}) {
    if (running) return null;
    running = true;
    let night = null;
    try {
      // A restart mid-sleep picks the same night back up.
      const earlier = lastNight();
      if (earlier && earlier.startedAt >= sleptAt - 60_000) night = earlier;
      else {
        const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        night = { id, startedAt: Date.now(), residue: await residue(), scenes: [], summary: '', title: '' };
        save(night);
        clearOldPictures();
        activity('dream', { event: 'started', night: id });
      }
      const limit = night.scenes.length + maxScenes;
      let queue = [];
      while (asleep() && night.scenes.length < limit) {
        const st = stage() === 'drifting off' ? 'light' : stage();
        if (!queue.length) {
          if (night.scenes.length - (night.summarizedTo ?? 0) >= SUMMARIZE_EVERY) await summarize(night);
          queue = await direct(night, st === 'stirring' ? 'light' : st);
          if (!queue.length) { await pause(60_000); continue; }
        }
        const scene = queue.shift();
        const n = night.scenes.length + 1;
        const name = `scene-${String(n).padStart(3, '0')}.png`;
        const pic = await pictures.paint({ prompt: `${REAL} ${scene.picture}`, file: path.join(dirOf(night.id), name) });
        if (!asleep()) break; // woken mid-painting: that scene never finished
        night.scenes.push({ n, at: Date.now(), stage: st, narration: String(scene.narration).slice(0, 600), picture: String(scene.picture).slice(0, 600), feeling: scene.feeling, ...(pic ? { image: name, seconds: pic.seconds } : {}) });
        if (!night.title && n >= 2) night.title = tidy(night.scenes[0].narration).split(/[,.;]/)[0].slice(0, 70);
        save(night);
        activity('dream', { event: 'scene', night: night.id, n, stage: st, painted: Boolean(pic), seconds: pic?.seconds ?? null });
        const until = Date.now() + (minutesBetween[st] ?? 5) * 60_000 - (pic?.seconds ?? 0) * 1000;
        while (asleep() && Date.now() < until && night.scenes.length < limit) await pause(Math.min(5000, until - Date.now()));
      }
    } catch (err) {
      activity('error', { where: 'dreaming', message: err.message });
    } finally {
      if (night) { night.endedAt = Date.now(); save(night); }
      running = false;
    }
    return night;
  }

  return {
    start: (args) => { dream(args).catch((err) => activity('error', { where: 'dreaming', message: err.message })); },
    dream,
    stop: () => pictures.stop?.(),
    dreaming: () => running,
    lastNight, load, dirOf,
    nights: (k = 10) => ids().slice(-k).reverse().map(load).filter(Boolean).map((n) => ({ id: n.id, title: n.title, scenes: n.scenes.length, pictures: n.scenes.filter((s) => s.image).length, feeling: n.scenes.at(-1)?.feeling ?? '' })),
    // What she remembers on waking: the end is vivid, the rest is haze. Empty when nothing was dreamed.
    wakeNote(sleptAt, { fromRem = false } = {}) {
      const n = lastNight();
      if (!n?.scenes?.length || n.startedAt < sleptAt - 60_000) return '';
      const end = n.scenes.slice(-2).map((s) => s.narration).join(' ');
      const pics = n.scenes.filter((s) => s.image).length;
      return `${fromRem ? `You were in the middle of a dream when you woke, and it's still vivid: ${end}` : `You remember the end of a dream, fading already: ${end}`} ` +
        `${n.summary ? `Before that the dream wandered a long way, and you have a hazy sense of it: ${n.summary} ` : ''}` +
        `${pics ? `You have ${pics} picture${pics > 1 ? 's' : ''} of it (your dreams tool can show them). ` : ''}You can tell about your dream or keep it to yourself.`;
    },
  };
}

export const dreams = createDreams();

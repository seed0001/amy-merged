import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { normalizeFeeds } from './rss.js';
import { parsePeerApps } from './peer-apps.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CHAMP_DATA_DIR: somewhere else (the test runner uses a throwaway folder, scripts/test-env.mjs).
export const DATA_DIR = process.env.CHAMP_DATA_DIR || path.join(ROOT, 'data');
// A test run without its throwaway data folder would write into the live bot's database, logs and
// pressure state (it happened: 2026-11-09 00:50, six fake tool failures in her log and a corrupted
// pressure-state.json). Tests run through `npm test` (which loads scripts/test-env.mjs) or not at all.
if ((process.execArgv.includes('--test') || process.env.NODE_TEST_CONTEXT) && !process.env.CHAMP_DATA_DIR) {
  throw new Error('Refusing to run tests against the live data folder. Run them with: node --import ./scripts/test-env.mjs --test <files> (or npm test).');
}
mkdirSync(DATA_DIR, { recursive: true });

const env = process.env;
const fluxRuntime = env.FLUX_RUNTIME_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'NewChamp', 'Flux');
const xttsRuntime = env.XTTS_RUNTIME_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'NewChamp', 'XTTS');
const parakeetRuntime = env.PARAKEET_RUNTIME_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'NewChamp', 'Parakeet');
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
// A list of words or short phrases: comma or new-line separated text, or an array. Lowercase, no repeats, at most 10.
// The companion's own first name and possessive, for what it names or writes after itself: project folders and pages,
// commits, briefs to coders, sign-in pages. From its settings, never a fixed name (owner, 2026-11-11: "Why are all the
// pages he's creating saying Amy? That should have been removed from the code base." James, a copy of Amy, built
// "Amy <topic>" apps in Desktop\Amy Projects because these were written in as "Amy").
// A shared resource that lives beside the bots (another bot's folder, a shared tool): the first match walking up from
// this bot's parent folder, three levels at most, or null. Bots sit at different depths (C:\Bots\x, C:\Bots\the crew\x).
export function upFind(relative) {
  let dir = path.resolve(ROOT, '..');
  for (let i = 0; i < 3; i++) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export const selfName = () => String(config.botName || '').trim().split(/\s+/)[0] || 'Companion';
export const selfHis = () => (config.botGender === 'male' ? 'his' : config.botGender === 'female' ? 'her' : 'their');

export function wordList(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
  const words = items.map((w) => String(w).trim().toLowerCase().replace(/\s+/g, ' ')).filter((w) => w.length >= 2 && w.length <= 40);
  return [...new Set(words)].slice(0, 10);
}

const personaPath = path.join(ROOT, 'persona.md');
const settingsPath = path.join(DATA_DIR, 'settings.json');
// A full reset waiting to run (memory-wipe.js, its marker file): this start is a fresh her. Config is read
// before the wipe moves anything, so without this the first start after a full reset would still run on the old
// persona, name and wake words until the next restart (owner, 2026-11-09: a full reset is back to zero for who
// she is; her voice, brain and the rest of how she's installed are kept).
const fullResetPending = (() => { try { return JSON.parse(readFileSync(path.join(DATA_DIR, 'wipe-memory.json'), 'utf8')).full === true; } catch { return false; } })();

export const config = {
  discordToken: env.DISCORD_TOKEN,
  clientId: env.CLIENT_ID,
  guildId: env.GUILD_ID,

  botName: env.BOT_NAME || 'Champ',
  // Who the companion is, for the few places that need it (owner, 2026-11-11: James, a copy of Amy, read "she/her" all
  // through his instructions and picked four female voices for himself). "male" or "female"; empty says nothing.
  botGender: (env.BOT_GENDER || '').toLowerCase(),
  // On/off switch from the dashboard; remembered across restarts.
  botEnabled: true,
  persona: !fullResetPending && existsSync(personaPath) ? readFileSync(personaPath, 'utf8').trim() : '',
  // Lets people reshape the bot's persona just by asking in conversation.
  personaSelfEdit: bool(env.PERSONA_SELF_EDIT, true),
  // Discord user IDs of the owner: always top access, and the only one who can set contacts' tiers.
  ownerIds: list(env.OWNER_IDS),
  // The owner's other Discord accounts that are not people: the desktop account that streams her
  // browser into the call ("Amy Smith"). Never counted as someone in the room, never spoken to.
  ownerAltIds: list(env.OWNER_ALT_ACCOUNT_IDS),
  // Channels where the bot replies to every message (it always replies to DMs and @mentions).
  chatChannelIds: list(env.CHAT_CHANNEL_IDS),
  // Other AI companions in the server he listens to and talks with (Discord user IDs or names).
  peerBots: list(env.PEER_BOTS),
  peerUnlimited: list(env.PEER_UNLIMITED), // peers answered without the turns-in-a-row limit (peers.js)
  // The other companions' folders and dashboard ports, so she can start them and bring them into a
  // call (peer-apps.js): "Alex=C:\...\Alex@3001,Howard|Gramps=C:\...\Gramps@3002".
  peerApps: parsePeerApps(env.PEER_APPS),
  historyLimit: num(env.HISTORY_LIMIT, 100),

  ollama: {
    host: env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: env.OLLAMA_MODEL || 'gemma4:12b',
    codingModel: env.OLLAMA_CODING_MODEL || '',
    codingNumCtx: num(env.OLLAMA_CODING_NUM_CTX, 8192),
    embedModel: env.OLLAMA_EMBED_MODEL || 'bge-m3',
    think: bool(env.OLLAMA_THINK, false),
    // Context window in tokens. Ollama defaults to 4096, which silently cuts off long histories.
    numCtx: num(env.OLLAMA_NUM_CTX, 32768),
  },

  // Her thinking, everything that isn't a reply: memory, intuition, pressure, reflection, composing, dreams,
  // background jobs. 'openrouter' runs it on OpenRouter with `model`; 'ollama' runs it on the local model above.
  // Owner, 2026-11-10: "where the local model was, we're putting OpenRouter… Grok 4.20. Make it configurable,
  // but that's the default." Embeddings stay local (bge-m3 on the CPU); OpenRouter doesn't do them.
  cognition: {
    provider: (env.COGNITION || 'openrouter').toLowerCase(),
    model: env.COGNITION_MODEL || 'x-ai/grok-4.20',
    // How hard it thinks first: none (fastest, the default for these short jobs), low, medium or high.
    reasoning: (env.COGNITION_REASONING || 'none').toLowerCase(),
    // When thinking is local and the local model isn't answering (Ollama stopped or crashed), the same calls go to this
    // cheap OpenRouter model until it's back (llm.js localFirst). "off" means no fallback: they fail and say why.
    // Owner, 2026-11-11, after Ollama quit at 10:51 PM and every background job failed for 40 minutes.
    fallbackModel: env.COGNITION_FALLBACK_MODEL || 'deepseek/deepseek-v4.1-flash-1017',
  },

  // Her intuition: the local model that reads every line on the server (intuition.js).
  intuition: { model: env.INTUITION_MODEL || 'joe-speedboat/Gemma-4-Uncensored-HauhauCS-Aggressive:e4b' },

  // Her dreams: written by a local model and painted with Z-Image from this imagegen folder.
  dreams: {
    model: env.DREAM_MODEL || 'joe-speedboat/Gemma-4-Uncensored-HauhauCS-Aggressive:e4b',
    // The shared Amy-Voice image generator, found by walking up from this bot's folder: one level up for a bot in
    // C:\Bots, two for one in C:\Bots\the crew (it looked only one level up, so James's dreams found nothing to paint with).
    imagegen: env.DREAM_IMAGEGEN_DIR || upFind(path.join('Amy-Voice', 'imagegen')) || path.resolve(ROOT, '..', 'Amy-Voice', 'imagegen'),
    width: num(env.DREAM_WIDTH, 1280),
    height: num(env.DREAM_HEIGHT, 720),
  },

  // Which brain writes the replies: 'ollama' (local), 'mistral' (Mistral's cloud), or 'openrouter' (cloud models, including big
  // reasoning ones). Her thinking (memory extraction and the rest) is `cognition` above; embeddings stay local.
  // 'amy' is no language model at all (owner, 2026-11-11: "get the LLM out and get her in control of everything"):
  // the Python Amy in ../brain understands the line, learns from it, reasons and words the reply (brain-client.js,
  // brain-reply.js), and every call to a text model is refused and logged (model-guard.js).
  brain: (env.BRAIN || 'ollama').toLowerCase(),
  // Where the Python brain lives and how it's started. db: her memory file, relative to the brain folder
  // (blank: the HALMINI_DB in the brain's own .env).
  amyBrain: {
    dir: env.AMY_BRAIN_DIR || path.resolve(ROOT, '..', 'brain'),
    python: env.AMY_BRAIN_PYTHON || 'python',
    db: env.AMY_BRAIN_DB || '',
  },
  providerFailover: true,
  turnClassifierEnabled: true,
  turnClassifierVoice: false, // also run it before spoken replies (slower; see companion.js)
  providerFailoverNarration: true,
  providerRetryMinutes: 15,
  // fastModel answers in voice and runs the quick behind-the-scenes calls (planner, mark scoring):
  // measured on her real prompt, gpt-6.1-terra started talking in ~2s vs ~6s for gpt-6.1-sol.
  // Text replies keep `model`. Blank = use `model` for everything.
  chatgpt: { model: env.CHATGPT_MODEL || '', fastModel: env.CHATGPT_FAST_MODEL ?? 'gpt-6.1-terra' },
  // Mistral's own cloud (https://console.mistral.ai/api-keys). The free Experiment plan is rate-limited
  // (about 1 request a second) with a large monthly token allowance.
  mistral: {
    apiKey: env.MISTRAL_API_KEY,
    model: env.MISTRAL_MODEL || 'mistral-large-latest',
  },
  // Her brain is split in two. Her voice (attitude, companionship, everything she says) is the brain
  // above. Her hands (actions.js) are a small instruction-following model with no persona that makes
  // every tool call: actions, research, files, the browser. ACTIONS=off gives the tools back to her voice.
  // Her workshop coding jobs run on OpenRouter with this model (project-coder.js).
  workshop: {
    coderModel: env.WORKSHOP_CODER_MODEL || 'anthropic/claude-sonnet-5.5',
  },
  actions: {
    enabled: !/^(off|false|0|no)$/i.test(env.ACTIONS || ''),
    model: env.ACTIONS_MODEL || 'openai/gpt-6-luna',
    reasoning: (env.ACTIONS_REASONING || 'low').toLowerCase(),
  },
  // OpenRouter (https://openrouter.ai/keys). Also powers image generation, whichever brain is on.
  openrouter: {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash-1017',
    // How hard reasoning models think before answering: none, low, medium or high.
    reasoning: (env.OPENROUTER_REASONING || 'medium').toLowerCase(),
    // Spoken replies: reasoning costs seconds before the first word, so it's off unless set.
    voiceReasoning: (env.OPENROUTER_VOICE_REASONING || 'none').toLowerCase(),
    imageModel: env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image',
    // Looks at pictures people send when her own model can't.
    visionModel: env.OPENROUTER_VISION_MODEL || 'google/gemini-3.8-flash',
    // Google Lyria 3 music: 30-second clips ($0.04 each) and full-length songs ($0.08 each).
    clipModel: env.OPENROUTER_CLIP_MODEL || 'google/lyria-3-clip-preview',
    songModel: env.OPENROUTER_SONG_MODEL || 'google/lyria-3-pro-preview',
  },

  memory: {
    topK: num(env.MEMORY_TOP_K, 6),
    minScore: num(env.MEMORY_MIN_SCORE, 0.35),
    dedupeScore: num(env.MEMORY_DEDUPE_SCORE, 0.9),
  },

  // Pictures: 'openrouter' (cloud, openrouter.imageModel), 'kontext' (FLUX.1 Kontext on this PC's
  // GPU through stable-diffusion.cpp/Vulkan) or 'flux' (FLUX.2 klein through PyTorch ROCm).
  imageProvider: env.IMAGE_PROVIDER || 'openrouter',
  kontext: {
    exe: env.KONTEXT_SD_EXE || path.join(os.homedir(), 'sd-cpp', 'sd-cli.exe'),
    model: env.KONTEXT_MODEL || path.join(os.homedir(), 'FLUX1-Kontext', 'flux1-kontext-dev-Q4_K_M.gguf'),
    vae: path.join(os.homedir(), 'FLUX1-Kontext', 'ae.safetensors'),
    clipL: path.join(os.homedir(), 'FLUX1-Kontext', 'clip_l.safetensors'),
    t5xxl: path.join(os.homedir(), 'FLUX1-Kontext', 't5xxl_fp8_e4m3fn.safetensors'),
    steps: num(env.KONTEXT_STEPS, 20),
    // The card to draw on, matched by name in sd-cli's device list (kontext.js); left to itself it can
    // land on the CPU's built-in graphics and crawl. {gpu} in backend becomes that device.
    // The text encoders (clip) run once per picture, so they go on the CPU and leave VRAM to Ollama.
    gpu: env.KONTEXT_GPU || 'RX 9070 XT',
    backend: env.KONTEXT_BACKEND || 'diffusion={gpu},vae={gpu},clip=cpu',
  },
  flux: {
    python: env.FLUX_PYTHON || path.join(fluxRuntime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    modelDir: env.FLUX_MODEL_DIR || path.join(os.homedir(), 'FLUX2-klein-4B'),
  },

  // Text-to-speech: 'fish' (Fish Audio, cloud), 'kokoro' (local, on this PC), 'xtts' (local clone) or
  // 'gtts' (Google Translate's voice through the gTTS Python package; free, online, no key).
  tts: env.TTS_PROVIDER || 'fish',
  gtts: {
    python: env.GTTS_PYTHON || 'python',
    lang: env.GTTS_LANG || 'en',
    tld: env.GTTS_TLD || 'com',
    slow: env.GTTS_SLOW === 'true',
  },
  kokoro: {
    voice: env.KOKORO_VOICE || 'af_heart',
    speed: num(env.KOKORO_SPEED, 1),
  },
  xtts: {
    python: env.XTTS_PYTHON || path.join(xttsRuntime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    modelDir: env.XTTS_MODEL_DIR || path.join(xttsRuntime, 'model'),
    referenceDir: path.join(DATA_DIR, 'voices', 'xtts'),
    reference: env.XTTS_REFERENCE || '',
    language: env.XTTS_LANGUAGE || 'en',
    speed: num(env.XTTS_SPEED, 1),
  },

  fish: {
    apiKey: env.FISH_API_KEY,
    voiceId: env.FISH_VOICE_ID,
    // Her second, stronger voice for serious moments in calls (voice/tone.js). Blank turns it off.
    strongVoiceId: env.FISH_STRONG_VOICE_ID || '',
    // Sensual and whisper voices she picks when the moment calls for them. Blank turns each off.
    sensualVoiceId: env.FISH_SENSUAL_VOICE_ID || '',
    whisperVoiceId: env.FISH_WHISPER_VOICE_ID || '',
    ttsModel: env.FISH_TTS_MODEL || 's2.1-pro',
    asrModel: env.FISH_ASR_MODEL || 'transcribe-1-pro',
    language: env.FISH_LANGUAGE || 'en',
  },

  // Web search (https://tavily.com). Leave the key blank to turn search off.
  tavily: {
    apiKey: env.TAVILY_API_KEY,
    depth: env.TAVILY_DEPTH || 'basic', // basic = 1 credit, advanced = 2
    maxResults: num(env.TAVILY_MAX_RESULTS, 5),
  },

  // Where he was torn (conflicts.js): his brain reports the top alternatives for every word, and close calls are kept.
  conflicts: {
    enabled: bool(env.CONFLICTS_ENABLED, true),
    top: Math.max(2, Math.min(20, num(env.CONFLICTS_TOP, 5))), // alternatives asked for per word
    autoBranch: bool(env.CONFLICTS_AUTO_BRANCH, true), // a near-tie gets its other branch written straight away
  },

  // RSS/Atom news feeds (feeds.js). Read when his world bucket fires (pressure.js), never on a clock, or when
  // someone asks (the news_feeds tool). The list is set by the owner through news_feeds or data/settings.json
  // ("rssFeeds": [{ "name", "url" }]).
  rss: {
    enabled: bool(env.RSS_ENABLED, true),
    feeds: [],
  },

  // Speech-to-text: 'groq' (Groq cloud Whisper, falls back to local), 'local' (Whisper on this PC),
  // or 'fish' (Fish Audio API, needs credit).
  stt: (env.STT_PROVIDER || 'local').toLowerCase(),
  parakeet: {
    python: env.PARAKEET_PYTHON || path.join(parakeetRuntime, 'venv', 'Scripts', 'python.exe'),
    modelDir: env.PARAKEET_MODEL_DIR || path.join(parakeetRuntime, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'),
    threads: Math.max(1, Math.min(16, Math.round(num(env.PARAKEET_THREADS, 4)))),
  },
  groq: {
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
  },
  whisper: {
    model: env.WHISPER_MODEL || 'Xenova/whisper-base.en',
    device: env.WHISPER_DEVICE || 'auto', // auto (GPU via DirectML, else CPU) | dml | cpu
  },

  voice: {
    // Voice channels the bot may join. Empty = any.
    channelIds: list(env.VOICE_CHANNEL_IDS),
    silenceMs: num(env.VOICE_SILENCE_MS, 800),
    minSpeechMs: num(env.VOICE_MIN_SPEECH_MS, 1200), // talk this long over her before she checks for a real interruption
    // ...and it only counts if that much speech transcribes to at least this many words.
    bargeInWords: num(env.VOICE_BARGE_IN_WORDS, 3),
    // Sounds shorter than this are ignored, so coughs and clicks don't become "thank you".
    minUtteranceMs: num(env.VOICE_MIN_UTTERANCE_MS, 1500),
    // A line said to her that trails off ("make them really", "um..."): how long the speaker gets to go on
    // before she answers it (voice/trailing.js). Speaking again within it joins the pieces into one line.
    thinkingPauseMs: num(env.VOICE_THINKING_PAUSE_MS, 2500),
    // Another companion pauses between its spoken sentences; she waits until it's been quiet this long
    // before answering it, so she answers its whole reply once instead of each piece.
    peerQuietMs: num(env.VOICE_PEER_QUIET_MS, 2000),
    bargeIn: bool(env.VOICE_BARGE_IN, true),
    postTranscripts: bool(env.VOICE_POST_TRANSCRIPTS, true),
    // When she joins a call, read the room and greet everyone by name, introducing herself to
    // people she hasn't met in voice yet. Off stays quiet on entry; newcomer introductions have their own switch.
    joinGreeting: bool(env.VOICE_JOIN_GREETING, true),
    autoSocial: bool(env.VOICE_AUTO_SOCIAL, true),
    newcomerIntroductions: bool(env.VOICE_NEWCOMER_INTRODUCTIONS, true),
    arrivalFollowups: bool(env.VOICE_ARRIVAL_FOLLOWUPS, true),
    reconnectAnnouncements: bool(env.VOICE_RECONNECT_ANNOUNCEMENTS, true),
    restartAnnouncements: bool(env.VOICE_RESTART_ANNOUNCEMENTS, true),
    taskProgress: bool(env.VOICE_TASK_PROGRESS, true),
    voiceLearned: bool(env.VOICE_LEARNED_ANNOUNCE, true),
    overheardTasks: bool(env.VOICE_OVERHEAR_TASKS, true),

    // Wake words (wake-words.js): words anyone can use, and the owner's own words that only work for
    // him. With both empty she answers everyone in voice; her name always works. Comma separated in .env.
    // None after a full reset, whatever .env says: the new user sets them up (onboarding.js, wake_words step).
    wakeWords: fullResetPending ? [] : wordList(env.VOICE_WAKE_WORD),
    ownerWakeWords: fullResetPending ? [] : wordList(env.VOICE_OWNER_WAKE_WORDS),
    // Free talk: answer voice lines without the wake word, taking turns with the other companions
    // (voice/floor.js): whoever was last talked to answers.
    freeTalk: bool(env.VOICE_FREE_TALK, false),
  },

  // Video replies: the recorder page (/avatar.html?recorder=1, opened in a hidden browser by the
  // bot when none is open) adds a clip of her face saying Discord text replies. AVATAR_VIDEO=off
  // switches the whole thing off.
  avatarVideo: !/^(off|false|0|no)$/i.test(env.AVATAR_VIDEO || ''),
  // Inner monologue: she thinks out loud (a short thought, said and shown) before she answers.
  innerMonologue: /^(on|true|1|yes)$/i.test(env.INNER_MONOLOGUE || ''),
  // Solo thoughts: a private thinking loop between conversations. Separate from innerMonologue.
  // On by default; empty thoughtChannelId means store privately and never post.
  soloMonologue: true,
  selfDialogueEnabled: true,
  selfDialogueProvider: 'auto',
  thoughtChannelId: String(env.THOUGHT_CHANNEL_ID || '').trim(),

  // The 3D avatar shown at /avatar.html.
  avatar: {
    path: env.AVATAR_PATH || path.join(DATA_DIR, 'avatar.glb'),
  },

  // The doctor's fallback coding agent, OpenCode. The path is auto-detected (desktop app's
  // bundled CLI, OPENCODE_PATH, or `opencode` on PATH); the model can be any model available on
  // the signed-in OpenCode account (see `opencode models`), left blank to use OpenCode's default.
  doctorOpenCode: {
    path: env.OPENCODE_PATH || '',
    model: env.OPENCODE_DOCTOR_MODEL || '',
  },

  dashboard: {
    port: num(env.DASHBOARD_PORT, 3000),
    host: env.DASHBOARD_HOST || '127.0.0.1',
    password: env.DASHBOARD_PASSWORD || '',
  },

  // The phone link (phone-link.js): Owner's Android app sends what his phone senses and chats with the companion.
  // Its own small server, separate from the dashboard (which stays on 127.0.0.1), so only this API is reachable
  // from the phone, and only from this computer or over Tailscale. Accounts: scripts/phone-account.mjs.
  phone: {
    enabled: bool(env.PHONE_ENABLED, true),
    port: num(env.PHONE_PORT, 3010),
    host: env.PHONE_HOST || '0.0.0.0',
  },
};

// Settings the dashboard can change at runtime. Saved to data/settings.json, which overrides .env.
// Each entry maps a flat settings key to [get, set] on the config object.
const EDITABLE = {
  sttProvider: [() => config.stt, (v) => {
    if (!['local', 'parakeet', 'groq', 'fish'].includes(v)) throw new Error('Unknown speech recognition provider');
    if (v === 'parakeet' && ![config.parakeet.python, ...['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].map(f => path.join(config.parakeet.modelDir, f))].every(existsSync)) throw new Error('Install local Parakeet first: run scripts/setup-parakeet.ps1');
    config.stt = v;
  }],
  botName: [() => config.botName, (v) => (config.botName = String(v).trim() || 'Champ')],
  botGender: [() => config.botGender, (v) => (config.botGender = ['male', 'female'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : '')],
  botEnabled: [() => config.botEnabled, (v) => (config.botEnabled = Boolean(v))],
  voiceChannelIds: [() => config.voice.channelIds, (v) => (config.voice.channelIds = Array.isArray(v) ? v.map(String) : list(v))],
  chatChannelIds: [() => config.chatChannelIds, (v) => (config.chatChannelIds = Array.isArray(v) ? v.map(String) : list(v))],
  historyLimit: [() => config.historyLimit, (v) => (config.historyLimit = Math.max(1, Math.min(500, Math.round(Number(v)) || 100)))],
  personaSelfEdit: [() => config.personaSelfEdit, (v) => (config.personaSelfEdit = Boolean(v))],
  ollamaModel: [() => config.ollama.model, (v) => (config.ollama.model = String(v))],
  ollamaCodingModel: [() => config.ollama.codingModel, (v) => (config.ollama.codingModel = String(v).trim())],
  ollamaThink: [() => config.ollama.think, (v) => (config.ollama.think = Boolean(v))],
  cognition: [() => config.cognition.provider, (v) => { if (!['openrouter', 'ollama'].includes(v)) throw new Error('Choose openrouter or ollama for her thinking'); config.cognition.provider = v; }],
  cognitionFallback: [() => config.cognition.fallbackModel, (v) => (config.cognition.fallbackModel = String(v ?? '').trim() || 'off')],
  cognitionModel: [() => config.cognition.model, (v) => (config.cognition.model = String(v ?? '').trim() || config.cognition.model)],
  cognitionReasoning: [() => config.cognition.reasoning, (v) => (config.cognition.reasoning = ['none', 'low', 'medium', 'high'].includes(v) ? v : 'none')],
  avatarVideo: [() => config.avatarVideo, (v) => (config.avatarVideo = Boolean(v))],
  innerMonologue: [() => config.innerMonologue, (v) => (config.innerMonologue = Boolean(v))],
  soloMonologue: [() => config.soloMonologue, (v) => (config.soloMonologue = Boolean(v))],
  selfDialogueEnabled: [() => config.selfDialogueEnabled, (v) => { if (typeof v !== 'boolean') throw new Error('selfDialogueEnabled must be boolean'); config.selfDialogueEnabled = v; }],
  selfDialogueProvider: [() => config.selfDialogueProvider, (v) => { if (!['auto', 'openrouter', 'chatgpt', 'mistral'].includes(v)) throw new Error('Choose auto, openrouter, chatgpt or mistral'); config.selfDialogueProvider = v; }],
  thoughtChannelId: [() => config.thoughtChannelId, (v) => (config.thoughtChannelId = String(v ?? '').trim())],
  brain: [() => config.brain, (v) => (config.brain = ['ollama', 'openrouter', 'chatgpt', 'mistral', 'amy'].includes(v) ? v : config.brain)],
  providerFailover: [() => config.providerFailover, (v) => (config.providerFailover = Boolean(v))],
  turnClassifierEnabled: [() => config.turnClassifierEnabled, (v) => { if (typeof v !== 'boolean') throw new Error('turnClassifierEnabled must be a boolean'); config.turnClassifierEnabled = v; }],
  turnClassifierVoice: [() => config.turnClassifierVoice, (v) => (config.turnClassifierVoice = Boolean(v))],
  providerFailoverNarration: [() => config.providerFailoverNarration, (v) => (config.providerFailoverNarration = Boolean(v))],
  providerRetryMinutes: [() => config.providerRetryMinutes, (v) => (config.providerRetryMinutes = Math.max(1, Math.min(1440, Number(v) || 15)))],
  chatgptFastModel: [() => config.chatgpt.fastModel, (v) => (config.chatgpt.fastModel = String(v ?? '').trim())],
  chatgptModel: [() => config.chatgpt.model, (v) => (config.chatgpt.model = String(v ?? '').trim())],
  mistralModel: [() => config.mistral.model, (v) => (config.mistral.model = String(v).trim() || config.mistral.model)],
  doctorOpenCodePath: [() => config.doctorOpenCode.path, (v) => (config.doctorOpenCode.path = String(v ?? '').trim())],
  doctorOpenCodeModel: [() => config.doctorOpenCode.model, (v) => (config.doctorOpenCode.model = String(v ?? '').trim())],
  openrouterModel: [() => config.openrouter.model, (v) => (config.openrouter.model = String(v).trim() || config.openrouter.model)],
  openrouterVoiceReasoning: [() => config.openrouter.voiceReasoning, (v) => (config.openrouter.voiceReasoning = ['none', 'low', 'medium', 'high'].includes(v) ? v : 'none')],
  openrouterReasoning: [() => config.openrouter.reasoning, (v) => (config.openrouter.reasoning = ['none', 'low', 'medium', 'high'].includes(v) ? v : 'medium')],
  // Her hands (actions.js): the model that makes her tool calls, separate from her voice.
  actionsEnabled: [() => config.actions.enabled, (v) => (config.actions.enabled = Boolean(v))],
  actionsModel: [() => config.actions.model, (v) => (config.actions.model = String(v).trim() || config.actions.model)],
  actionsReasoning: [() => config.actions.reasoning, (v) => (config.actions.reasoning = ['none', 'low', 'medium', 'high'].includes(v) ? v : 'low')],
  openrouterImageModel: [() => config.openrouter.imageModel, (v) => (config.openrouter.imageModel = String(v).trim() || config.openrouter.imageModel)],
  imageProvider: [() => config.imageProvider, (v) => (config.imageProvider = ['openrouter', 'kontext', 'flux'].includes(v) ? v : config.imageProvider)],
  // Blank falls back to .env: with no voice ID, Fish picks a random voice for every sentence.
  fishVoiceId: [() => config.fish.voiceId ?? '', (v) => (config.fish.voiceId = String(v ?? '').trim() || env.FISH_VOICE_ID || '')],
  fishStrongVoiceId: [() => config.fish.strongVoiceId ?? '', (v) => (config.fish.strongVoiceId = String(v ?? '').trim() || env.FISH_STRONG_VOICE_ID || '')],
  fishSensualVoiceId: [() => config.fish.sensualVoiceId ?? '', (v) => (config.fish.sensualVoiceId = String(v ?? '').trim())],
  fishWhisperVoiceId: [() => config.fish.whisperVoiceId ?? '', (v) => (config.fish.whisperVoiceId = String(v ?? '').trim())],
  ttsProvider: [() => config.tts, (v) => (config.tts = ['fish', 'kokoro', 'xtts', 'gtts'].includes(v) ? v : config.tts)],
  xttsReference: [() => config.xtts.reference, (v) => { const name = String(v ?? '').trim(); if (name && (path.basename(name) !== name || /[\\/]/.test(name))) throw new Error('XTTS reference must be a filename in the XTTS sample folder'); config.xtts.reference = name; }],
  xttsLanguage: [() => config.xtts.language, (v) => { const language = String(v).trim().toLowerCase(); if (!['en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ru', 'nl', 'cs', 'ar', 'zh-cn', 'ja', 'hu', 'ko', 'hi'].includes(language)) throw new Error('Unsupported XTTS language'); config.xtts.language = language; }],
  xttsSpeed: [() => config.xtts.speed, (v) => { const speed = Number(v); if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('XTTS speed must be between 0.5 and 2'); config.xtts.speed = speed; }],
  gttsLang: [() => config.gtts.lang, (v) => (config.gtts.lang = String(v ?? '').trim() || config.gtts.lang)],
  gttsTld: [() => config.gtts.tld, (v) => (config.gtts.tld = String(v ?? '').trim().replace(/^\.+/, '') || config.gtts.tld)],
  gttsSlow: [() => config.gtts.slow, (v) => (config.gtts.slow = v === true || v === 'true')],
  kokoroVoice: [() => config.kokoro.voice, (v) => (config.kokoro.voice = String(v).trim() || config.kokoro.voice)],
  kokoroSpeed: [() => config.kokoro.speed, (v) => (config.kokoro.speed = Math.max(0.5, Math.min(2, Number(v) || 1)))],
  fishTtsModel: [() => config.fish.ttsModel, (v) => (config.fish.ttsModel = String(v))],
  fishLanguage: [() => config.fish.language, (v) => (config.fish.language = String(v).trim().toLowerCase())],
  voiceSilenceMs: [() => config.voice.silenceMs, (v) => (config.voice.silenceMs = Number(v) || 800)],
  voiceBargeIn: [() => config.voice.bargeIn, (v) => (config.voice.bargeIn = Boolean(v))],
  voicePostTranscripts: [() => config.voice.postTranscripts, (v) => (config.voice.postTranscripts = Boolean(v))],
  voiceJoinGreeting: [() => config.voice.joinGreeting, (v) => (config.voice.joinGreeting = Boolean(v))],
  voiceAutoSocial: [() => config.voice.autoSocial, (v) => (config.voice.autoSocial = v === true || v === 'true')],
  voiceNewcomerIntroductions: [() => config.voice.newcomerIntroductions, (v) => (config.voice.newcomerIntroductions = v === true || v === 'true')],
  voiceArrivalFollowups: [() => config.voice.arrivalFollowups, (v) => (config.voice.arrivalFollowups = v === true || v === 'true')],
  voiceReconnectAnnouncements: [() => config.voice.reconnectAnnouncements, (v) => (config.voice.reconnectAnnouncements = v === true || v === 'true')],
  voiceRestartAnnouncements: [() => config.voice.restartAnnouncements, (v) => (config.voice.restartAnnouncements = v === true || v === 'true')],
  voiceTaskProgress: [() => config.voice.taskProgress, (v) => (config.voice.taskProgress = v === true || v === 'true')],
  voiceLearned: [() => config.voice.voiceLearned, (v) => (config.voice.voiceLearned = v === true || v === 'true')],
  overheardTasks: [() => config.voice.overheardTasks, (v) => (config.voice.overheardTasks = v === true || v === 'true')],

  voiceWakeWords: [() => config.voice.wakeWords, (v) => (config.voice.wakeWords = wordList(v))],
  voiceOwnerWakeWords: [() => config.voice.ownerWakeWords, (v) => (config.voice.ownerWakeWords = wordList(v))],
  voiceFreeTalk: [() => config.voice.freeTalk, (v) => (config.voice.freeTalk = Boolean(v))],
  rssEnabled: [() => config.rss.enabled, (v) => (config.rss.enabled = Boolean(v))],
  rssFeeds: [() => config.rss.feeds, (v) => (config.rss.feeds = normalizeFeeds(v))],
};

let saved = {};
if (existsSync(settingsPath)) {
  try {
    saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // The single wake word from before the two lists becomes the first word anyone can use.
    if ('voiceWakeWord' in saved) {
      if (!('voiceWakeWords' in saved)) saved.voiceWakeWords = wordList(saved.voiceWakeWord);
      delete saved.voiceWakeWord;
    }
    for (const [key, value] of Object.entries(saved)) {
      if (!Object.hasOwn(EDITABLE, key)) continue;
      // A full reset is about to clear her name and wake words (memory-wipe.js IDENTITY_SETTINGS); her voice,
      // brain and the rest of how she's installed still load.
      if (fullResetPending && ['botName', 'voiceWakeWords', 'voiceOwnerWakeWords'].includes(key)) continue;
      try { EDITABLE[key][1](value); }
      catch (err) { console.warn(`Ignoring saved setting ${key}: ${err.message}`); }
    }
  } catch (err) {
    console.warn('Ignoring unreadable data/settings.json:', err.message);
  }
}

export function getSettings() {
  return {
    ...Object.fromEntries(Object.entries(EDITABLE).map(([k, [get]]) => [k, get()])),
    persona: config.persona,
    mistralKey: Boolean(config.mistral.apiKey), // whether one is set, never the key itself
    openrouterKey: Boolean(config.openrouter.apiKey), // whether one is set, never the key itself
  };
}

const freeTalkListeners = new Set();
export function onVoiceFreeTalkChanged(listener) {
  freeTalkListeners.add(listener);
  return () => freeTalkListeners.delete(listener);
}

function writeSettingsFile(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, file);
  } catch (err) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw err;
  }
}

export function updateSettings(patch) {
  const next = { ...saved };
  const rollback = [];
  const previousFreeTalk = config.voice.freeTalk;
  const persona = Object.hasOwn(patch, 'persona') ? String(patch.persona).trim() : undefined;
  let personaWritten = false;
  let previousPersona;
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(EDITABLE, key)) continue;
      const [get, set] = EDITABLE[key];
      rollback.push([set, get()]);
      set(value);
      next[key] = get();
    }
    if (persona !== undefined) {
      previousPersona = existsSync(personaPath) ? readFileSync(personaPath) : null;
      writeSettingsFile(personaPath, persona + '\n');
      personaWritten = true;
    }
    if (rollback.length) writeSettingsFile(settingsPath, JSON.stringify(next, null, 2));
  } catch (err) {
    for (const [set, previous] of rollback.reverse()) set(previous);
    if (personaWritten) {
      if (previousPersona === null) rmSync(personaPath);
      else writeSettingsFile(personaPath, previousPersona);
    }
    throw err;
  }
  saved = next;
  if (persona !== undefined) config.persona = persona;
  if (previousFreeTalk !== config.voice.freeTalk) {
    for (const listener of freeTalkListeners) {
      try { listener(config.voice.freeTalk); }
      catch (err) { console.warn(`Could not publish free-talk setting: ${err.message}`); }
    }
  }
  return getSettings();
}

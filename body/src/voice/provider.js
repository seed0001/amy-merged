import { xttsAvailability } from './xtts.js';
import { GTTS_ACCENTS } from './gtts.js';

// Provider changes use injected dependencies so validation can be tested without loading a model.
export async function changeVoice({ action = 'status', engine = '', voice = '', speed = 0 } = {}, { config, updateSettings, voices, activity, xttsVoices = () => [], prepareXTTS }) {
  if (!['status', 'set', 'voices', 'providers'].includes(action)) throw new Error('Unknown voice action');
  if (action === 'providers') return 'Available TTS providers: Fish Audio (cloud, cloned voices; requires an API key), Kokoro (local preset voices), XTTS (local voice cloning from your saved sample), and gTTS (Google Translate voice: free, online, no key; accents American, British, Australian, Canadian, Indian, Irish, South African).';
  if (action === 'voices') {
    if (engine === 'gtts' || (!engine && config.tts === 'gtts')) return `gTTS accents (pass as voice): ${Object.entries(GTTS_ACCENTS).map(([tld, name]) => `${tld} (${name})`).join(', ')}.`;
    if (engine === 'xtts' || (!engine && config.tts === 'xtts')) return `XTTS voice samples: ${(await xttsVoices()).join(', ') || 'none yet; put your reference audio in the XTTS sample folder'}.`;
    // Nov 10: asked for Fish voices, this fell through to loading Kokoro's local model, which failed, and she
    // reported a broken voice system while her Fish voice was working fine.
    if (/^fish/i.test(engine) || engine === 'cloud' || (!engine && config.tts === 'fish')) {
      return `Fish Audio voices are cloud voices, not a fixed list: you're speaking with voice ${config.fish.voiceId || '(the default)'}${config.tts === 'fish' ? ', and that is the voice in use now' : ` (Fish isn't the speech provider right now; ${config.tts} is)`}. To browse or try other Fish voices, use the voice library tool (search, then preview).`;
    }
    let list;
    try { list = await voices(); }
    catch (err) { throw new Error(`Couldn't list Kokoro's local voices: its model wouldn't load (${err.message}). This only affects Kokoro; ${config.tts === 'kokoro' ? 'and Kokoro is your current voice, so speech may fail too' : `your current voice (${config.tts}) is unaffected`}.`); }
    return `Kokoro voices: ${list.join(', ')}.`;
  }
  if (action === 'set') {
    if (typeof engine !== 'string' || typeof voice !== 'string') throw new Error('Engine and voice must be text');
    engine = engine.trim().toLowerCase();
    engine = ({ 'fish audio': 'fish', cloud: 'fish', local: 'kokoro', 'xtts v2': 'xtts', 'xtts-v2': 'xtts', coqui: 'xtts', google: 'gtts', 'google tts': 'gtts', 'google translate': 'gtts', 'g tts': 'gtts' })[engine] ?? engine;
    voice = voice.trim();
    if (engine && !['fish', 'kokoro', 'xtts', 'gtts'].includes(engine)) throw new Error('Supported TTS providers are Fish Audio, Kokoro, XTTS and gTTS');
    if (typeof speed !== 'number' || !Number.isFinite(speed) || (speed !== 0 && (speed < 0.5 || speed > 2))) throw new Error('Local speech speed must be between 0.5 and 2');
    const target = engine || (voice ? /\.(wav|mp3|flac|ogg|m4a)$/i.test(voice) ? 'xtts' : 'kokoro' : config.tts);
    if (!engine && !voice && !speed) throw new Error('Nothing to change: give a provider, voice or speed');
    if (target === 'fish' && (voice || speed)) throw new Error('Local voice and speed settings apply to Kokoro or XTTS; choose a local engine to use them');
    if (target === 'fish' && !config.fish.apiKey) throw new Error('Fish Audio is not configured: add its API key before switching');
    if (target === 'kokoro') {
      // Load the local model before persisting a switch; a failed download leaves settings intact.
      const available = await voices();
      const selected = voice || config.kokoro.voice;
      if (!available.includes(selected)) throw new Error(`Unknown Kokoro voice: ${selected}. Ask to list voices`);
    }
    if (target === 'gtts' && voice && !GTTS_ACCENTS[voice]) throw new Error(`Unknown gTTS accent: ${voice}. Use one of ${Object.keys(GTTS_ACCENTS).join(', ')}`);
    if (target === 'xtts') {
      if (!prepareXTTS) throw new Error('XTTS is not configured');
      if (voice && !(await xttsVoices()).includes(voice)) throw new Error('Unknown XTTS voice sample. Ask to list XTTS voices');
      await prepareXTTS({ ...config.xtts, ...(voice ? { reference: voice } : {}), ...(speed ? { speed } : {}) });
    }
    const patch = { ttsProvider: target };
    if (voice) patch[{ xtts: 'xttsReference', gtts: 'gttsTld' }[target] ?? 'kokoroVoice'] = voice;
    if (speed && target === 'gtts') patch.gttsSlow = speed < 1;
    else if (speed) patch[target === 'xtts' ? 'xttsSpeed' : 'kokoroSpeed'] = speed;
    updateSettings(patch);
    activity('settings', { message: `Voice: ${JSON.stringify(patch)}` });
  }
  return config.tts === 'gtts'
    ? `Speaking with gTTS (Google Translate voice), language ${config.gtts.lang}, accent ${GTTS_ACCENTS[config.gtts.tld] ?? config.gtts.tld}${config.gtts.slow ? ', slow' : ''}.`
    : config.tts === 'xtts'
    ? `Speaking with XTTS (local voice cloning), sample ${config.xtts.reference || '(automatically selected from the sample folder)'}, language ${config.xtts.language}, speed ${config.xtts.speed}.`
    : config.tts === 'kokoro'
    ? `Speaking with Kokoro (local), voice ${config.kokoro.voice}, speed ${config.kokoro.speed}.`
    : `Speaking with Fish Audio (cloud), model ${config.fish.ttsModel}, voice ${config.fish.voiceId || '(default)'}.`;
}

export const ttsReady = (config) => config.tts === 'xtts' ? xttsAvailability(config.xtts).ready : ['kokoro', 'gtts'].includes(config.tts) || Boolean(config.fish.apiKey);

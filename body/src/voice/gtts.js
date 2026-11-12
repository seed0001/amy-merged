import { spawn } from 'node:child_process';
import { config } from '../config.js';

// Text-to-speech with gTTS (Google Translate's voice, through the gTTS Python package). Free and needs
// no key, but it's online and has one voice per language; the accent comes from the Google domain
// (tld: com US, co.uk British, com.au Australian, ca Canadian, co.in Indian, ie Irish, co.za South
// African). gTTS writes mp3; ffmpeg turns it into Ogg Opus 48kHz for Discord voice.

export const GTTS_ACCENTS = { com: 'American', 'co.uk': 'British', 'com.au': 'Australian', ca: 'Canadian', 'co.in': 'Indian', ie: 'Irish', 'co.za': 'South African' };

const SCRIPT = 'import sys; from gtts import gTTS; gTTS(sys.stdin.read(), lang=sys.argv[1], tld=sys.argv[2], slow=sys.argv[3] == "1").write_to_fp(sys.stdout.buffer)';

let queue = Promise.resolve();

export function gttsSynthesize(text, { format = 'opus' } = {}) {
  const job = queue.then(async () => {
    const mp3 = await run(config.gtts.python, ['-c', SCRIPT, config.gtts.lang, config.gtts.tld, config.gtts.slow ? '1' : '0'], Buffer.from(text, 'utf8'), 'gTTS');
    if (format === 'mp3') return mp3;
    return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1'], mp3, 'ffmpeg');
  });
  queue = job.catch(() => {});
  return job;
}

function run(cmd, args, input, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => reject(new Error(`${label} could not start: ${e.message}`)));
    child.on('close', (code) => (code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`${label} failed: ${err.trim().split('\n').at(-1)?.slice(0, 300) || `exit ${code}`}`))));
    child.stdin.end(input);
  });
}

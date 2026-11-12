import { config } from '../config.js';

// The words of a song (song-sense.js): the whole recording (a small MP3) or a stretch of it (a WAV), with each sung
// line timed. Returns [{ start, end, text, noSpeech, logprob }] in seconds. Errors as transcribeGroq's.
export async function transcribeGroqLyrics(audio, { mime = 'audio/mpeg', name = 'song.mp3', model = config.groq.model } = {}) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), name);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (config.fish.language) form.append('language', config.fish.language);
  form.append('prompt', 'Song lyrics, sung over music.');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${config.groq.apiKey}` }, body: form, signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Groq couldn't transcribe the song (${res.status}): ${body.slice(0, 200)}`);
    if (res.status === 429) err.retryAfterMs = Math.max(Number(res.headers.get('retry-after')) * 1000 || 0, 60_000);
    throw err;
  }
  const data = await res.json();
  return (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: String(s.text ?? '').trim(), noSpeech: s.no_speech_prob ?? 0, logprob: s.avg_logprob ?? 0 }));
}

// Groq-hosted Whisper (https://console.groq.com). Takes a WAV buffer, returns the raw transcript.
export async function transcribeGroq(wav, model = config.groq.model) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (config.fish.language) form.append('language', config.fish.language);
  // A plain lead-in in the expected language. Whisper fills silence and noise with phrases from other
  // languages ("Kiitos.", "Það kom það.") even with the language set; a prompt in English stops most of it.
  if (!config.fish.language || config.fish.language === 'en') form.append('prompt', `${config.botName} is on a Discord voice call, talking with friends in English.`);

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Groq transcription failed (${res.status}): ${body.slice(0, 200)}`);
    // Rate limited: how long until it resets, from the header or "try again in 7m30.5s".
    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const m = body.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
      const fromText = m ? ((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) * 1000 : 0;
      err.retryAfterMs = Math.max(header > 0 ? header * 1000 : 0, fromText, 60_000);
    }
    throw err;
  }
  return (await res.json()).text ?? '';
}

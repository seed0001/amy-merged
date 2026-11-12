// Every call to a model, in one place (owner, 2026-11-11: "every single model call that happens needs to be
// tracked"). Every model she uses is reached over the network, the local Ollama included, so the network layer is
// wrapped once at startup: any request to a model service is written to data/model-calls.jsonl with what it was,
// which model, where in her code it came from, how long it took and whether it worked. A call added later is
// caught the same way; nothing has to remember to log itself.
//
// With no language model in use (config.brain === 'amy'), a call to a text model is refused before it leaves, and
// logged as blocked with the file and line that tried: that list is what is still to be moved to her own brain
// (MERGE-PLAN.md). Hearing (speech-to-text), her voice (text-to-speech) and embeddings are not language models
// writing for her; they are logged and let through.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { activity } from './events.js';

export const CALLS_FILE = () => path.join(DATA_DIR, 'model-calls.jsonl');

// What a request is, from where it's going. null: not a model call.
export function classify(url, { ollamaHost = config.ollama.host } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const p = u.pathname;
  let local = null;
  try { local = new URL(ollamaHost); } catch {}
  if (local && u.host === local.host) {
    if (/^\/api\/(chat|generate)$/.test(p)) return { kind: 'text', provider: 'ollama', local: true };
    if (/^\/api\/embed(dings)?$/.test(p)) return { kind: 'embedding', provider: 'ollama', local: true };
    return null; // listing, loading and checking models
  }
  if (u.host === 'openrouter.ai') return /\/chat\/completions$/.test(p) ? { kind: 'text', provider: 'openrouter', local: false } : null;
  if (u.host === 'api.mistral.ai') return /\/chat\/completions$/.test(p) ? { kind: 'text', provider: 'mistral', local: false } : null;
  if (u.host === 'api.openai.com') return /\/(responses|chat\/completions)$/.test(p) ? { kind: 'text', provider: 'chatgpt', local: false } : null;
  if (u.host === 'chatgpt.com' && /\/backend-api\/.*(responses|conversation)/.test(p)) return { kind: 'text', provider: 'chatgpt', local: false };
  if (u.host === 'api.groq.com') return /\/audio\/transcriptions$/.test(p) ? { kind: 'hearing', provider: 'groq', local: false } : null;
  if (u.host === 'api.fish.audio') return /\/tts$/.test(p) ? { kind: 'voice', provider: 'fish', local: false } : null;
  return null;
}

// The file and line in her code that made the call (the first frame that isn't this file or Node itself).
function caller() {
  const frames = String(new Error().stack ?? '').split('\n').slice(2);
  for (const f of frames) {
    const m = f.match(/[\\/]src[\\/]([^)\s]+?):(\d+):\d+\)?$/);
    if (m && !m[1].startsWith('model-guard.js')) return `${m[1].replace(/\\/g, '/')}:${m[2]}`;
  }
  return 'unknown';
}

function modelOf(init) {
  try { return typeof init?.body === 'string' ? JSON.parse(init.body).model ?? null : null; } catch { return null; }
}

export function guardedFetch(fetchImpl, { blockText = () => config.brain === 'amy', file = CALLS_FILE, log = activity, now = Date.now, ollamaHost = () => config.ollama.host } = {}) {
  const told = new Set(); // each blocked caller is announced once; every one is in the file
  const write = (row) => {
    try { appendFileSync(file(), `${JSON.stringify(row)}\n`); }
    catch (err) { log('error', { where: 'model-call log', message: `Couldn't record a ${row.kind} call to ${row.provider} in ${file()}: ${err.message}. The model-call log is missing that call.` }); }
  };
  return async function fetch(input, init) {
    const what = classify(typeof input === 'string' || input instanceof URL ? input : input?.url, { ollamaHost: ollamaHost() });
    if (!what) return fetchImpl(input, init);
    const row = { at: now(), ...what, model: modelOf(init), from: caller() };
    if (what.kind === 'text' && blockText()) {
      write({ ...row, blocked: true, ok: false });
      if (!told.has(row.from)) {
        told.add(row.from);
        log('model-blocked', { ...row, message: `No language model is in use (BRAIN=amy): ${row.from} tried to call ${row.provider}${row.model ? ` ${row.model}` : ''} and was refused. That job still needs moving to her own brain.` });
      }
      throw new Error(`No language model is in use (BRAIN=amy), so the call to ${row.provider}${row.model ? ` ${row.model}` : ''} from ${row.from} was refused. This job hasn't been moved to her own brain yet (MERGE-PLAN.md); it's recorded in ${file()}.`);
    }
    try {
      const res = await fetchImpl(input, init);
      const done = { ...row, ms: now() - row.at, ok: res.ok, status: res.status };
      // A plain JSON answer carries its tokens and price; a stream is recorded without them.
      if (res.ok && /json/.test(res.headers?.get?.('content-type') ?? '') && what.kind !== 'voice') {
        res.clone().json().then((body) => {
          const u = body?.usage ?? {};
          write({ ...done, in: u.prompt_tokens ?? body?.prompt_eval_count ?? null, out: u.completion_tokens ?? body?.eval_count ?? null, cost: u.cost ?? null });
        }).catch(() => write(done));
      } else write(done);
      return res;
    } catch (err) {
      write({ ...row, ms: now() - row.at, ok: false, error: String(err?.message ?? err).slice(0, 300) });
      throw err;
    }
  };
}

// Installed on import. index.js imports this before anything that calls a model.
if (!globalThis.fetch.__modelGuard) {
  const guarded = guardedFetch(globalThis.fetch.bind(globalThis));
  guarded.__modelGuard = true;
  globalThis.fetch = guarded;
}

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA_DIR, config } from './config.js';
import { activity, bus } from './events.js';

// Who a voice sounds like. Every utterance she hears is turned into a speaker embedding by a local
// model (sherpa-onnx, voice/voiceprint_worker.py), and each person she knows has a voiceprint: the
// running mean of their embeddings, under their Discord id. A new utterance is compared with every
// voiceprint. When it matches the tag it came in under (or nobody yet), it joins that person's print,
// so she learns voices by listening, no enrollment step. When it clearly matches a different person
// than the tag says, that's noted: the voice on Owner's mic that sounds like friend_3 is worth knowing.
// Nothing here ever throws into the voice path.

export const MODEL_FILE = 'wespeaker_en_voxceleb_CAM++.onnx';
export const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${MODEL_FILE}`;
const MODEL = process.env.VOICEPRINT_MODEL || path.join(ROOT, 'models', 'voiceprints', MODEL_FILE);
const PYTHON = process.env.VOICEPRINT_PYTHON || (existsSync(config.parakeet?.python ?? '') ? config.parakeet.python : 'python');
const FILE = path.join(DATA_DIR, 'voiceprints.json');
const MIN_SECONDS = 1.2;
const MAX_COUNT = 200; // a print keeps adapting: the mean forgets slowly past this many utterances
// Learned: enough of someone's voice to tell it apart. Both must be met (lines and seconds of speech).
const LEARN_UTTERANCES = 12;
const LEARN_SECONDS = 60;
const DEFAULTS = { threshold: 0.55, margin: 0.08 };

// ---------- the worker: one embedding at a time, same JSON-lines pattern as parakeet.js ----------
class EmbedWorker {
  constructor({ python = PYTHON, model = MODEL, spawnImpl = spawn } = {}) {
    Object.assign(this, { python, model, spawnImpl, child: null, sequence: 0, pending: new Map(), queue: Promise.resolve() });
  }
  stop(message = 'Voiceprint worker stopped') {
    const child = this.child; this.child = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear(); child?.kill();
  }
  start() {
    if (this.child) return;
    const child = this.spawnImpl(this.python, ['-u', fileURLToPath(new URL('./voice/voiceprint_worker.py', import.meta.url)), '--model', this.model, '--threads', '2'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    let buffer = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return this.stop('Voiceprint response exceeded size limit');
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        let response;
        try { response = JSON.parse(line); } catch { this.stop('Voiceprint worker returned invalid data'); return; }
        const p = this.pending.get(response.id); if (!p) continue;
        this.pending.delete(response.id); clearTimeout(p.timer);
        if (response.ok && Array.isArray(response.embedding)) p.resolve(Float32Array.from(response.embedding));
        else p.reject(new Error(`Voiceprint: ${response.error || 'no embedding'}`));
      }
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-2000); });
    child.on('error', () => { if (this.child === child) this.stop('Could not start the voiceprint worker. Run scripts/setup-voiceprints.ps1'); });
    child.stdin.on('error', () => { if (this.child === child) this.stop('Voiceprint worker input closed'); });
    child.on('exit', (code) => { if (this.child === child) this.stop(`Voiceprint worker exited (${code}): ${stderr.slice(-500)}`); });
  }
  // pcm16k: 16 kHz mono PCM16 Buffer -> Float32Array embedding.
  embed(pcm16k) {
    const job = this.queue.then(() => {
      this.start();
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.stop('Voiceprint embedding timed out'), 30000);
        this.pending.set(id, { resolve, reject, timer });
        this.child.stdin.write(JSON.stringify({ id, pcm: pcm16k.toString('base64') }) + '\n');
      });
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

// 48 kHz -> 16 kHz, averaging each group of 3 samples (as voice/stt.js does).
export function downsample16k(pcm48k) {
  const samples = Math.floor(pcm48k.length / 6);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const o = i * 6;
    out.writeInt16LE(Math.round((pcm48k.readInt16LE(o) + pcm48k.readInt16LE(o + 2) + pcm48k.readInt16LE(o + 4)) / 3), i * 2);
  }
  return out;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// What's missing for this to work at all, or '' when it can run. Checked by file, never by importing.
export function unavailableReason({ python = PYTHON, model = MODEL } = {}) {
  if (!existsSync(model)) return `the speaker model is missing at ${model}`;
  if (python !== 'python' && !existsSync(python)) return `the Python for it is missing at ${python}`;
  return '';
}

export function createVoiceprints({ embed = null, file = FILE, python = PYTHON, model = MODEL, now = Date.now, log = activity, onLearned = (event) => bus.emit('voiceprint-learned', event) } = {}) {
  let worker = null;
  const embedder = embed ?? ((pcm16k) => { worker ??= new EmbedWorker({ python, model }); return worker.embed(pcm16k); });
  const load = () => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { settings: { ...DEFAULTS }, people: {} }; } catch { return { settings: { ...DEFAULTS }, people: {} }; } };
  const save = (data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(data)); renameSync(`${file}.tmp`, file); };
  const lastHeard = new Map(); // conversation -> { userId, name, score, match, at }
  const lastMismatch = new Map(); // conversation -> { tag, soundsLike, score, at }
  let saidUnavailable = false;

  // Fold one embedding into a person's print (running mean, capped so it keeps adapting).
  function learn(data, userId, name, emb, seconds) {
    const p = data.people[userId] ?? { name, count: 0, seconds: 0, centroid: Array.from(emb), updated: now() };
    if (p.count > 0) {
      const n = Math.min(p.count, MAX_COUNT);
      for (let i = 0; i < emb.length; i++) p.centroid[i] = (p.centroid[i] * n + emb[i]) / (n + 1);
    }
    p.count += 1; p.seconds = (p.seconds ?? 0) + seconds; p.name = name; p.updated = now();
    data.people[userId] = p;
    return p;
  }

  return {
    async heard(pcm48k, { userId, name, conversation }) {
      try {
        if (!Buffer.isBuffer(pcm48k) || pcm48k.length < 48000 * 2 * MIN_SECONDS || !userId) return null;
        if (!embed) {
          const why = unavailableReason({ python, model });
          if (why) { if (!saidUnavailable) { saidUnavailable = true; log('voiceprint', { unavailable: why, fix: 'scripts/setup-voiceprints.ps1' }); } return null; }
        }
        const emb = await embedder(downsample16k(pcm48k.subarray(0, pcm48k.length - pcm48k.length % 6)));
        const data = load();
        const { threshold, margin } = { ...DEFAULTS, ...data.settings };
        const scores = Object.entries(data.people).map(([id, p]) => ({ id, name: p.name, score: cosine(emb, p.centroid) })).sort((a, b) => b.score - a.score);
        const own = scores.find((s) => s.id === userId)?.score ?? null;
        const best = scores[0] ?? null;
        const mismatch = best && best.id !== userId && best.score >= threshold && best.score - (own ?? 0) >= margin;
        if (mismatch) {
          lastMismatch.set(conversation, { tag: name, soundsLike: best.name, score: +best.score.toFixed(3), at: now() });
          log('voiceprint', { mismatch: true, tag: name, sounds_like: best.name, score: +best.score.toFixed(3), own: own == null ? null : +own.toFixed(3) });
        } else {
          const p = learn(data, userId, name, emb, pcm48k.length / (48000 * 2));
          if (!p.learnedAt && p.count >= LEARN_UTTERANCES && p.seconds >= LEARN_SECONDS) {
            p.learnedAt = now();
            onLearned({ userId, name: p.name, utterances: p.count, seconds: Math.round(p.seconds), conversation });
          }
          save(data);
        }
        const result = { userId, name, match: mismatch ? best.name : name, score: +((mismatch ? best.score : own ?? 1)).toFixed(3), mismatch: Boolean(mismatch), known: data.people[userId]?.count ?? 0, at: now() };
        lastHeard.set(conversation, result);
        return result;
      } catch (err) {
        log('error', { where: 'voiceprint', message: err.message });
        return null;
      }
    },
    who(conversation) { return lastHeard.get(conversation) ?? null; },
    // For her prompt: only when the voice and the tag disagree, and only while it's fresh.
    promptLine(conversation) {
      const m = lastMismatch.get(conversation);
      if (!m || now() - m.at > 5 * 60_000) return '';
      return `Your ear says the voice on ${m.tag}'s mic sounds like ${m.soundsLike} (${Math.round(m.score * 100)}% alike), not ${m.tag}. Trust the voice over the name tag, and ask who's talking if it matters.`;
    },
    list() { const d = load(); return Object.entries(d.people).map(([id, p]) => ({ userId: id, name: p.name, utterances: p.count, seconds: Math.round(p.seconds ?? 0), learned: Boolean(p.learnedAt), updated: p.updated })).sort((a, b) => b.utterances - a.utterances); },
    forget(userId) { const d = load(); const had = d.people[userId]; delete d.people[userId]; save(d); return had?.name ?? null; },
    settings(patch = null) {
      const d = load();
      if (patch) {
        const t = patch.threshold !== undefined ? Number(patch.threshold) : undefined, m = patch.margin !== undefined ? Number(patch.margin) : undefined;
        if (t !== undefined && !(t >= 0.2 && t <= 0.95)) throw new Error('threshold is 0.2 to 0.95 (how alike two voices must be to count as the same person).');
        if (m !== undefined && !(m >= 0 && m <= 0.5)) throw new Error('margin is 0 to 0.5 (how much more alike another voice must be before the tag is doubted).');
        d.settings = { ...DEFAULTS, ...d.settings, ...(t !== undefined && { threshold: t }), ...(m !== undefined && { margin: m }) };
        save(d);
      }
      return { ...DEFAULTS, ...d.settings };
    },
    status() {
      const why = embed ? '' : unavailableReason({ python, model });
      const people = this.list();
      return { ready: !why, ...(why && { missing: why, fix: `Run scripts/setup-voiceprints.ps1 (it does: pip install sherpa-onnx numpy, then downloads ${MODEL_URL} to ${path.dirname(model)}).` }), model, python, people: people.length, utterances: people.reduce((n, p) => n + p.utterances, 0), ...this.settings() };
    },
    stop() { worker?.stop(); worker = null; },
  };
}

export const voiceprints = createVoiceprints();
process.once('exit', () => voiceprints.stop());

// The tool, in the shape src/tools.js uses. Registered there by the parent.
export const voiceprintsTool = {
  enabled: (ctx) => Boolean(ctx.perms?.owner),
  definition: {
    type: 'function',
    function: {
      name: 'voiceprints',
      description: "Owner only. How you tell people apart by their voice, not just their name tag: every voice you hear in a call feeds that person's voiceprint, and when a voice on someone's mic sounds like a different person you know, you notice. status: whether it is working, what is missing and how to fix it, how many people you know by voice, and the match settings. list: everyone you know by voice and how much of each you've heard. who: the last voice you heard in this conversation and whether it matched its tag. forget: drop someone's voiceprint (by Discord user id) so it is learned fresh. settings: change threshold (0.2-0.95, how alike counts as the same voice) or margin (0-0.5). You cannot enroll anyone by hand: you learn voices by listening.",
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['status', 'list', 'who', 'forget', 'settings'] },
        user_id: { type: 'string', description: 'forget: the Discord user id.' },
        threshold: { type: 'number' }, margin: { type: 'number' },
      }, required: ['action'] },
    },
  },
  run: ({ action, user_id, threshold, margin }, ctx) => {
    switch (action) {
      case 'status': return JSON.stringify(voiceprints.status());
      case 'list': { const l = voiceprints.list(); return l.length ? l.map((p) => `${p.name} (${p.userId}): ${p.utterances} utterance(s), ${p.seconds}s of speech, ${p.learned ? 'learned (tells them apart by voice)' : `still learning (needs ${LEARN_UTTERANCES} utterances and ${LEARN_SECONDS}s)`}, last ${new Date(p.updated).toLocaleString()}`).join('\n') : 'Nobody known by voice yet. It fills in as people talk in calls.'; }
      case 'who': { const w = voiceprints.who(ctx.conversation); return w ? `${w.name} (tag) last spoke; the voice ${w.mismatch ? `sounded like ${w.match}` : 'matched the tag'} at ${Math.round(w.score * 100)}%, ${w.known} utterance(s) of ${w.name} known.` : 'No voice heard in this conversation since I started.'; }
      case 'forget': { if (!user_id) throw new Error('forget needs user_id.'); const n = voiceprints.forget(user_id); return n ? `Forgot ${n}'s voiceprint.` : 'No voiceprint under that id.'; }
      case 'settings': return JSON.stringify(voiceprints.settings(threshold !== undefined || margin !== undefined ? { threshold, margin } : null));
      default: throw new Error('Use status, list, who, forget or settings.');
    }
  },
};

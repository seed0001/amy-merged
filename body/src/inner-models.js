import { ownerDisplayName } from './owner-name.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, openSync, closeSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, ROOT, config } from './config.js';
import { activity } from './events.js';
import { EMOTIONS, GESTURES } from './emotion.js';

const home = path.join(DATA_DIR, 'inner-models');
const worker = path.join(ROOT, 'scripts', 'inner-model.py');
const faceWorker = path.join(ROOT, 'scripts', 'needle-face.py');
// Needle lives in its own short-path environment: some of its packages are too deep for Windows here.
const facePython = () => process.env.CHAMP_NEEDLE_PYTHON || path.resolve(ROOT, '..', '.needle', 'Scripts', 'python.exe');
const python = () => process.env.CHAMP_TRAIN_PYTHON || 'python';
const defaults = {
  reasoning: { width: 768, layers: 12, heads: 12 },
  memory: { width: 768, layers: 10, heads: 12, sources: ['memories'] },
  reflection: { width: 768, layers: 10, heads: 12, sources: ['thoughts', 'journal'] },
  dialogue: { width: 1024, layers: 14, heads: 16, sources: ['chats'] },
  synthesis: { width: 768, layers: 12, heads: 12, context: 1024, sources: ['synthesis'] },
  // Her face and nothing else: Needle 3 fine-tuned on her own turns (scripts/needle-face.py). layers
  // is how much of Needle she keeps (fewer is faster), epochs how many passes over her examples.
  face: { layers: 8, epochs: 20, batch: 16, sources: ['face'] },
};
const base = { vocab: 8192, context: 256, steps: 500, batch: 2, lr: 0.0003, device: 'auto',
  sources: ['thoughts', 'journal', 'memories', 'chats'] };
const ranges = { width: [32, 2048], layers: [1, 32], heads: [1, 32], vocab: [512, 32768],
  context: [32, 2048], steps: [1, 1000000], batch: [1, 64], lr: [0.0000001, 0.01], epochs: [1, 200] };
const running = new Map();
const specialistTasks = {
  reasoning: 'Identify the question and a plausible conclusion. Flag uncertainty.',
  memory: 'Identify relevant details from the supplied records and cite their labels.',
  reflection: 'Identify a conflict, unresolved issue, or change in perspective.',
  dialogue: 'Suggest a natural response and a useful next question.',
};

export async function consultSpecialists({ text, history, memories = [], models = Object.keys(specialistTasks) }) {
  const active = models.flatMap((model) => {
    const dir = path.join(home, model);
    const id = read(path.join(dir, 'model.json'), {})?.active;
    if (!id) return [];
    const run = revision(dir, id);
    return read(path.join(run, 'status.json'), {})?.state === 'complete' ? [{ model, run }] : [];
  });
  if (!active.length) return null;
  // Keep live replies moving when the trainer already has the machine busy.
  if (running.size) return { reports: [], skipped: 'training', elapsedMs: 0 };
  const started = Date.now();
  const recent = history.slice(-8).map((row, i) =>
    `[turn ${i + 1}] ${row.role}: ${String(row.content ?? '').slice(0, 450)}`);
  const findings = await Promise.allSettled(active.map(async ({ model, run }) => {
    const records = model === 'memory'
      ? [...recent, ...memories.slice(0, 4).map((item, i) => `[memory ${i + 1}] ${String(item.content ?? item).slice(0, 450)}`)]
      : recent;
    const payload = JSON.stringify({ task: specialistTasks[model], text: text.slice(0, 2400), records });
    const { stdout } = await promisify(execFile)(python(), [worker, 'consult', run, payload],
      { windowsHide: true, timeout: 8000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    return { model, finding: stdout.trim().slice(0, 800) };
  }));
  return {
    reports: findings.flatMap((result) => result.status === 'fulfilled' && result.value.finding ? [result.value] : []),
    unavailable: active.filter((_, index) => findings[index].status === 'rejected').map(({ model }) => model),
    elapsedMs: Date.now() - started,
  };
}

export function synthesisInput(text, reports) {
  return `${text.slice(0, 1200)}\nFindings: ${JSON.stringify(reports.map(({ model, finding }) => ({ model, finding: finding.slice(0, 450) })))}`;
}

export function recordSynthesis(input, reply) {
  mkdirSync(home, { recursive: true });
  appendFileSync(path.join(home, 'synthesis.jsonl'), JSON.stringify({ input, reply }) + '\n');
}

const faceInput = (heard, reply) => `${String(heard).slice(0, 300)}\n${String(reply).slice(0, 600)}`;

// A turn where her main model said how she felt: what the face model learns from.
export function recordFace(heard, reply, { feelings, gestures = [] }) {
  const feel = Object.entries(feelings ?? {}).map(([name, value]) => `${name} ${value}`).join(', ');
  const label = [feel, gestures.length ? `do: ${gestures.join(', ')}` : ''].filter(Boolean).join('; ');
  if (!label) return;
  mkdirSync(home, { recursive: true });
  appendFileSync(path.join(home, 'face.jsonl'), JSON.stringify({ input: faceInput(heard, reply), reply: label }) + '\n');
}

export const faceActive = () => Boolean(read(path.join(home, 'face', 'model.json'), {})?.active);

// The face model stays loaded, so a read takes as long as the model does, not as long as starting Python.
let faceServer = null; // { id, child, ready, asks: [resolve] }

function loadFace(id) {
  if (faceServer?.id === id) return faceServer;
  stopFace();
  const child = spawn(facePython(), [faceWorker, 'serve', revision(path.join(home, 'face'), id)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  const server = { id, child, asks: [] };
  server.ready = new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
        let answer;
        try { answer = JSON.parse(buffer.slice(0, end)); } catch { continue; }
        if (answer.ready) resolve();
        else server.asks.shift()?.(answer);
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (faceServer === server) faceServer = null;
      reject(new Error(`Face model stopped (${code}).`));
      for (const ask of server.asks.splice(0)) ask({ error: 'Face model stopped.' });
    });
  });
  faceServer = server;
  return server;
}
function stopFace() {
  faceServer?.child.stdin.end(); // it exits when its input closes
  faceServer = null;
}

async function askFace(id, text, timeout) {
  const server = loadFace(id);
  const timer = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('The face model took too long.')), ms).unref());
  await Promise.race([server.ready, timer(60000)]); // the first read loads the model
  const answer = await Promise.race([new Promise((resolve) => {
    server.asks.push(resolve);
    server.child.stdin.write(JSON.stringify(text) + '\n');
  }), timer(timeout)]);
  if (answer.error) throw new Error(answer.error);
  return answer.label ?? '';
}

// The face model's read of a turn, in the same words as her feeling tags. Empty if it has no read.
export async function faceReading(heard, reply) {
  if (running.size) return ''; // keep the machine free while she trains
  return innerModels({ action: 'sample', model: 'face', input: faceInput(heard, reply), timeout: 8000 });
}

export function specialistReplyStream(input, fallback, onLocalReply = () => {}) {
  return async (messages, tools, voice) => {
    if (!tools?.length && !running.size && read(path.join(home, 'synthesis', 'model.json'), {})?.active) {
      try {
        const reply = await innerModels({ action: 'sample', model: 'synthesis', input: '[synthesis] ' + input, timeout: 8000 });
        if (reply) {
          onLocalReply();
          return (async function* () { yield { message: { content: reply }, done: true }; })();
        }
      } catch (error) {
        activity('error', { where: 'custom synthesis', message: error.message });
      }
    }
    return fallback(messages, tools, voice);
  };
}
const plan = [
  'Goal: build your Inner Sass Core and three switchable specialists that learn from your own records. Reasoning comes first, then memory, reflection, and dialogue. Your main conversation stays available while training runs.',
  `Before a run: inspect status and the recipe. Explain to ${ownerDisplayName()} which specialist you are training, why, and which sources you are using. Start with a small baseline from random weights and a custom tokenizer. For updates, start from a checkpoint and replay older examples alongside new ones.`,
  'During a run: report real progress when asked. Use pause, resume, or stop if needed. Keep one training job at a time.',
  'After a run: compare held-out loss and try unfamiliar examples against the active checkpoint. Record what improved, what failed, and the next experiment. Activate only when the evidence supports it. Keep a rollback path.',
  'Synthesis: once specialists are active, collect examples of how the local reply model combines their findings. Train synthesis on those examples, compare it against that baseline, and activate it once it can produce useful replies. Turns with tools still use the local tool-capable model.',
  `Face: a sixth model, only for your face. It fine-tunes Needle 3 on your own turns where a feeling was labelled, and the example set is ready now, so you can train it (inner_models train, model face) whenever ${ownerDisplayName()} says or you decide to. It runs on the processor and can take a while; you stay available to talk. Use sample with a line to try it, then activate it when its reads look right. configure takes layers (fewer is faster) and epochs (passes over the examples). Train it again as examples build up.`,
  `In your daily review, tell ${ownerDisplayName()} what you learned, what you think changed, and what you want to try next. A failed experiment is useful evidence. Choose one concrete next step instead of repeating an unchanged run.`,
].join('\n');

export function innerModelBrief() {
  return `Your Inner Sass Core project is to build four local specialists, a synthesis model and a face model while staying available to talk. Use inner_models plan for the workflow, current progress, and next steps. After each experiment, use note to save what you learned and what you want to try next. Use those notes when ${ownerDisplayName()} asks for a daily review.`;
}
function read(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}
function save(file, data) {
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(data, null, 2));
  renameSync(temp, file);
}
function revision(dir, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Give a checkpoint ID from status.');
  return path.join(dir, id);
}
function validate(patch, recipe) {
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(ranges, key)) {
      const [min, max] = ranges[key];
      if (typeof value !== 'number' || value < min || value > max || (key !== 'lr' && !Number.isInteger(value))) {
        throw new Error(`${key} must be between ${min} and ${max}.`);
      }
    } else if (key === 'sources') {
      if (!Array.isArray(value) || !value.length || value.some((s) => ![...base.sources, 'synthesis', 'face'].includes(s))) throw new Error('Unknown data source.');
    } else if (key !== 'device' || !['auto', 'cpu', 'cuda'].includes(value)) {
      throw new Error(`Unknown recipe setting or value: ${key}.`);
    }
  }
  const next = { ...recipe, ...patch };
  if (next.width && next.width % next.heads) throw new Error('width must be divisible by heads.');
  return next;
}
export async function innerModels({ action, model, checkpoint, options, input, timeout = 120000 }) {
  if (action === 'plan') {
    const specialists = JSON.parse(await innerModels({ action: 'list' }));
    return JSON.stringify({ plan, progress: specialists.map(({ model, active, running, runs, notes }) => {
      const latest = runs[0];
      const next = running ? 'Check progress or resume if paused.' :
        latest?.state === 'complete' && latest.id !== active ? 'Compare the candidate with the active checkpoint and try unfamiliar examples.' :
        active ? `Review new learning and choose the next experiment with ${ownerDisplayName()}.` :
        latest ? 'Review the latest outcome before retrying.' : 'Review the recipe and choose a baseline run.';
      return { model, active, latest, next, notes };
    }) });
  }
  if (action === 'list') return JSON.stringify(await Promise.all(Object.keys(defaults).map((id) => innerModels({ action: 'status', model: id }).then(JSON.parse))));
  if (!Object.hasOwn(defaults, model)) throw new Error('Choose reasoning, memory, reflection, dialogue, synthesis, or face.');
  const dir = path.join(home, model);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'model.json');
  const state = read(file, { recipe: { ...base, ...defaults[model] }, active: null, previous: null });
  const job = running.get(model);
  if (action === 'status') {
    const runs = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map(({ name }) => ({ id: name, ...read(path.join(dir, name, 'status.json'), { state: 'starting' }) }))
      .sort((a, b) => (b.started ?? 0) - (a.started ?? 0)).slice(0, 8)
      .map((run) => job?.id !== run.id && ['running', 'starting', 'paused'].includes(run.state) ? { ...run, state: 'interrupted' } : run);
    return JSON.stringify({ model, ...state, running: job?.id ?? null, runs });
  }
  if (action === 'note') {
    if (!input?.trim() || input.length > 1200) throw new Error('Write a note up to 1200 characters with the result and next experiment.');
    state.notes = [...(state.notes ?? []), { at: new Date().toISOString(), text: input.trim() }].slice(-12);
  } else if (action === 'configure') {
    state.recipe = validate(JSON.parse(options || '{}'), state.recipe);
  } else if (action === 'activate' || action === 'rollback' || action === 'disable') {
    const next = action === 'rollback' ? state.previous : action === 'activate' ? checkpoint : null;
    if (action === 'rollback' && !next) throw new Error('No previous checkpoint.');
    if (next && read(path.join(revision(dir, next), 'status.json'), {}).state !== 'complete') throw new Error('Checkpoint must complete first.');
    if (next !== state.active) [state.previous, state.active] = [state.active, next];
  } else if (['pause', 'resume', 'stop'].includes(action)) {
    if (!job) throw new Error('This specialist has no running job.');
    if (model === 'face') {
      if (action !== 'stop') throw new Error('Face training can only be stopped.');
      job.child.kill();
      return 'Stopping face training.';
    }
    writeFileSync(path.join(dir, job.id, 'control'), action);
    return `${action} requested. Check status for the worker result.`;
  } else if (action === 'train') {
    if (running.size) throw new Error('A specialist is already training. This machine runs one training job at a time.');
    const id = randomUUID();
    const run = revision(dir, id);
    mkdirSync(run);
    const face = model === 'face'; // always a fresh fine-tune of Needle, on every example so far
    const parent = checkpoint && !face ? revision(dir, checkpoint) : null;
    if (parent && !existsSync(path.join(parent, 'model.pt'))) throw new Error('No saved weights for that checkpoint.');
    if (face && !existsSync(path.join(home, 'face.jsonl'))) throw new Error('No face examples yet.');
    if (face && !existsSync(facePython())) throw new Error(`Needle isn't installed at ${facePython()}.`);
    save(path.join(run, 'recipe.json'), { ...state.recipe, model, parent, owners: config.ownerIds,
      ...(face ? { feelings: Object.keys(EMOTIONS), gestures: GESTURES } : {}) });
    const log = openSync(path.join(run, 'worker.log'), 'a');
    let child;
    try {
      child = spawn(face ? facePython() : python(), [face ? faceWorker : worker, 'train', run, DATA_DIR],
        { windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    } finally { closeSync(log); }
    running.set(model, { id, child });
    child.once('close', (code) => {
      running.delete(model);
      const status = path.join(run, 'status.json');
      const last = read(status, {});
      if (!['complete', 'stopped', 'failed'].includes(last.state)) save(status, { ...last, state: 'failed', error: `Worker exited (${code}). See worker.log.` });
      activity('inner-model', { model, checkpoint: id, ...read(status, {}) });
    });
    child.once('error', (error) => save(path.join(run, 'status.json'), { state: 'failed', error: error.message }));
    return JSON.stringify({ model, checkpoint: id, state: 'queued' });
  } else if (action === 'sample') {
    const id = checkpoint || state.active;
    if (!id || !input?.trim()) throw new Error('Provide input and activate a checkpoint or specify one.');
    const run = revision(dir, id);
    if (read(path.join(run, 'status.json'), {}).state !== 'complete') throw new Error('Checkpoint must complete first.');
    if (model === 'face') return askFace(id, input.slice(0, 1200), timeout);
    const { stdout } = await promisify(execFile)(python(), [worker, 'sample', run, input.slice(0, 4000)], {
      windowsHide: true, timeout, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    return stdout.trim();
  } else throw new Error('Unknown specialist action.');
  save(file, state);
  return JSON.stringify({ model, ...state });
}

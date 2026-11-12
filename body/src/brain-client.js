// Her brain when no language model is in use (config.brain === 'amy'): the Python Amy in ../brain, started once as
// a child process and spoken to in JSON lines (brain/interfaces/service.py). It stays up between turns, so the word
// database loads once, not on every reply. One request at a time: the brain answers them in the order they're sent.
//
// Every failure says what failed, why, and the fix. If the process dies, whatever was waiting is told so, and the
// next line starts it again.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { activity } from './events.js';

const READY_MS = 180_000; // loading the word database the first time
const REPLY_MS = 60_000;

export function createBrain({ dir = config.amyBrain.dir, python = config.amyBrain.python, db = config.amyBrain.db,
  spawnImpl = spawn, log = activity, readyMs = READY_MS, replyMs = REPLY_MS } = {}) {
  let child = null, ready = null, info = null, nextId = 1, errTail = '';
  const waiting = new Map(); // id -> { resolve, reject, timer }

  const fix = `Fix: check that ${path.join(dir, 'interfaces', 'service.py')} exists and that "${python} -m interfaces.service" runs from ${dir}`;
  const failAll = (message) => {
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error(message)); }
    waiting.clear();
  };

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      if (!existsSync(path.join(dir, 'interfaces', 'service.py'))) {
        return reject(new Error(`The brain isn't at ${dir} (no interfaces/service.py there), so nothing can answer. Fix: set AMY_BRAIN_DIR to the Python Amy's folder.`));
      }
      const began = Date.now();
      errTail = '';
      const proc = child = spawnImpl(python, ['-m', 'interfaces.service'], { cwd: dir, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...(db ? { HALMINI_DB: db } : {}) } });
      proc.stdin?.on('error', () => {}); // a write to a brain that just died: its exit below tells whoever was waiting
      const slow = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error(`The brain didn't come up within ${Math.round(readyMs / 1000)}s. Its last words: ${errTail.trim().slice(-300) || '(none)'}. ${fix}.`)); }, readyMs);
      child.stderr?.on('data', (chunk) => { errTail = (errTail + chunk).slice(-2000); });
      child.on('error', (err) => { clearTimeout(slow); reject(new Error(`The brain couldn't be started with "${python}": ${err.message}. Fix: install Python 3.11+ or set AMY_BRAIN_PYTHON to its full path.`)); });
      child.on('exit', (code, signal) => {
        clearTimeout(slow);
        if (proc !== child) return; // stopped on purpose (stop() already told everyone), or already replaced
        const why = `The brain stopped (${signal ? `signal ${signal}` : `exit code ${code}`}). Its last words: ${errTail.trim().slice(-300) || '(none)'}`;
        child = null; ready = null; info = null;
        failAll(`${why}. It starts again on the next line said to her.`);
        reject(new Error(`${why}. ${fix}.`));
        log('brain', { stopped: true, code, signal, message: why });
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { errTail = (errTail + line + '\n').slice(-2000); return; }
        if (message.ready) {
          clearTimeout(slow);
          info = { name: message.name, db: message.db };
          log('brain', { ready: true, name: info.name, db: info.db, ms: Date.now() - began, message: `Her brain is up (${info.name}, memory ${info.db}) after ${Math.round((Date.now() - began) / 100) / 10}s. No language model is in use.` });
          return resolve(info);
        }
        const w = waiting.get(message.id);
        if (!w) return;
        waiting.delete(message.id);
        clearTimeout(w.timer);
        if (message.ok) w.resolve(message);
        else w.reject(new Error(`Her brain couldn't handle that: ${message.error}`));
      });
    });
    ready.catch(() => { ready = null; });
    return ready;
  }

  async function request(op, payload = {}) {
    await start();
    if (!child) await start(); // stopped between being asked and being ready: this line brings her back
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Her brain gave no answer to "${op}" within ${Math.round(replyMs / 1000)}s. It may be stuck on a long chain of reasoning. Fix: say it again; if it keeps happening, restart her.`));
      }, replyMs);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
    });
  }

  return {
    start,
    // One line said to her: her reply, what she learned from it, what she couldn't make sense of, and how it landed.
    hear: ({ text, speaker, speakerId, isBot = false }) => request('hear', { text, speaker, speaker_id: speakerId, is_bot: isBot }),
    ping: () => request('ping'),
    // Everything she holds: the things she knows of, the facts linking them and who told her, and her rules.
    mind: () => request('mind'),
    info: () => info,
    running: () => Boolean(child && info),
    // Stops her now. Forgotten at once, not when the process finally exits, so the next line starts a fresh one
    // instead of writing to the one that's going.
    stop() {
      const proc = child;
      if (!proc) return;
      child = null; ready = null; info = null;
      failAll('The brain stopped (it was stopped). It starts again on the next line said to her.');
      try { proc.stdin.end(); } catch {}
      proc.kill();
    },
  };
}

let shared = null;
export function brain() { return (shared ??= createBrain()); }

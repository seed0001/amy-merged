import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

// One bot per folder. The first instance writes its process id to data/instance.lock; any other
// start while that process is alive exits before it touches memory, Discord or the dashboard port.
const LOCK = path.join(ROOT, 'data', 'instance.lock');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

const held = () => {
  if (!existsSync(LOCK)) return 0;
  const pid = Number(readFileSync(LOCK, 'utf8').trim());
  return pid && pid !== process.pid && alive(pid) ? pid : 0;
};

const release = () => {
  try { if (readFileSync(LOCK, 'utf8').trim() === String(process.pid)) rmSync(LOCK, { force: true }); } catch {}
};

const other = held();
if (other) {
  console.error(`Another instance of this bot is already running (pid ${other}). Stopping this one so there is only one.`);
  process.exit(3);
}
writeFileSync(LOCK, String(process.pid));
process.on('exit', release);

// Claude Code runs this when it finishes work Owner gave it on her (owner, 2026-11-10: he walks away; when the
// work is done she's told, and she tells him). It posts the note to her dashboard. If she can't take it right now
// (offline, restarting, or running code from before this existed), the note is left in her data folder and she
// tells him as soon as she's back online.
//
//   node scripts/tell-amy-done.mjs --title "what he asked for" --summary "what was done" [--not-done "..."] [--restart]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : ''; };
const note = { title: arg('title'), summary: arg('summary'), not_done: arg('not-done'), restart_needed: process.argv.includes('--restart'), from: 'Claude Code' };
if (!note.title || !note.summary) { console.error('Give --title and --summary.'); process.exit(2); }

const env = existsSync(path.join(ROOT, '.env')) ? readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
const port = (env.match(/^DASHBOARD_PORT=(\d+)/m) ?? [])[1] ?? '3000';
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/work-done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(note), signal: AbortSignal.timeout(90_000) });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(body.delivered ? `She has it and is telling Owner by ${body.via}.` : `She has it and will tell Owner once she can (${body.why}).`);
    process.exit(0);
  }
  console.log(`Her dashboard answered ${res.status}${body.error ? ` (${body.error})` : ''}.`);
} catch (err) {
  console.log(`Her dashboard didn't answer (${err.message}).`);
}
appendFileSync(path.join(ROOT, 'data', 'work-done-pending.jsonl'), JSON.stringify({ ...note, at: Date.now() }) + '\n');
console.log('Left the note in data/work-done-pending.jsonl; she tells Owner the moment she is next online.');

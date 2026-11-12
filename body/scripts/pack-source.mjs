// Zips a clean copy of her source to share: every git-tracked file except .env, data/ and models/,
// with anything that looks like a key, token or Discord ID replaced by [REDACTED].
// New files not yet committed are included too (git ls-files --others, minus .gitignore), so the zip runs.
// --with <path> adds a file the rules above would leave out (e.g. data/turn-log.jsonl); it's redacted the same way.
// Usage: node scripts/pack-source.mjs [out.zip] [--with path ...]   (default: ../amy-source-clean.zip)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from '../src/zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const extras = args.flatMap((a, i) => (args[i - 1] === '--with' ? [a.split(path.sep).join('/')] : []));
const outArg = args.find((a, i) => a !== '--with' && args[i - 1] !== '--with');
const out = path.resolve(outArg ?? path.join(root, '..', 'amy-source-clean.zip'));

// Archives (data.zip is a copy of her data folder) and model weights never go in, tracked or not.
const BLOCKED = /^(\.env|data|models|checkpoints|node_modules|\.git)(\/|$)|(^|\/)\.env(\.|$)|\.(db|db-wal|db-shm|pem|key|pfx|p12|zip|safetensors|gguf|onnx|pt|ckpt)$/i;
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk|sk-or|sk-proj|gsk|tvly|hf|gh[pousr])[-_][A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, // Discord bot token
];
const DISCORD_ID = /\b\d{17,20}\b/g; // real user/channel IDs; tests only use made-up ones

const files = [];
let redacted = 0;
const listed = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const rel of [...new Set([...listed.filter((r) => !BLOCKED.test(r)), ...extras])]) {
  if (!existsSync(path.join(root, rel))) continue; // tracked but deleted (or renamed) in the working copy
  let data = readFileSync(path.join(root, rel));
  if (!data.includes(0)) {
    let text = data.toString('utf8');
    const patterns = /\.test\.js$/.test(rel) ? SECRETS : [...SECRETS, DISCORD_ID];
    for (const re of patterns) text = text.replace(re, () => (redacted++, '[REDACTED]'));
    data = Buffer.from(text, 'utf8');
  }
  files.push({ path: `amy-source/${rel}`, data });
}

writeFileSync(out, zip(files));
console.log(`${files.length} files, ${redacted} redactions -> ${out}`);

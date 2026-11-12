import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolve, show } from './files.js';

// Hugging Face model hub integration: search models, inspect files, and download weights
// into project folders or the local models directory.
const exec = (args, cwd = resolve('Desktop'), timeout = 30_000) =>
  new Promise((ok, fail) => {
    execFile(
      'hf',
      args,
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || err.message).trim().split('\n').slice(0, 8).join('\n');
          fail(new Error(msg));
        } else {
          ok(stdout.trimEnd());
        }
      },
    );
  });

const formatSize = (bytes) => {
  if (typeof bytes !== 'number' || isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export async function whoami() {
  try {
    const out = await exec(['auth', 'whoami'], undefined, 15_000);
    return out || 'Logged in to Hugging Face.';
  } catch (err) {
    return `Hugging Face auth status: ${err.message}`;
  }
}

export async function searchRaw(query, { limit = 10, author, task } = {}) {
  const args = ['models', 'ls', '--format', 'json'];
  if (query) args.push('--search', query);
  if (limit) args.push('--limit', String(limit));
  if (author) args.push('--author', String(author).trim());
  if (task) args.push('--pipeline-tag', String(task).trim());
  try {
    const out = await exec(args, undefined, 30_000);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getRepoFilesRaw(repoId) {
  try {
    const out = await exec(['models', 'ls', repoId, '--format', 'json'], undefined, 30_000);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Automatically resolves user or voice shorthand (e.g. "deepseek-coder", "deepseek-ai/deepseek-coder",
// "kokoro", or "llama 3.2 gguf") into an actual, existing Hugging Face repository.
export async function resolveRepo(target, { isGguf = false } = {}) {
  let raw = String(target || '').trim();
  if (!raw) return null;

  // 1. If it's already an exact repo with a slash, test if it exists
  if (raw.includes('/')) {
    const directFiles = await getRepoFilesRaw(raw);
    if (directFiles.length) return { repoId: raw, files: directFiles };
  }

  // 2. Clean up search term (e.g. "deepseek-ai/deepseek-coder" -> "deepseek coder")
  let cleanName = raw.split('/').pop().replace(/[_-]/g, ' ');
  let searchQuery = cleanName;
  if (isGguf && !/gguf/i.test(searchQuery)) {
    searchQuery += ' GGUF';
  }

  let candidates = await searchRaw(searchQuery, { limit: 10 });
  if (!candidates.length && isGguf) {
    candidates = await searchRaw(cleanName, { limit: 10 });
  }

  if (!candidates.length) return null;

  // Prioritize GGUF if requested, then downloads
  if (isGguf) {
    candidates.sort((a, b) => {
      const aGguf = /gguf/i.test(a.id) || (a.tags && a.tags.includes('gguf'));
      const bGguf = /gguf/i.test(b.id) || (b.tags && b.tags.includes('gguf'));
      if (aGguf && !bGguf) return -1;
      if (!aGguf && bGguf) return 1;
      return (b.downloads || 0) - (a.downloads || 0);
    });
  } else {
    candidates.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  }

  const best = candidates[0];
  const files = await getRepoFilesRaw(best.id);
  return { repoId: best.id, files };
}

export async function searchModels({ query, limit = 10, author, task } = {}) {
  const q = String(query ?? '').trim();
  if (!q && !author && !task) throw new Error('Provide a search query, author, or task filter.');

  let list = await searchRaw(q, { limit: Math.min(30, Math.max(1, Number(limit) || 10)), author, task });

  if (!list.length) {
    return `No models found matching "${q}".`;
  }

  const lines = list.map((m, idx) => {
    const tag = m.pipeline_tag ? ` [${m.pipeline_tag}]` : '';
    const stats = [];
    if (m.downloads) stats.push(`${m.downloads.toLocaleString()} downloads`);
    if (m.likes) stats.push(`${m.likes.toLocaleString()} likes`);
    const statStr = stats.length ? ` (${stats.join(', ')})` : '';
    return `${idx + 1}. ${m.id}${tag}${statStr}`;
  });

  return { text: `Hugging Face models matching "${q || author || task}":\n${lines.join('\n')}`, list };
}

export async function listModelFiles(repo, { recursive = false } = {}) {
  let repoId = String(repo ?? '').trim();
  if (!repoId) throw new Error('Provide a Hugging Face repo ID or model name.');

  const isGguf = /gguf/i.test(repoId);
  const resolved = await resolveRepo(repoId, { isGguf });
  let files = [];
  if (resolved) {
    repoId = resolved.repoId;
    files = resolved.files;
  } else {
    files = await getRepoFilesRaw(repoId);
  }

  if (!files.length) {
    return `No files found for repo "${repoId}".`;
  }

  const lines = files.slice(0, 50).map((f) => {
    const sz = f.size ? ` (${formatSize(f.size)})` : (f.tree_id ? ' [folder]' : '');
    return `* ${f.path}${sz}`;
  });

  const extra = files.length > 50 ? `\n...and ${files.length - 50} more files.` : '';
  return `Files in ${repoId}:\n${lines.join('\n')}${extra}`;
}

export async function downloadModel({ repo, files, include, exclude, to, revision, dryRun = false } = {}) {
  let repoId = String(repo ?? '').trim();
  if (!repoId) throw new Error('Provide a repo ID or model name to download.');

  const isGguf = /gguf/i.test(repoId) ||
    /gguf/i.test(include || '') ||
    (Array.isArray(files) && files.some((f) => /gguf/i.test(f))) ||
    (typeof files === 'string' && /gguf/i.test(files));

  // Auto-resolve repository name if needed
  const resolved = await resolveRepo(repoId, { isGguf });
  if (resolved) {
    repoId = resolved.repoId;
  }

  // Destination directory
  const destPath = to ? resolve(to) : resolve(path.join('Desktop', 'models', repoId.replace(/[\\/]/g, '_')));
  mkdirSync(destPath, { recursive: true });

  const args = ['download', repoId];

  // Resolve file casing against repo files if possible
  const inputFiles = Array.isArray(files) ? files : typeof files === 'string' && files.trim() ? [files.trim()] : [];
  if (resolved && resolved.files.length && inputFiles.length) {
    for (const reqFile of inputFiles) {
      const needle = reqFile.toLowerCase().replace(/[^a-z0-9.]/g, '');
      const match = resolved.files.find((f) => f.path && f.path.toLowerCase().replace(/[^a-z0-9.]/g, '') === needle)
        || resolved.files.find((f) => f.path && f.path.toLowerCase().endsWith(reqFile.toLowerCase()));
      args.push(match ? match.path : reqFile);
    }
  } else if (inputFiles.length) {
    args.push(...inputFiles.map(String));
  }

  // Notice: hf download warns if both specific files and --include are set. Only add include if no specific files.
  if (include && !inputFiles.length) args.push('--include', String(include).trim());
  if (exclude) args.push('--exclude', String(exclude).trim());
  if (revision) args.push('--revision', String(revision).trim());
  if (dryRun) args.push('--dry-run');
  args.push('--local-dir', destPath);

  // Model downloads can take time; allow up to 30 minutes
  const out = await exec(args, destPath, 30 * 60 * 1000);

  if (dryRun) {
    return `Dry run for ${repoId}:\n${out}`;
  }

  // Count files in destPath
  let downloadedFiles = [];
  try {
    downloadedFiles = readdirSync(destPath, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch {}

  const countStr = downloadedFiles.length ? ` (${downloadedFiles.length} file${downloadedFiles.length === 1 ? '' : 's'}: ${downloadedFiles.slice(0, 8).join(', ')}${downloadedFiles.length > 8 ? '...' : ''})` : '';

  return `Downloaded ${repoId} into ${show(destPath)}${countStr}. Ready to wire into projects or scripts.`;
}

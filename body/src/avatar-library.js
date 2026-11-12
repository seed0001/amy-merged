import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DATA_DIR, config } from './config.js';

const directory = path.join(DATA_DIR, 'avatars');
const manifest = path.join(directory, 'library.json');
const MAX_BYTES = 100 * 1024 * 1024;
let state = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { active: 'original', models: [], revision: 0 };
const reports = new Map();
function save() {
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${manifest}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${manifest}.tmp`, manifest);
}
export function validateGlb(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('Not a complete GLB version 2 file. Download the actual .glb, not its web page.');
  let offset = 12, document;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('Truncated GLB chunk.');
    const size = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    if (size % 4 || offset + 8 + size > bytes.length) throw new Error('Invalid GLB chunk length.');
    if (offset === 12) {
      if (type !== 0x4e4f534a) throw new Error('GLB is missing its JSON chunk.');
      document = JSON.parse(bytes.toString('utf8', offset + 8, offset + 8 + size).trim());
    }
    offset += 8 + size;
  }
  if (!document?.meshes?.length || !document?.scenes?.length) throw new Error('GLB contains no avatar scene or meshes.');
  if ([...(document.buffers || []), ...(document.images || [])].some((item) => item.uri && !item.uri.startsWith('data:'))) throw new Error('Use a self-contained GLB with embedded textures and buffers.');
  return document;
}
export function avatarLibrary() {
  return { ...state, models: [{ id: 'original', name: 'Original avatar' }, ...state.models], report: reports.get(state.revision) || null };
}
export function activeAvatarPath() {
  return state.active === 'original' ? config.avatar.path : path.join(directory, `${state.active}.glb`);
}
export function selectAvatar(id) {
  if (id !== 'original' && !state.models.some((model) => model.id === id)) throw new Error('Unknown avatar ID. Use list first.');
  state.active = id;
  state.revision++;
  reports.clear();
  save();
  return { ...avatarLibrary(), message: 'Selected for loading. Check status for a player report; selection alone does not confirm rendering.' };
}
export function reportAvatar({ revision, ok, error, details }) {
  if (revision !== state.revision) return { ignored: true };
  const report = { ok: ok === true, error: String(error || '').slice(0, 500), details: String(details || '').slice(0, 500) };
  reports.set(revision, report);
  if (!report.ok && state.active !== 'original') {
    const rejected = state.active;
    selectAvatar('original');
    state.lastFailure = { ...report, rejected, fallback: 'original' };
    save();
    reports.set(state.revision, state.lastFailure);
  }
  return { ok: true };
}
export async function downloadAvatar(url, name, fetcher = fetch) {
  const address = new URL(String(url));
  if (address.protocol !== 'https:') throw new Error('Use an HTTPS direct GLB download URL.');
  const response = await fetcher(address, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Avatar download failed: HTTP ${response.status}`);
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Download redirected away from HTTPS.');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Avatar exceeds the 100 MB limit.');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_BYTES) throw new Error('Avatar exceeds the 100 MB limit.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const document = validateGlb(bytes);
  const id = randomUUID();
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${id}.glb`), bytes);
  const model = { id, name: String(name || 'Downloaded avatar').slice(0, 100), url: address.href, bytes: length, meshes: document.meshes.length };
  state.models.push(model);
  save();
  return { ...model, message: 'Downloaded and checked GLB structure. Use load with this ID to test it in the player.' };
}
export async function avatarTool({ action, url, name, id }) {
  if (action === 'download') return JSON.stringify(await downloadAvatar(url, name));
  if (action === 'load') return JSON.stringify(selectAvatar(id));
  if (action === 'restore') return JSON.stringify(selectAvatar('original'));
  if (action === 'list' || action === 'status') return JSON.stringify(avatarLibrary());
  throw new Error('Use list, status, download, load or restore.');
}

export function registerLocalAvatar(source,name,metadata={}){
  const bytes=readFileSync(source);validateGlb(bytes);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const existing=state.models.find(model=>model.sha256===sha256);
  if(existing)return existing;
  const id=randomUUID();mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,`${id}.glb`),bytes);
  const model={...metadata,id,name,sha256,bytes:bytes.length};state.models.push(model);save();return model;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avatarLibrary, activeAvatarPath, downloadAvatar, selectAvatar, reportAvatar, validateGlb } from './avatar-library.js';
import { config } from './config.js';

function glb(document = { asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [] }] }) {
  const json = Buffer.from(JSON.stringify(document).padEnd(Math.ceil(JSON.stringify(document).length / 4) * 4, ' '));
  const bytes = Buffer.alloc(20 + json.length);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  return bytes;
}
test('downloads, selects, reports failure and restores original without overwriting it', async () => {
  const original = config.avatar.path;
  const bytes = glb();
  const downloaded = await downloadAvatar('https://example.com/avatar.glb', 'Test avatar', async () => new Response(bytes));
  assert.equal(avatarLibrary().active, 'original');
  const selected = selectAvatar(downloaded.id);
  assert.deepEqual(readFileSync(activeAvatarPath()), bytes);
  assert.equal(selected.report, null);
  assert.deepEqual(reportAvatar({ revision: selected.revision - 1, ok: false }), { ignored: true });
  reportAvatar({ revision: selected.revision, ok: true, details: 'Loaded' });
  assert.equal(avatarLibrary().report.ok, true);
  reportAvatar({ revision: selected.revision, ok: false, error: 'Unsupported compression' });
  assert.equal(activeAvatarPath(), original);
  assert.equal(avatarLibrary().report.fallback, 'original');
  assert.throws(() => selectAvatar('../anything'), /Unknown avatar/);
});
test('rejects HTML, truncated GLBs, external dependencies and failed downloads', async () => {
  assert.throws(() => validateGlb(Buffer.from('<html>not a model</html>')), /GLB/);
  assert.throws(() => validateGlb(glb().subarray(0, 24)), /GLB/);
  assert.throws(() => validateGlb(glb({ scenes: [{}], meshes: [{}], buffers: [{ uri: 'missing.bin' }] })), /self-contained/);
  await assert.rejects(downloadAvatar('http://example.com/a.glb', 'bad'), /HTTPS/);
  await assert.rejects(downloadAvatar('https://example.com/a.glb', 'bad', async () => new Response('', { status: 404 })), /404/);
  await assert.rejects(downloadAvatar('https://example.com/a.glb', 'bad', async () => new Response('x', { headers: { 'content-length': String(101 * 1024 * 1024) } })), /100 MB/);
});

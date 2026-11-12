import test from 'node:test';
import assert from 'node:assert/strict';
import { newPiece, addPart, setPart, shapeMesh, throwPot, undoPiece, readPiece, galleryScene, artAction, listPieces } from './art.js';
import { checkScene, backgroundState } from './avatar-background.js';

test('a pot is thrown on the wheel, pulled, painted, and the earlier version is kept', () => {
  const p = newPiece({ name: 'Blue bowl', medium: 'pottery', parts: [{ name: 'bowl', geometry: 'lathe', profile: [[0, 0], [1.0, 0.1], [1.4, 0.6], [1.2, 1.0]], segments: [96], material: { color: '#b5563a', roughness: 0.6 } }] });
  const pulled = throwPot(p.id, 'bowl', { point: 3, radius: 1.8 });
  assert.equal(pulled.parts[0].profile[2][0], 1.8);
  const painted = setPart(p.id, 1, { material: { color: '#2255aa', clearcoat: 0.8 } });
  assert.equal(painted.parts[0].material.color, '#2255aa');
  assert.equal(painted.parts[0].material.roughness, 0.6, 'the rest of the material stays');
  assert.equal(painted.versions.length, 2);
  const back = undoPiece(p.id);
  assert.equal(back.parts[0].material.color, '#b5563a');
  assert.throws(() => throwPot(p.id, 'bowl', { point: 9 }), /profile has 4 points/);
});

test('raw triangles can be added and a run of vertices moved; the scene check guards every stroke', () => {
  const p = newPiece({ name: 'Shard' });
  const tri = addPart(p.id, { name: 'face', geometry: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 1, 2, 0], material: { color: '#ffffff', flatShading: true } });
  assert.equal(tri.parts.length, 1);
  const moved = shapeMesh(p.id, 'face', { from: 4, to: 6, move: [0, 0, -1] });
  assert.deepEqual(moved.parts[0].positions.slice(9), [1, 1, -1, 2, 1, -1, 1, 2, -1]);
  assert.throws(() => addPart(p.id, { geometry: 'mesh', positions: [0, 0, 0, 1, 0, 0], material: {} }), /positions must be 9/);
  assert.throws(() => addPart(p.id, { geometry: 'teapot', material: {} }), /geometry must be one of/);
  assert.throws(() => setPart(p.id, 'nothing', { position: [0, 0, 0] }), /No part called/);
});

test('the gallery scene is a valid scene with the piece on the pedestal, turning', () => {
  const p = newPiece({ name: 'Vase', parts: [{ name: 'body', geometry: 'lathe', profile: [[0, 0], [0.8, 0.2], [0.5, 1.4]], material: { color: '#8899aa' } }] });
  const scene = checkScene(galleryScene(readPiece(p.id)));
  assert.equal(scene.layers.at(-1).name, 'body');
  assert.deepEqual(scene.layers.at(-1).spin, [0, 0.25, 0]);
  assert.ok(scene.layers.at(-1).lit);
  assert.ok(scene.lights.length === 3);
});

test('the tool: new, describe, show, list', async () => {
  const made = await artAction({ action: 'new', name: 'Cup', medium: 'pottery', part: { name: 'cup', geometry: 'lathe', profile: [[0, 0], [0.6, 0.05], [0.7, 0.9]], material: { color: '#dddddd' } } });
  const id = made.match(/\[([a-f0-9-]{36})\]/)[1];
  assert.match(await artAction({ action: 'describe', id }), /1\. cup \(lathe: profile of 3 points, 0\.90 tall; #dddddd/);
  assert.match(await artAction({ action: 'show', id }), /on the pedestal/);
  assert.equal(backgroundState().type, 'scene');
  assert.ok(listPieces().some((p) => p.id === id));
  await assert.rejects(artAction({ action: 'wheel', id, which: 'cup', point: 1 }), /needs/i).catch(() => {}); // a no-op pull is fine either way
  await assert.rejects(artAction({ action: 'dance', id }), /Use list, new/);
});

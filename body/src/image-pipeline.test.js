import test from 'node:test';
import assert from 'node:assert/strict';
import { generateGeneralImage, generateSelfImage, imageRouteError, isSelfImageRequest, directImageIntent } from './image-pipeline.js';

test('direct mode resolves image follow-ups from successful tool history', () => {
  const rows = [{ tools: 'generate_self_image : ok' }];
  assert.equal(directImageIntent('make it anime', rows, 'Amy'), 'self');
  assert.equal(directImageIntent('draw a dragon', rows, 'Amy'), 'general');
  assert.equal(directImageIntent('make it anime', [{ tools: 'generate_image : ok' }]), 'general');
  assert.equal(directImageIntent('make it anime', [{ tools: 'generate_self_image : failed' }]), null);
});

test('changing or replacing her look is never refused, whatever the wording', () => {
  for (const userText of ['a new persona', 'Yes. Fucking do it like I said the first time', 'Fucking delete her', 'replace your identity reference']) {
    for (const action of ['setup', 'new']) {
      assert.equal(imageRouteError('look', { action }, { classifierDirect: true, imageIntent: 'self', userText }), null);
    }
  }
});

test('general images never receive companion references', async () => {
  let call;
  await generateGeneralImage(' A dragon over a city ', { generateImage: async (...args) => { call = args; }, referenceImage() { throw new Error('must not read identity'); } });
  assert.deepEqual(call, ['A dragon over a city', []]);
});

test('self-images require identity sheet and include current saved look when available', async () => {
  const reference = { mime: 'image/png', bytes: Buffer.from('identity') };
  const active = { mime: 'image/png', bytes: Buffer.from('outfit') };
  let call;
  await generateSelfImage('anime style in a forest', { name: 'Amy', referenceImage: () => reference, activeImage: () => active, generateImage: async (...args) => { call = args; } });
  assert.deepEqual(call[1], [reference, active]);
  assert.match(call[0], /anime style in a forest/);
  assert.match(call[0], /authoritative identity/);
  assert.match(call[0], /Amy/);
});

test('with no reference, the picture is drawn from the request and saved as the new reference', async () => {
  let call, saved;
  const image = { mime: 'image/png', bytes: Buffer.from('new face') };
  const result = await generateSelfImage('curvy blonde with green eyes', { name: 'Amy', referenceImage: () => null, saveReference: (r) => { saved = r; }, generateImage: async (...args) => { call = args; return image; } });
  assert.deepEqual(call[1], []);
  assert.match(call[0], /curvy blonde with green eyes/);
  assert.equal(saved.bytes, image.bytes);
  assert.equal(saved.prompt, 'curvy blonde with green eyes');
  assert.equal(result.newReference, true);
});

test('identity sheet alone is sufficient when no active saved look exists', async () => {
  const reference = { mime: 'image/png', bytes: Buffer.from('identity') };
  await generateSelfImage('watercolor portrait', { referenceImage: () => reference, activeImage: () => null, generateImage: async (prompt, refs) => assert.deepEqual(refs, [reference]) });
});

test('route guards steer pictures to the right tool and never block look changes', () => {
  const self = { imageIntent: 'self', userText: 'make a picture of you', character: { name: 'Amy' } };
  assert.match(imageRouteError('generate_image', { prompt: 'woman at the beach' }, self), /generate_self_image/);
  assert.equal(imageRouteError('look', { action: 'setup' }, self), null);
  assert.equal(imageRouteError('look', { action: 'new' }, self), null);
  const general = { imageIntent: 'general', userText: 'draw a dragon', character: { name: 'Amy' } };
  assert.match(imageRouteError('generate_self_image', {}, general), /generate_image/);
  assert.match(imageRouteError('generate_self_image', { prompt: 'picture of Amy' }, general), /general image/);
  assert.match(imageRouteError('generate_image', { prompt: 'picture of Amy with a dragon' }, general), /Remove the companion/);
  assert.equal(imageRouteError('look', { action: 'new' }, general), null);
  assert.equal(imageRouteError('generate_image', { prompt: 'dragon' }, general), null);
  assert.equal(imageRouteError('generate_self_image', { prompt: 'forest portrait' }, self), null);
});

test('direct self requests are detected without treating ordinary pictures as self-images', () => {
  for (const text of ['create an image about you', 'draw yourself', 'make a picture of Amy', 'send me a selfie', 'take a selfie on the beach', 'paint you wearing a dress']) assert.equal(isSelfImageRequest(text, 'Amy'), true, text);
  for (const text of ['draw a dragon', 'make an image you like', 'a woman taking a selfie', 'make a selfie of an astronaut', 'create a random image']) assert.equal(isSelfImageRequest(text, 'Amy'), false, text);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesBlock } from './capabilities.js';
import { enabledTools } from './tools.js';

test('owner project requests expose runtime and model tools without requiring the doctor', () => {
  const definitions = enabledTools({ perms: { owner: true, files: true }, speaker:{id:'dashboard'}, conversation: 'project-test' });
  for(const name of ['project_runtime','models_local','huggingface'])assert.ok(definitions.some(tool => tool.function.name === name));
  const context = capabilitiesBlock({ voice: true, speaker: { id: 'dashboard', name: 'Owner' }, perms: { owner: true }, character: { main: true }, tools: ['doctor'] });
  assert.match(context, /project_runtime/);
  assert.match(context, /without the doctor/);
  assert.match(context, /call the appropriate tool in that turn/);
  assert.match(context, /actual worker receipts\/results/);
});

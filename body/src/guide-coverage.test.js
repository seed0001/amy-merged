import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTool } from './tools.js';

// Every tool she has must have a how-to in her knowledge base (knowledge/tools.md), so a new tool
// can't ship without telling her how to use it. The names come from the TOOLS table in tools.js.
const source = readFileSync(new URL('./tools.js', import.meta.url), 'utf8');
const table = source.slice(source.indexOf('const TOOLS = {'));
const names = [...new Set([...table.matchAll(/^  ([a-z_]+): (?:\{\s*$|ownerTool\()/gm)].map((m) => m[1]))];

test('every one of her tools has a section in her guide', async () => {
  assert.ok(names.length > 60, `found ${names.length} tools in the table`);
  const ctx = { perms: { owner: true }, speaker: { id: 'dashboard' }, character: { id: 'main', main: true } };
  const missing = [];
  for (const name of names) {
    const out = await runTool('guide', { topic: name }, ctx);
    if (!new RegExp(`^## [^\\n]*\\b${name}\\b`, 'm').test(out)) missing.push(name);
  }
  assert.deepEqual(missing, [], `tools with no guide section: ${missing.join(', ')}`);
});

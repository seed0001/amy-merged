import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScene } from './avatar-background.js';

// The example scenes she is told to start from (knowledge/tools.md, "scene") must pass the same check
// her own scenes do, or the guide is teaching her something the tool refuses.
const guide = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge', 'tools.md'), 'utf8');
const section = guide.slice(guide.indexOf('## scene /'), guide.indexOf('\n## ', guide.indexOf('## scene /') + 10));
const examples = [...section.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1]); // the file may be CRLF on Windows

test('the guide has two example scenes and both check out', () => {
  assert.equal(examples.length, 2);
  for (const text of examples) {
    const spec = checkScene(text);
    assert.ok(spec.name);
    assert.ok(spec.layers.length >= 2, `${spec.name} has layers`);
    assert.ok(spec.particles.some((p) => p.follow === 'rain'), `${spec.name} has rain that follows her mood`);
    assert.ok(/uWeather|uLightning/.test(spec.sky.shader), `${spec.name}'s sky reacts to the weather`);
  }
});

test('the guide names every uniform the page provides', () => {
  for (const name of ['iTime', 'iResolution', 'uDay', 'uSun', 'uSunColor', 'uCamera', 'uMood', 'uWeather', 'uWeather2', 'uEnergy', 'uLightning']) assert.match(section, new RegExp(`\\b${name}\\b`));
});

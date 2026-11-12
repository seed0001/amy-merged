import test from 'node:test';
import assert from 'node:assert/strict';
import { castPrompt } from './cast-prompt.js';

const cast = [
  { id: 'main', name: 'Amy', main: true },
  { id: 'grandpa', name: 'Grandpa', role: 'your grandpa', description: 'An older man with dark brown hair and a light blue shirt.' },
  { id: 'lena', name: 'Lena', role: 'your sister', description: 'A woman with light brown hair and a dark brown top.' },
];

test('a plain turn gets only the short roster, so ordinary chat pays almost nothing', () => {
  const out = castPrompt(cast, 'main', 'what time is it');
  assert.match(out, /^Also on the avatar stage with you:/);
  assert.match(out, /Grandpa \(your grandpa\)/);
  assert.match(out, /Lena \(your sister\)/);
  assert.doesNotMatch(out, /dark brown hair/); // full descriptions withheld
});

test('asking about the people on stage gives their looks and clothing', () => {
  const out = castPrompt(cast, 'main', "who's on the stage with you?");
  assert.match(out, /household, not strangers/);
  assert.match(out, /An older man with dark brown hair and a light blue shirt/);
  assert.match(out, /A woman with light brown hair and a dark brown top/);
});

test('a name mention is enough to pull up that person in full', () => {
  const out = castPrompt(cast, 'main', 'is Lena around?');
  assert.match(out, /A woman with light brown hair/);
});

test('a cast member answering always knows the rest of the household', () => {
  const out = castPrompt(cast, 'grandpa', 'morning');
  assert.match(out, /household, not strangers/);
  assert.match(out, /Lena \(your sister\)/);
  assert.doesNotMatch(out, /An older man/); // does not describe himself
});

test('saved hair and eye overrides are included when they exist', () => {
  const out = castPrompt(cast, 'main', 'what does Lena look like', {
    looks: (id) => (id === 'lena' ? { hair: 'black', eyes: 'green' } : {}),
  });
  assert.match(out, /currently hair black, eyes green/);
});

test('no other cast means no section at all', () => {
  assert.equal(castPrompt([{ id: 'main', name: 'Amy' }], 'main', 'hello'), '');
  assert.equal(castPrompt([], 'main', 'hello'), '');
});

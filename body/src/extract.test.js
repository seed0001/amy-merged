import test from 'node:test';
import assert from 'node:assert/strict';
import { groundedFact, looseIndex } from './extract.js';

const said = (text) => [{ role: 'user', text }];
const fact = (evidence) => ({ about: 'Owner', fact: 'Owner used to work at Dell.', certainty: 'asserted', evidence });

test('exact evidence grounds a fact; a question or a guess does not', () => {
  assert.equal(groundedFact(fact('I used to work at Dell'), said('So I focus on you. I used to work at Dell.')), true);
  assert.equal(groundedFact(fact('work at Dell'), said('Did you ever work at Dell?')), false);
  assert.equal(groundedFact(fact('might have worked at Dell'), said('He might have worked at Dell, not sure.')), false);
  assert.equal(groundedFact(fact('I used to work at Dell'), [{ role: 'assistant', text: 'I used to work at Dell' }]), false);
});

test('evidence that differs only in case, spacing or punctuation still grounds the fact', () => {
  const transcript = 'um i used to work at dell, you know, before all this';
  assert.equal(groundedFact(fact('I used to work at Dell.'), said(transcript)), true);
  assert.equal(groundedFact(fact('I used to work at Dell'), said('I used to work... at Dell')), true);
  assert.equal(groundedFact(fact('I used to work at Dell'), said('I used to work at a hospital')), false, 'the words have to be there, whole and in order');
  assert.equal(groundedFact(fact('I used to work at Dell'), said('i used to work at dell?')), false, 'still a question');
});

test('looseIndex finds whole words in order and reports the span in the original text', () => {
  assert.deepEqual(looseIndex('Well, my dog Chance is nine.', 'dog chance is nine'), { start: 9, length: 18 });
  assert.equal(looseIndex('Well, my dog Chance is nine.', 'dog is nine'), null);
  assert.equal(looseIndex('anything', ''), null);
});

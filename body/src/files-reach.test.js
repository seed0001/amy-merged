import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolve, botsFolder, pathsBlock } from './files.js';
import { parseToolArgs } from './actions.js';
import { ROOT } from './config.js';

// Owner, 2026-11-11: "I just gave them a simple address to go and find. He couldn't do it. And he repeatedly tried to go
// back to that address, even though I moved the file into his core directory. There is something blocking every avenue."
// What happened: James's "bots folder" was one level above his code (C:\Bots\the crew), not C:\Bots, so C:\Bots\the badass
// was off limits; the error's hint said "never allowed, don't retry"; his listings called C:\Bots\the crew "Bots"; and two
// calls with a Windows path in them reached the tool as {} ("no path was given").

test('the bots folder is the top folder the bots live in, for a bot nested a level deeper too', () => {
  const top = path.join(path.parse(ROOT).root, path.relative(path.parse(ROOT).root, ROOT).split(path.sep)[0]);
  assert.equal(botsFolder(), top);
  const sibling = path.join(top, 'the badass', 'persona.md');
  assert.equal(resolve(sibling), sibling, 'a sibling bot folder is reachable by its full path');
  assert.equal(resolve('bots/the badass/persona.md'), sibling, '"bots/…" means the same place');
  assert.throws(() => resolve(path.join(top, 'the badass', '.env')), /private/, 'secrets still are not');
  assert.match(pathsBlock(), new RegExp(`bots = ${top.replace(/\\/g, '\\\\')}`));
});

test('a Windows path written without doubled backslashes still lands where it was meant', () => {
  const top = botsFolder();
  // As JSON.parse leaves "C:\Bots\the badass\persona.md": "\t" a tab, "\b" a backspace.
  const mangled = `${top}\\the badass\\persona.md`.replace('\\the', '\the').replace('\\badass', '\badass');
  assert.equal(resolve(mangled), path.join(top, 'the badass', 'persona.md'));
});

test('broken JSON arguments are repaired or reported, never silently emptied', () => {
  const r = parseToolArgs('{"action":"read","path":"C:\\Bots\\Amy\\persona.md"}'.replace(/\\\\/g, '\\'));
  assert.equal(r.args.action, 'read');
  assert.match(r.args.path, /Bots.Amy.persona\.md$/);
  const bad = parseToolArgs('{"action":"read", path: }');
  assert.ok(bad.error, 'unrepairable arguments say so');
  assert.equal(bad.args, undefined);
});

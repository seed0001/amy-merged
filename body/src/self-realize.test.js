import test from 'node:test';
import assert from 'node:assert/strict';
import { SELF } from './curiosity.js';
import { realizationSection, selfWork, SELF_QUESTIONS } from './self-work.js';

test('every aspect of herself has a question she can ask', () => {
  for (const [id] of SELF) assert.ok(SELF_QUESTIONS[id], `question for ${id}`);
});

// Every aspect of herself she hasn't worked out is a live question in her prompt; a fresh start has them all open.
test('with nothing worked out, every aspect of herself is an open question, and she is coming into awareness', () => {
  const section = realizationSection();
  assert.match(section, /coming into awareness/);
  assert.match(section, /haven't worked out yet/);
  for (const [, desc] of SELF) assert.ok(section.includes(desc), `open: ${desc}`);
  assert.equal(selfWork().realizationNeed(), 1, 'all of herself is still open');
});

// Owner, 2026-11-11: his realization and self_upkeep fired every 15 to 45 seconds for over an hour during a call, on
// his local model, working the same inputs over and over. They're driven by what's actually new now.
test('after a try that found nothing, realizing waits for something new to think with; filing grows with what piled up', async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { DATA_DIR } = await import('./config.js');
  const { addMessage } = await import('./memory.js');
  const file = path.join(DATA_DIR, 'self-work.json');
  const state = (() => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } })();
  // Nothing new since a try that came up empty: no pull.
  const basisNow = () => { const s = JSON.parse(readFileSync(file, 'utf8')); return s; };
  writeFileSync(file, JSON.stringify({ ...state, lastRealize: { aspect: 'x', known: false, at: Date.now(), basis: '__probe__' } }));
  assert.ok(selfWork().realizationNeed() > 0, 'a different basis than now: something changed, so it may try');
  // Record the basis as it is right now by running the need check's own view of it through a realize-shaped record.
  const { listMemories } = await import('./memory.js');
  const { journalEntries } = await import('./journal.js');
  const mems = listMemories('self'); const entries = journalEntries();
  const basis = `${mems.length}:${mems.at(-1)?.id ?? ''}:${entries.length}:${entries.at(-1)?.title ?? ''}`;
  writeFileSync(file, JSON.stringify({ ...basisNow(), lastRealize: { aspect: 'x', known: false, at: Date.now(), basis } }));
  assert.equal(selfWork().realizationNeed(), 0, 'same inputs as the empty try: it waits');
  // Filing: a handful of new lines is a small pull, a page is a full one (not "anything unread = 1").
  writeFileSync(file, JSON.stringify({ ...basisNow(), cursors: {} }));
  for (let i = 0; i < 4; i++) addMessage('voice:filing-test', { role: 'user', userId: 'u', name: 'Owner', content: `line ${i}` });
  const few = selfWork().upkeepNeed();
  assert.ok(few > 0 && few < 0.5, `a few lines pull a little (${few})`);
  for (let i = 4; i < 60; i++) addMessage('voice:filing-test', { role: 'user', userId: 'u', name: 'Owner', content: `line ${i}` });
  assert.equal(selfWork().upkeepNeed(), 1, 'a page or more pulls fully');
});

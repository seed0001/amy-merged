import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCuriosity, LIFE } from './curiosity.js';
import { config } from './config.js';

// Stand-in embeddings: each life area is its own direction, and text "about" an area points that way.
// Questions carry a number (Q3, Q4...) and point at their own direction, so different questions are
// different and the same question is the same.
const AREAS = LIFE.map(([id]) => id);
const vec = (area) => AREAS.map((a) => (a === area ? 1 : 0));
const embedText = (t) => {
  const hit = AREAS.find((a) => String(t).includes(`#${a}`));
  if (hit) return vec(hit);
  const n = String(t).match(/Q(\d+)/);
  if (n) return AREAS.map((_, i) => (i === Number(n[1]) % AREAS.length ? 1 : 0));
  return AREAS.map(() => 0.01);
};

function setup({ memories = {}, answers = {}, same = false } = {}) {
  const clock = { t: Date.parse('2026-11-08T12:00:00Z') };
  const remembered = [];
  let n = 0;
  const c = createCuriosity({
    file: path.join(mkdtempSync(path.join(os.tmpdir(), 'cur-')), 'curiosity.json'),
    embed: async (texts) => texts.map((t) => (LIFE.some(([, d]) => d === t) ? vec(LIFE.find(([, d]) => d === t)[0]) : embedText(t))),
    ask: async (messages) => {
      const sys = messages[0].content;
      if (sys.includes('curiosity')) return { question: same ? 'So what about your pets situation?' : `Q${n++} what do you make of this?`, why: 'I want to know you.' };
      return answers.reply ?? { answered: false, answer: '' };
    },
    memories: (id) => (memories[id] ?? []).map((content, i) => ({ id: i, content, vector: embedText(content) })),
    contacts: () => [{ user_id: 'u1', name: 'Owner', tier: 'friend', last_seen: clock.t }],
    remember: async (id, lines) => { remembered.push({ id, lines }); return lines; },
    owner: (id) => id === 'u1',
    now: () => clock.t,
  });
  return { c, clock, remembered };
}

const pets = { scope: 'person', aboutId: 'u1', aboutName: 'Owner', area: 'pets', desc: 'their pets and animals', known: [] };

test('the gaps are the parts of a life nothing she remembers touches', async () => {
  const { c } = setup({ memories: { u1: ['Owner works nights #work', 'Owner has a dog called Rex #pets'] } });
  const areas = (await c.gaps()).filter((g) => g.scope === 'person').map((g) => g.area);
  assert.ok(!areas.includes('work') && !areas.includes('pets'), 'what she knows is covered');
  assert.ok(areas.includes('music') && areas.includes('family'), 'what she doesn\'t is a gap');
});

test('pressure brings a question up, she is told the answer with who said it, and the gap closes', async () => {
  const { c, remembered } = setup({ answers: { reply: { answered: true, answer: 'Owner has a white pit bull named Rex.' } } });
  const q = await c.wonder(pets);
  assert.ok(q && q.status === 'open');
  assert.equal(c.forRoom(new Set(['u1'])).id, q.id, 'the question is ready for the person in the room');
  c.markAsked(q.id, { id: 'u1', name: 'Owner' });
  const done = await c.heard({ speaker: { id: 'u1', name: 'Owner' }, text: 'Yeah, Rex, a white pit bull.', place: 'the voice call' });
  assert.equal(done.status, 'answered');
  assert.equal(remembered[0].id, 'u1');
  // The bot's own name, whatever it is set to (a copy of her may be called something else).
  assert.equal(remembered[0].lines[0], `Owner said in the voice call, answering ${config.botName}'s question about Owner (pets): Owner has a white pit bull named Rex.`);
  assert.ok(!(await c.gaps()).some((g) => g.aboutId === 'u1' && g.area === 'pets'), 'that gap is closed for good');
});

test('a question she has just asked is not put on a rest timer: it stays open for the pressure to raise again', async () => {
  const { c } = setup();
  const q = await c.wonder(pets);
  c.markAsked(q.id, { id: 'u1', name: 'Owner' });
  assert.equal(c.forRoom(new Set(['u1'])).id, q.id, 'no rest: it can be raised again straight away');
});

test('her pressure reads how much she wants to wonder: lots of gaps, high, and a long queue does not cap it', async () => {
  const { c } = setup();
  await c.tick(); // counts her gaps (and wonders once)
  assert.ok(c.need() > 0.6, `need with room and gaps: ${c.need()}`);
  for (let i = 0; i < 8; i++) await c.tick();
  assert.ok(c.need() > 0.6, `a full queue does not stop the wondering: ${c.need()}`);
});

test('the same question twice is not queued twice', async () => {
  const { c } = setup({ same: true });
  assert.ok(await c.wonder(pets));
  assert.equal(await c.wonder(pets), null, 'a rephrase of what she already has is dropped');
  assert.equal(c.list().length, 1);
});

test('a question nobody answers is never dropped: it stays open until it is answered', async () => {
  const { c, clock } = setup();
  const q = await c.wonder(pets);
  for (let i = 0; i < 5; i++) {
    c.markAsked(q.id, { id: 'u1', name: 'Owner' });
    await c.heard({ speaker: { id: 'u1', name: 'Owner' }, text: 'eh, whatever', place: 'the voice call' });
    clock.t += 46 * 60_000;
  }
  assert.notEqual(c.list().find((x) => x.id === q.id).status, 'dropped');
});

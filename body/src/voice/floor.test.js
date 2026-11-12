import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFloor } from './floor.js';

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'floor-')), 'floor.json');
const amy = { id: 'A', name: 'Amy' };
const alex = { id: 'X', name: 'Alex' };
const present = ['A', 'X', 'owner'];
const others = { A: ['Alex', 'Howard', 'Gramps'], X: ['Amy', 'Howard', 'Gramps'] };

test('whoever was last named keeps answering lines nobody was named in', async () => {
  const f = file();
  const a = createFloor(f, { settleMs: 5 }), x = createFloor(f, { settleMs: 5 });
  x.claim('vc', alex, true); // "Alex, what do you think?"
  const line = { channelId: 'vc', text: 'and what about the budget', present };
  assert.equal(await a.mine({ ...line, me: amy, others: others.A }), false);
  assert.equal(await x.mine({ ...line, me: alex, others: others.X }), true);
});

test('naming another bot hands it the line, even if you hold the floor', async () => {
  const f = file();
  const a = createFloor(f, { settleMs: 5 });
  a.claim('vc', amy, true);
  assert.equal(await a.mine({ channelId: 'vc', me: amy, text: 'Gramps, you there?', present, others: others.A }), false);
});

test('with nobody holding the floor, exactly one of two bots takes the line', async () => {
  const f = file();
  const a = createFloor(f, { settleMs: 30 }), x = createFloor(f, { settleMs: 30 });
  const line = { channelId: 'vc', text: 'so what now', present };
  const [ra, rx] = await Promise.all([a.mine({ ...line, me: amy, others: others.A }), x.mine({ ...line, me: alex, others: others.X })]);
  assert.equal(Number(ra) + Number(rx), 1);
});

test('a holder that left the call, or is not in free talk, does not block the others', async () => {
  const f = file();
  const a = createFloor(f, { settleMs: 5 }), x = createFloor(f, { settleMs: 5 });
  x.claim('vc', alex, true);
  assert.equal(await a.mine({ channelId: 'vc', me: amy, text: 'hello?', present: ['A', 'owner'], others: others.A }), true);
  x.claim('vc', alex, false);
  assert.equal(await a.mine({ channelId: 'vc', me: amy, text: 'anyone?', present, others: others.A }), true);
});

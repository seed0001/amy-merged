import test from 'node:test';
import assert from 'node:assert/strict';
import { wonderStep, DEFAULTS } from './pressure.js';

// Wonder climbs toward how much she doesn't know. Brand new, with everything unknown, it has to get
// there in minutes, not an hour; once she knows people, the same bucket settles slowly.
const b = DEFAULTS.buckets.wonder; // fill 0.01, decay 0.02, threshold 0.6

test('a fresh memory (need 1.0) reaches the wonder threshold within about ten minutes of ticks', () => {
  let v = 0, ticks = 0;
  while (v < b.threshold && ticks < 120) { v += wonderStep(v, 1.0, b); ticks++; }
  assert.ok(ticks <= 12, `took ${ticks} one-minute ticks`);
});

test('a known crowd (need 0.3) fills slowly and never overshoots its target', () => {
  let v = 0;
  for (let i = 0; i < 200; i++) v += wonderStep(v, 0.3, b);
  assert.ok(Math.abs(v - 0.3) < 1e-9, `settled at ${v}`);
  assert.ok(wonderStep(0, 0.3, b) < wonderStep(0, 1.0, b), 'less to learn, slower to wonder');
});

test('above its target, wonder holds: it rises toward a target and never falls on a clock', () => {
  const close = (a, c) => assert.ok(Math.abs(a - c) < 1e-9, `${a} vs ${c}`);
  close(wonderStep(0.9, 0.5, b), 0);
  close(wonderStep(0.51, 0.5, b), 0);
  close(wonderStep(0.5, 0.5, b), 0);
});

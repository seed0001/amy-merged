import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPerformance } from './avatar-performance.js';
import { HAND_POSES, activeAnimation } from './dashboard/public/avatar-performance.js';
import { HAND_POSES as POSES, HAND_POSE_NAMES } from './dashboard/public/avatar-hands.js';

const fingerBones = ['RightHand', 'RightHandIndex1', 'RightHandIndex2', 'RightHandIndex3', 'RightHandThumb1', 'RightHandPinky1', 'LeftHand', 'LeftHandIndex1', 'LeftHandPinky1'];

test('the page and the server agree on the hand poses, and every pose shapes all five fingers', () => {
  assert.deepEqual([...HAND_POSES].sort(), [...HAND_POSE_NAMES].sort());
  for (const [name, pose] of Object.entries(POSES)) {
    assert.equal(pose.curl.length, 5, `${name} has five curls`);
    for (const v of pose.curl) assert.ok(v >= 0 && v <= 1, `${name} curls in 0..1`);
  }
  assert.equal(POSES.fist.curl[1], 1); assert.equal(POSES.point.curl[1], 0.02); assert.equal(POSES.thumbs_up.thumbOut, 1);
});

test('hands: a pose is held for its duration on an avatar with finger bones, refused without them, and reset lets go', () => {
  let time = 1000;
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'champ-hands-')), 'state.json');
  const events = [];
  const control = createPerformance({ file, now: () => time, available: () => ({ shapes: [], bones: fingerBones }), emit: (e) => events.push(e) });
  const result = control.command({ action: 'hands', gesture: 'peace', duration: 4 }, 'tool');
  assert.equal(result.hands.name, 'peace'); assert.equal(result.hands.strength, 1);
  assert.ok(control.command({ action: 'get' }).hand_poses.includes('peace'));
  time += 2000;
  assert.equal(activeAnimation(control.state().hands, time).name, 'peace');
  time += 3000;
  assert.equal(control.state().hands, null, 'over after four seconds');
  control.command({ action: 'hands', gesture: 'fist', duration: 0 }, 'tool');
  time += 60_000;
  assert.equal(control.state().hands.name, 'fist', 'duration 0 holds');
  control.command({ action: 'reset' });
  assert.equal(control.state().hands, null);
  assert.throws(() => control.command({ action: 'hands', gesture: 'jazz' }), /Choose a hand pose/);
  assert.throws(() => control.command({ action: 'hands', gesture: 'fist', duration: 500 }), /0 \(hold\) to 120/);
  const bare = createPerformance({ file, now: () => time, available: () => ({ shapes: [], bones: ['RightArm'] }), emit: () => {} });
  assert.throws(() => bare.command({ action: 'hands', gesture: 'fist' }), /no finger bones/);
  // A background pose is clamped short and never overrides one she chose.
  const bg = control.command({ action: 'hands', gesture: 'open', duration: 60 }, 'background');
  assert.ok(bg.skipped !== true && bg.hands.duration <= 8);
});

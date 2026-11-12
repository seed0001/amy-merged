import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedLines, sharedSection } from './shared-files.js';

const now = 10 * 60_000;
const rows = [
  { conversation: 'text:1', name: 'Owner', created_at: now - 5 * 60_000, attachments: JSON.stringify({ where: '#morning-vibes', images: [{ name: 'chance.jpg', seen: 'A muscular dog with a chain collar, one eye pale, staring at the camera.' }], docs: [] }) },
  { conversation: 'voice:9', name: 'Owner', created_at: now - 2 * 60_000, attachments: JSON.stringify({ where: 'the voice call', images: [{ name: 'same-room.jpg', seen: 'x' }], docs: [] }) },
  { conversation: 'text:2', name: 'Dell', created_at: now - 3 * 3600_000, attachments: JSON.stringify({ where: '#general', docs: [{ name: 'old.pdf' }], images: [] }) },
];

test('a picture from another conversation is carried into this one with what she saw in it', () => {
  const lines = sharedLines(rows, { conversation: 'voice:9', now });
  assert.equal(lines.length, 1, 'same-conversation and hour-old files are left out');
  assert.match(lines[0], /Owner sent "chance.jpg" in #morning-vibes 5 minutes ago/);
  assert.match(lines[0], /What you saw in it: A muscular dog/);
  assert.match(sharedSection(rows, { conversation: 'voice:9', now }), /^Shared with you lately/);
  assert.match(sharedSection(rows, { conversation: 'text:1', now }), /same-room\.jpg/, 'the voice-call picture shows up in the text channel');
  assert.equal(sharedSection(rows, { conversation: 'text:1', now: now + 2 * 3600_000 }), '', 'an hour later nothing is carried: no section');
});

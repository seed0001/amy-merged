import test from 'node:test';
import assert from 'node:assert/strict';
import { trailsOff } from './trailing.js';

test('a line that trails off is not a finished turn', () => {
  for (const line of [
    'I would look into that, James, seeing how we could fine tune the audio experience for your instruments, make them really',
    'Like, um...', 'Waiting for you to get to the point, or...', 'James, I was thinking about the', 'Hey James, so,', 'James, what if we, uh',
  ]) assert.equal(trailsOff(line), true, line);
});

test('a finished line is answered right away', () => {
  for (const line of [
    'What\'s your intuition telling you, James?', 'Let\'s go ahead and do a restart real quick, James, so that those other changes can take effect.',
    'James, play me something.', 'Hey James, what do you think about the conversation so far?', '',
  ]) assert.equal(trailsOff(line), false, line);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { act, handsNote } from './actions.js';

config.openrouter.apiKey ||= 'test-key';

// A stand-in for the model: each round returns the next scripted message.
function scripted(rounds) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const message = rounds[sent.length - 1] ?? { content: 'done' };
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  };
  return { fetchImpl, sent };
}
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('her hands make the calls, read each result, and report what really happened', async () => {
  const { fetchImpl, sent } = scripted([
    { content: '', tool_calls: [call('a', 'browser', { action: 'open', url: 'localhost:8123' })] },
    { content: '', tool_calls: [call('b', 'workshop', { action: 'run', project: 'Lyra' })] },
    { content: 'Started Lyra and opened it.' },
  ]);
  const ran = [];
  const run = async (name, args) => { ran.push(name); return name === 'browser' ? '[browser: error failed] nothing is running at localhost:8123\nhint: start it' : '[workshop: ok]\nLyra is running.'; };
  const acted = await act({ name: 'Amy', speaker: 'Owner', owner: true, text: 'pull up Lyra', tools: [{ type: 'function', function: { name: 'browser' } }], run, fetchImpl });
  assert.deepEqual(ran, ['browser', 'workshop']);
  assert.equal(acted.report, 'Started Lyra and opened it.');
  assert.equal(sent[0].model, config.actions.model);
  assert.match(sent[0].messages[0].content, /You never talk to anyone/);
  assert.equal(sent[1].messages.at(-1).role, 'tool', 'each result goes back to the model');
  const note = handsNote(acted, 'Owner');
  assert.match(note, /browser open: FAILED: nothing is running at localhost:8123/);
  assert.match(note, /workshop run: ok: Lyra is running/);
  assert.match(note, /You have no tools in this reply/);
});

test('plain conversation: the hands do nothing, and her voice is told not to claim anything', async () => {
  const { fetchImpl } = scripted([{ content: 'NOTHING' }]);
  const acted = await act({ name: 'Amy', speaker: 'Owner', text: 'how are you feeling?', tools: [], run: async () => 'x', fetchImpl });
  assert.deepEqual(acted.calls, []);
  assert.match(handsNote(acted, 'Owner'), /nothing in it needed a tool.*Don't say you did, are doing, or will do anything/);
});

test('when the hands model itself fails, that comes back as an error with the reason', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'provider overloaded' });
  await assert.rejects(act({ name: 'Amy', speaker: 'Owner', text: 'open youtube', tools: [], run: async () => 'x', fetchImpl }), /answered 503: provider overloaded/);
});

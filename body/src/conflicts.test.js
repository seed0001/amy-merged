import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, selfName } from './config.js';
import * as conflicts from './conflicts.js';
import { chat } from './llm.js';
import { createProviderFailover } from './provider-failover.js';

// Owner, 2026-11-11, in the call: "if some of your top predictions… conflict, is there any way for us to tell… what
// you're conflicted with… what different avenues you might have wanted to go down." James: "the conflict view only
// pays off if we log the second and third candidate too, not just the winner."

const lp = (p) => Math.log(p);
const tok = (token, p, alts = []) => ({ token, logprob: lp(p), top_logprobs: [{ token, logprob: lp(p) }, ...alts.map(([t, q]) => ({ token: t, logprob: lp(q) }))] });
// "I think you're right about that." with a real fork at "right" (vs "wrong") and noise elsewhere.
const reply = [
  tok('I', 0.98), tok(' think', 0.9, [[' guess', 0.05]]), tok(' you', 0.97), tok("'re", 0.95),
  tok(' right', 0.46, [[' wrong', 0.41], [' onto', 0.05]]), tok(' about', 0.9), tok(' that', 0.6, [[' That', 0.38]]), tok('.', 0.55, [['!', 0.44]]),
];

function fresh() { rmSync(path.join(DATA_DIR, 'conflicts.jsonl'), { force: true }); conflicts._reset(); }

test('a fork is a real word that only narrowly beat another real word; case, spacing and punctuation rivals are not', () => {
  const forks = conflicts.forkPoints(conflicts.normaliseTokens(reply));
  assert.equal(forks.length, 1);
  const [f] = forks;
  assert.equal(f.chosen.text, ' right');
  assert.equal(f.rivals[0].text, ' wrong');
  assert.equal(f.offset, 'I think you\'re'.length);
  assert.ok(f.closeness > 0.85);
  // A control token as the rival (the end-of-reply marker) is not another avenue.
  const end = conflicts.forkPoints(conflicts.normaliseTokens([tok(' yes', 0.5, [['<｜end▁of▁sentence｜>', 0.45]])]));
  assert.equal(end.length, 0);
});

test('a reply with close calls is kept with its text and forks, tagged as his reply to whoever it was for', () => {
  fresh();
  const rec = conflicts.recordReply({ conversation: 'voice:room', to: 'Owner', tokens: reply, provider: 'openrouter', model: 'm', messages: [{ role: 'user', content: 'am I right?' }] });
  assert.equal(rec.kind, 'fork');
  assert.equal(rec.text, "I think you're right about that.");
  assert.equal(rec.said_to, 'Owner');
  assert.equal(rec.who, selfName(), 'tagged with whoever the companion is, never a fixed name');
  assert.match(rec.source, new RegExp(`^${selfName()}'s own reply to Owner`));
  assert.ok(conflicts.canBranch(rec.id));
  assert.equal(conflicts.recordReply({ conversation: 'c', tokens: [tok('Sure', 0.99), tok('.', 0.99)] }), null, 'no close call: nothing kept');
  assert.match(conflicts.describeRecent(), /"right" 46% over "wrong" 41%.*\[can branch\]/);
});

test('branching sends the reply down the runner-up word and the same brain carries on from there', async () => {
  fresh();
  const rec = conflicts.recordReply({ conversation: 'c', to: 'Owner', tokens: reply, provider: 'ollama', model: 'gemma', messages: [{ role: 'user', content: 'am I right?' }] });
  let seen;
  const b = await conflicts.branch(rec.id, null, {
    continueFrom: async (messages, prefix, how) => { seen = { messages, prefix, how }; return ' about that, honestly.'; },
    describe: async () => 'He disagrees instead of agreeing.',
  });
  assert.equal(seen.prefix, "I think you're wrong");
  assert.deepEqual(seen.how, { provider: 'ollama', model: 'gemma' });
  assert.equal(b.kind, 'branch');
  assert.equal(b.of, rec.id);
  assert.equal(b.instead, "I think you're wrong about that, honestly.");
  assert.equal(b.actual, "I think you're right about that.");
  assert.equal(b.difference, 'He disagrees instead of agreeing.');
  assert.match(conflicts.describeRecent(), /had "wrong" won, you'd have said/);
});

test('a reply whose context is gone says so instead of guessing', async () => {
  fresh();
  const rec = conflicts.recordReply({ conversation: 'c', tokens: reply, provider: 'ollama' });
  await assert.rejects(conflicts.branch(rec.id, null, { continueFrom: async () => '' }), /context isn't held any more/);
  await assert.rejects(conflicts.branch(999, null, {}), /no reply #999/);
});

test('only wants that nearly won are kept, with the ones he had but could not act on', () => {
  fresh();
  assert.equal(conflicts.recordWant({ chose: 'share', over: 0.3, runnersUp: [{ bucket: 'world', over: 0.05 }] }), null);
  const w = conflicts.recordWant({ chose: 'share', over: 0.3, runnersUp: [{ bucket: 'world', over: 0.25 }, { bucket: 'build', over: 0.01 }], blocked: ['silence'] });
  assert.deepEqual(w.close, [{ want: 'world', over: 0.25 }]);
  assert.deepEqual(w.blocked, ['silence']);
  assert.match(conflicts.describeRecent(), /share won, world was right behind; wanted but couldn't: silence/);
});

test('chat() hands each round\'s word odds to onTokens, with the brain that wrote them', async () => {
  const got = [];
  const streamFactory = async () => (async function* () {
    yield { message: { content: 'I think' }, provider: 'openrouter', model: 'm', logprobs: reply.slice(0, 2) };
    yield { message: { content: " you're right" }, provider: 'openrouter', model: 'm', logprobs: reply.slice(2, 5) };
  })();
  const text = await chat([{ role: 'user', content: 'hi' }], { streamFactory, onTokens: (r) => got.push(r) });
  assert.equal(text, "I think you're right");
  assert.equal(got.length, 1);
  assert.equal(got[0].tokens.length, 5);
  assert.equal(got[0].provider, 'openrouter');
});

test('the provider failover passes the word odds through with their words', async () => {
  const router = createProviderFailover({ preferred: () => 'openrouter', enabled: () => false, cooldownMs: () => 0, model: () => 'm', configured: () => true, load: () => ({}), save: () => {}, onSwitch: async () => {} });
  const parts = [];
  for await (const p of router.stream([], async () => (async function* () { yield { message: { content: 'hi' }, logprobs: [tok('hi', 0.5)] }; })())) parts.push(p);
  assert.equal(parts[0].logprobs.length, 1);
});

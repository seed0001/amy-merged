import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('local thought persistence, relevant recall, bounded pressure feedback and feelings', async (t) => {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.format, 'json');
    assert.match(request.messages[0].content, /"affect"/);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({ topic: 'telescope mirrors',
      thought: 'I wonder how telescope mirrors hold their shape.', affect: { curiosity: 0.06,
        boredom: -0.04, irritation: 5, restlessness: 0.03, usefulness: -0.02, unease: 0.02,
        loneliness: { known: 0.06, invented: 1 } } }) }, done: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${server.address().port}`;
  const { config, DATA_DIR } = await import('./config.js');
  const db = new DatabaseSync(path.join(DATA_DIR, 'companion.db'));
  db.exec(`CREATE TABLE thoughts (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, load REAL NOT NULL,
    depth TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL, posted INTEGER NOT NULL DEFAULT 0, channel TEXT)`);
  db.prepare('INSERT INTO thoughts VALUES (1, ?, 0, ?, ?, ?, 0, NULL)').run(Date.now() - 30 * 86400000,
    'quiet', 'orchid roots', 'I keep wondering about orchid roots.');
  const p = await import('./pressure.js'); const thoughts = await import('./thoughts.js');
  const emotion = await import('./emotion.js');
  config.soloMonologue = true; config.selfDialogueEnabled = false; config.thoughtChannelId = '';
  config.cognition.provider = 'ollama'; // this test is about local thoughts; her thinking defaults to OpenRouter now
  p.state.loneliness.known = { name: 'Known', value: 0.4 };
  const before = { ...p.state.buckets };
  const result = await thoughts.think(); assert.ok(result?.id > 1); assert.equal(result.posted, false);
  assert.equal(thoughts.search('orchid')[0].id, 1);
  assert.equal(JSON.parse(db.prepare('SELECT affect FROM thoughts WHERE id = ?').get(result.id).affect).curiosity, 0.06);
  // Owner, 2026-11-09: a thought moves energy she already has; it makes none. So its pushes show as changes in
  // the right direction, bounded by the cap, and the total she holds doesn't grow from it.
  const sum = (b) => Object.values(b).reduce((n, v) => n + (Number(v) || 0), 0);
  assert.ok(p.state.buckets.curiosity > before.curiosity && p.state.buckets.curiosity - before.curiosity <= 0.06 + 1e-9, `curiosity ${before.curiosity} -> ${p.state.buckets.curiosity}`);
  assert.ok(p.state.buckets.irritation > before.irritation && p.state.buckets.irritation <= before.irritation + 0.08 + 1e-9, `irritation ${p.state.buckets.irritation}`);
  for (const key of ['boredom', 'restlessness', 'usefulness', 'unease']) assert.notEqual(p.state.buckets[key], before[key]);
  assert.ok(sum(p.state.buckets) <= sum(before) + 1e-9, 'a thought adds no energy');
  assert.ok(p.state.loneliness.known.value > 0.4 && p.state.loneliness.known.value <= 0.46 + 1e-9); assert.equal(p.state.loneliness.invented, undefined);
  assert.equal(p.onThought({ id: result.id, affect: { curiosity: 1 } }), false);
  assert.equal(JSON.parse(readFileSync(path.join(DATA_DIR, 'pressure-state.json'))).last_thought.id, result.id);
  assert.ok(emotion.current('new-conversation').curious >= 0.1);
  assert.match(thoughts.promptBlock({ query: 'Tell me about orchid roots' }), /orchid roots/);
  assert.equal(thoughts.promptBlock({ postedOnly: true, query: 'orchid' }), '');
  assert.deepEqual(thoughts.recentFor({ perms: { tier: 'stranger' } }), []);
  assert.deepEqual(thoughts.recentFor({ perms: { tier: 'friend' } }), []);
  config.soloMonologue = false; assert.equal(await thoughts.think(), null);
  assert.equal(p.onThought({ id: result.id + 1, affect: { curiosity: 1 } }), false);
  assert.deepEqual(p.backgroundFeelings(), {});
  assert.match(thoughts.promptBlock({ query: 'orchid' }), /orchid roots/);
  config.soloMonologue = true; p.setThoughtFeedback({ enabled: false });
  assert.equal(p.onThought({ id: result.id + 1, affect: { curiosity: 1 } }), false);
  p.setThoughtFeedback({ enabled: true, max_delta: 0.02 });
  assert.equal(JSON.parse(readFileSync(path.join(DATA_DIR, 'pressure-config.json'))).thoughts.feedback.max_delta, 0.02);
  assert.throws(() => p.setThoughtFeedback({ max_delta: NaN }));
  p.state.clamp.until = Date.now() + 60000; p.state.buckets.irritation = 0.2;
  p.cfg.buckets.curiosity.enabled = false; const curiosity = p.state.buckets.curiosity;
  assert.equal(p.onThought({ id: result.id + 1, affect: { curiosity: 1, irritation: 1, unease: 'bad', restlessness: Infinity } }), true);
  assert.equal(p.state.buckets.curiosity, curiosity); assert.equal(p.state.buckets.irritation, 0.2);
  assert.ok(Object.values(p.state.buckets).every(Number.isFinite));
  const restored = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const t = await import('./src/thoughts.js'); if (!t.search('orchid').length || !t.search('telescope').length) process.exit(1)"],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', env: process.env });
  assert.equal(restored.status, 0, restored.stderr);
  const { runTool } = await import('./tools.js');
  await runTool('solo_monologue', { action: 'set_influence', enabled: false }, { perms: { owner: false } });
  assert.equal(p.cfg.thoughts.feedback.enabled, true);
  const ownerResult = await runTool('solo_monologue', { action: 'set_influence', enabled: false }, { perms: { owner: true } });
  assert.match(String(ownerResult), /Thought influence is off/);
  assert.equal(p.cfg.thoughts.feedback.enabled, false);
  db.close();
});

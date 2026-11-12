import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPhoneLink, allowedAddress } from './phone-link.js';
import { createAccounts, accountsFile, tokenHash } from './phone-accounts.js';
import { createPhoneSense } from './phone-sense.js';

const PASSWORD = 'correct horse battery';

// A link on a loopback port with its own throwaway data folder and a fake reply function: no model, no live data.
async function make({ respond = async ({ text }) => `you said: ${text}`, chatTimeoutMs = 2000, waitMs = 300, address = null, now = Date.now } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'phone-link-'));
  await createAccounts({ file: accountsFile(dataDir) }).add('owner', PASSWORD);
  const logs = [];
  const link = createPhoneLink({ respond, dataDir, now, ownerId: () => 'owner-1', ownerName: () => 'Owner', botName: () => 'James', log: (type, d) => logs.push({ type, ...d }),
    chatTimeoutMs, waitMs, sense: createPhoneSense({ file: path.join(dataDir, 'phone-sense.json'), now, ownerName: () => 'Owner', onSituation: () => {} }),
    ...(address && { addressOf: () => address }) });
  const { port } = await link.listen(0, '127.0.0.1');
  const call = async (method, p, { body, token } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const login = async () => (await call('POST', '/auth/login', { body: { username: 'owner', password: PASSWORD, device: 'Pixel 8' } })).json.token;
  return { link, call, login, dataDir, logs };
}

test('only this computer and Tailscale addresses are allowed', () => {
  for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240']) assert.ok(allowedAddress(ok), ok);
  for (const no of ['192.168.1.20', '10.0.0.5', '100.63.255.255', '100.128.0.1', '8.8.8.8', '::ffff:192.168.1.20', 'fd7a:115c:a1e1::1', '2001:db8::1', '', undefined, 'garbage']) assert.ok(!allowedAddress(no), String(no));
});

test('a request from outside Tailscale gets 403 saying so', async () => {
  const { link, call } = await make({ address: '192.168.1.20' });
  try {
    const r = await call('GET', '/ping');
    assert.equal(r.status, 403);
    assert.match(r.json.error, /only .*Tailscale/);
  } finally { await link.close(); }
});

test('accounts: scrypt hash with salt, never the password; tokens stored only as sha256', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'phone-acct-'));
  const accounts = createAccounts({ file: accountsFile(dir) });
  await accounts.add('Owner', PASSWORD);
  assert.equal(await accounts.verify('owner', PASSWORD), true);
  assert.equal(await accounts.verify('owner', 'wrong password'), false);
  assert.equal(await accounts.verify('nobody', PASSWORD), false);
  const token = accounts.issueToken('owner', 'Pixel 8');
  const raw = readFileSync(accountsFile(dir), 'utf8');
  assert.ok(!raw.includes(PASSWORD) && !raw.includes(token), 'neither the password nor the token is stored');
  const saved = JSON.parse(raw).owner;
  assert.match(saved.salt, /^[0-9a-f]{32}$/);
  assert.match(saved.hash, /^[0-9a-f]{128}$/);
  assert.equal(saved.tokens[0].hash, tokenHash(token));
  assert.equal(saved.tokens[0].device, 'Pixel 8');
  assert.deepEqual(accounts.checkToken(token), { username: 'owner', device: 'Pixel 8' });
  assert.equal(accounts.revokeTokens('owner'), 1);
  assert.equal(accounts.checkToken(token), null);
  await assert.rejects(accounts.add('bad name!', PASSWORD), /letters, numbers/);
  await assert.rejects(accounts.add('x', 'short'), /at least 8/);
});

test('login: right password gives a token and the companion name; wrong is 401 with the fix', async () => {
  const { link, call } = await make();
  try {
    const ok = await call('POST', '/auth/login', { body: { username: 'Owner', password: PASSWORD, device: 'Pixel 8' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.name, 'James');
    assert.ok(ok.json.token.length > 30);
    const bad = await call('POST', '/auth/login', { body: { username: 'owner', password: 'nope nope', device: 'x' } });
    assert.equal(bad.status, 401);
    assert.match(bad.json.error, /Wrong username or password/);
    const empty = await call('POST', '/auth/login', { body: {} });
    assert.equal(empty.status, 400);
    const junk = await call('POST', '/auth/login', { body: '{not json' });
    assert.equal(junk.status, 400);
    assert.match(junk.json.error, /valid JSON/);
  } finally { await link.close(); }
});

test('brute force: 5 wrong logins in 10 minutes locks the address out for 10 minutes, even with the right password', async () => {
  let t = Date.UTC(2026, 10, 11, 20, 0, 0);
  const { link, call } = await make({ now: () => t });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/auth/login', { body: { username: 'owner', password: `wrong ${i}xxxx` } })).status, 401);
    const fifth = await call('POST', '/auth/login', { body: { username: 'owner', password: 'wrong 5xxxx' } });
    assert.equal(fifth.status, 429);
    assert.match(fifth.json.error, /refused until/);
    const right = await call('POST', '/auth/login', { body: { username: 'owner', password: PASSWORD } });
    assert.equal(right.status, 429, 'locked out even with the right password');
    t += 10 * 60_000 + 1000;
    assert.equal((await call('POST', '/auth/login', { body: { username: 'owner', password: PASSWORD } })).status, 200, 'open again after 10 minutes');
  } finally { await link.close(); }
});

test('wrong tries spread over more than 10 minutes do not lock', async () => {
  let t = Date.UTC(2026, 10, 11, 20, 0, 0);
  const { link, call } = await make({ now: () => t });
  try {
    for (let i = 0; i < 8; i++) {
      assert.equal((await call('POST', '/auth/login', { body: { username: 'owner', password: `wrong ${i}xxxx` } })).status, 401);
      t += 3 * 60_000;
    }
  } finally { await link.close(); }
});

test('token auth: missing, unknown and revoked tokens are 401; a good one answers', async () => {
  const { link, call, login, dataDir } = await make();
  try {
    assert.equal((await call('GET', '/ping')).status, 401);
    const unknown = await call('GET', '/ping', { token: 'made-up' });
    assert.equal(unknown.status, 401);
    assert.match(unknown.json.error, /Log in again/);
    const token = await login();
    const ping = await call('GET', '/ping', { token });
    assert.deepEqual(ping.json, { ok: true, companion: 'James' });
    createAccounts({ file: accountsFile(dataDir) }).revokeTokens('owner');
    assert.equal((await call('GET', '/ping', { token })).status, 401);
    const nowhere = await call('GET', '/nowhere', { token });
    assert.equal(nowhere.status, 404);
    assert.match(nowhere.json.error, /POST \/sense/);
  } finally { await link.close(); }
});

test('/sense: validated, capped at 200, stored, and shown in /status in plain words', async () => {
  const { link, call, login, dataDir } = await make();
  try {
    const token = await login();
    const now = Date.now();
    const r = await call('POST', '/sense', { token, body: { device: 'Pixel 8', events: [
      { kind: 'battery', at: now - 1000, data: { level: 34, charging: false } },
      { kind: 'headphones', at: now - 500, data: { connected: true } },
      { kind: 'weird', at: 'never' },
    ] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.received, 2);
    const saved = JSON.parse(readFileSync(path.join(dataDir, 'phone-sense.json'), 'utf8'));
    assert.equal(saved.latest.battery.data.level, 34);
    const tooMany = await call('POST', '/sense', { token, body: { events: Array.from({ length: 201 }, () => ({ kind: 'steps', at: now, data: {} })) } });
    assert.equal(tooMany.status, 413);
    assert.match(tooMany.json.error, /at most 200/);
    const notList = await call('POST', '/sense', { token, body: { events: 'x' } });
    assert.equal(notList.status, 400);
    const allBad = await call('POST', '/sense', { token, body: { events: [{ at: now }] } });
    assert.equal(allBad.status, 400);
    assert.match(allBad.json.error, /no kind/);
    const status = await call('GET', '/status', { token });
    assert.match(status.json.summary, /^From Owner's phone .*headphones in; battery 34%, not charging\.$/);
    assert.deepEqual(status.json.recent.map((e) => e.text), ['headphones in', 'battery 34%, not charging']);
  } finally { await link.close(); }
});

test('/chat: the message goes to the reply function as the owner, and the reply comes back and is stored', async () => {
  const asked = [];
  const { link, call, login, dataDir } = await make({ respond: async (args) => { asked.push(args); return 'On my way.'; } });
  try {
    const token = await login();
    const r = await call('POST', '/chat', { token, body: { text: 'where are you?', clientId: 'c1' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.reply.from, 'james');
    assert.equal(r.json.reply.text, 'On my way.');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].ownerId, 'owner-1');
    assert.equal(asked[0].text, 'where are you?');
    // The app sending the same message again gets the same answer, not a second turn.
    const again = await call('POST', '/chat', { token, body: { text: 'where are you?', clientId: 'c1' } });
    assert.equal(again.json.reply.id, r.json.reply.id);
    assert.equal(asked.length, 1);
    const all = await call('GET', '/chat?since=0', { token });
    assert.deepEqual(all.json.messages.map((m) => [m.from, m.text]), [['you', 'where are you?'], ['james', 'On my way.']]);
    const newer = await call('GET', `/chat?since=${all.json.messages[0].id}`, { token });
    assert.equal(newer.json.messages.length, 1);
    const lines = readFileSync(path.join(dataDir, 'phone-chat.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.match(lines[0].source, /Owner, typed on his phone/);
    assert.match(lines[1].source, /James, answering Owner in the phone app/);
    assert.equal((await call('POST', '/chat', { token, body: { text: '  ' } })).status, 400);
    assert.equal((await call('GET', '/chat?since=abc', { token })).status, 400);
  } finally { await link.close(); }
});

test('/chat failures say what failed: an empty reply, an error, a timeout', async () => {
  let mode = 'empty';
  const { link, call, login } = await make({ chatTimeoutMs: 200, respond: async () => {
    if (mode === 'empty') return '';
    if (mode === 'throw') throw new Error('the model is down');
    await new Promise((r) => setTimeout(r, 400));
    return 'late but here';
  } });
  try {
    const token = await login();
    const empty = await call('POST', '/chat', { token, body: { text: 'hi' } });
    assert.equal(empty.status, 502);
    assert.match(empty.json.error, /came back empty/);
    mode = 'throw';
    const broke = await call('POST', '/chat', { token, body: { text: 'hi' } });
    assert.equal(broke.status, 502);
    assert.match(broke.json.error, /the model is down/);
    mode = 'slow';
    const slow = await call('POST', '/chat', { token, body: { text: 'hi' } });
    assert.equal(slow.status, 504);
    assert.match(slow.json.error, /didn't answer within/);
    // The late reply still reaches the phone's chat.
    await new Promise((r) => setTimeout(r, 400));
    const all = await call('GET', '/chat', { token });
    assert.equal(all.json.messages.at(-1).text, 'late but here');
  } finally { await link.close(); }
});

test('/chat/wait answers as soon as a newer message exists, and with nothing after the wait', async () => {
  const { link, call, login } = await make({ waitMs: 300 });
  try {
    const token = await login();
    const quiet = await call('GET', '/chat/wait?since=0', { token });
    assert.deepEqual(quiet.json, { messages: [] });
    const started = Date.now();
    const waiting = call('GET', '/chat/wait?since=0', { token });
    await new Promise((r) => setTimeout(r, 50));
    link.mirror('Thinking of you.', 'James, on his own');
    const got = await waiting;
    assert.ok(Date.now() - started < 290, 'answered before the wait ran out');
    assert.deepEqual(got.json.messages.map((m) => [m.from, m.text]), [['james', 'Thinking of you.']]);
    const already = await call('GET', `/chat/wait?since=0`, { token });
    assert.equal(already.json.messages.length, 1, 'something newer already there: answered at once');
    assert.equal(link.chat.waiting(), 0);
  } finally { await link.close(); }
});

test('the chat store keeps the last 1000 lines', async () => {
  const { link } = await make();
  try {
    for (let i = 0; i < 1005; i++) link.mirror(`line ${i}`, 'test');
    const all = link.chat.since(0);
    assert.equal(all.length, 1000);
    assert.equal(all[0].text, 'line 5');
  } finally { await link.close(); }
});

test('a port already in use is a plain error from listen, not a crash', async () => {
  const { link } = await make();
  try {
    const port = link.server.address().port;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'phone-link-'));
    const other = createPhoneLink({ respond: async () => 'x', dataDir, sense: createPhoneSense({ file: path.join(dataDir, 's.json'), onSituation: () => {}, ownerName: () => 'Owner' }), ownerName: () => 'Owner' });
    await assert.rejects(other.listen(port, '127.0.0.1'), { code: 'EADDRINUSE' });
  } finally { await link.close(); }
});

test('driving from the phone feeds the occupied room read in his pressure', async () => {
  const pressure = await import('./pressure.js');
  pressure.startPressure();
  pressure.state.buckets.occupied = 0;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'phone-sense-p-'));
  const sense = createPhoneSense({ file: path.join(dataDir, 'phone-sense.json'), ownerName: () => 'Owner' }); // the real pressure hook
  sense.ingest([{ kind: 'activity', at: Date.now() - 1000, data: { type: 'in_vehicle', transition: 'enter' } }]);
  for (let i = 0; i < 20 && !(pressure.state.buckets.occupied > 0); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(pressure.state.buckets.occupied >= 0.5, `occupied rose to ${pressure.state.buckets.occupied}`);
  const before = pressure.state.buckets.occupied;
  sense.ingest([{ kind: 'battery', at: Date.now(), data: { level: 50 } }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(pressure.state.buckets.occupied <= before + 1e-9, 'a battery reading moves nothing');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startDashboard } from './dashboard/server.js';
import { config, selfName } from './config.js';
import { bus } from './events.js';
import { relayPeerAvatar, peerRequestProblem, activePeerSpeech, peerExpressions } from './peer-avatar.js';

const capture = (name) => { const seen = []; const on = (e) => seen.push(e); bus.on(name, on); return { seen, off: () => bus.off(name, on) }; };
const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000' } };

test('a peer posts its own speech and the live stream moves that avatar, never with audio', async () => {
  config.dashboard.host = '127.0.0.1'; config.dashboard.port = 0; config.dashboard.password = 'secret-not-sent';
  const server = startDashboard({}); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body) => fetch(base + '/api/avatar/peer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const abort = new AbortController(); let reader;
  try {
    const liveRes = await fetch(base + '/api/avatar/live', { signal: abort.signal, headers: { Authorization: 'Basic ' + Buffer.from('x:secret-not-sent').toString('base64') } });
    reader = liveRes.body.getReader();
    await reader.read(); // the opening state
    // The peer sends no dashboard password: same-computer peer posts don't need it.
    const res = await post({ character: 'nova', event: { type: 'discord-speech', speech: { type: 'start', id: 'n1', character: 'main', text: 'hi there', frameMs: 40, frames: [{ open: 0.5, wide: 0.2, round: 0.3 }, { open: 2, wide: -1 }], audio: undefined } } });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.ok, true); assert.equal(body.lips, 'frames');
    let text = '';
    while (!/"id":"n1"/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"type":"discord-speech"/); assert.match(text, /"character":"nova"/); assert.match(text, /"peer":true/);
    assert.doesNotMatch(text, /"character":"main"/); assert.doesNotMatch(text, /"audio"/);
    assert.match(text, /\{"open":1,"wide":0,"round":0,"bright":0\}/); // clamped
    // Cast members that aren't peers, Amy herself, strangers and unknown event types are refused with why and the fix.
    for (const [character, why] of [['main', /isn't a peer/], ['architect', /isn't a peer/], ['ghost', new RegExp(`isn't in ${selfName()}'s cast`)]]) {
      const bad = await post({ character, event: { type: 'play', name: 'nod' } });
      assert.equal(bad.status, 400); const { error } = await bad.json(); assert.match(error, why); assert.match(error, /Fix:/);
    }
    const view = await post({ character: 'nova', event: { type: 'view', view: {} } });
    assert.equal(view.status, 400); assert.match((await view.json()).error, /discord-speech, expression, play/);
    const garbage = await fetch(base + '/api/avatar/peer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(garbage.status, 400);
    // A relayed request (tunnel/proxy) is refused even though it reaches the socket from 127.0.0.1.
    const tunnelled = await fetch(base + '/api/avatar/peer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '8.8.8.8' }, body: JSON.stringify({ character: 'nova', event: { type: 'play', name: 'nod' } }) });
    assert.notEqual(tunnelled.status, 200);
    // Her studio banter never voices a peer (a line naming one goes to her instead: characters.addressee).
    const auth = { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from('x:secret-not-sent').toString('base64') };
    for (const peer of ['nova', 'alex']) {
      const refused = await fetch(base + '/api/avatar/chat', { method: 'POST', headers: auth, body: JSON.stringify({ auto: true, character: peer, speak: false }) });
      assert.equal(refused.status, 400, peer);
      const { error } = await refused.json(); assert.match(error, /is another companion's avatar/); assert.match(error, /Fix:/);
    }
    const stop = await post({ character: 'nova', event: { type: 'discord-speech', speech: { type: 'stop', id: 'n1' } } });
    assert.equal(stop.status, 200);
    text = '';
    while (!/"type":"stop"/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"character":"nova"/);
  } finally {
    abort.abort(); await reader?.cancel().catch(() => {});
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    config.dashboard.password = '';
  }
});

test('a clip sent as audio gets her phoneme articulation, then the audio is dropped; a stop never overtakes its start', async () => {
  const speech = capture('discord-avatar');
  try {
    let release;
    const slow = new Promise((r) => { release = r; });
    const prepare = async (clip, text, conversation, character) => {
      assert.equal(clip.toString(), 'OggS-fake'); assert.equal(character, 'nova');
      await slow;
      return { frames: [{ open: 0.4, wide: 0.1, round: 0.2, bright: 0.3 }], frameMs: 20, durationMs: 20, articulation: { version: 2, cues: [{ at: 0 }], timing: {} } };
    };
    const at = Date.now() - 50;
    const started = relayPeerAvatar({ character: 'nova', event: { type: 'discord-speech', speech: { type: 'start', id: 'a1', text: 'hello', at, audio: Buffer.from('OggS-fake').toString('base64') } } }, { prepare });
    const stopped = relayPeerAvatar({ character: 'nova', event: { type: 'discord-speech', speech: { type: 'stop', id: 'a1', reason: 'interrupted' } } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(speech.seen.length, 0); // the stop waits for the start
    release();
    const result = await started; await stopped;
    assert.equal(result.lips, 'articulation');
    assert.deepEqual(speech.seen.map((p) => p.type), ['start', 'stop']);
    const [start, stop] = speech.seen;
    assert.equal(start.character, 'nova'); assert.equal(start.at, at); assert.equal(start.articulation.version, 2);
    assert.equal('audio' in start, false); assert.equal(stop.reason, 'interrupted');
    assert.equal(activePeerSpeech().length, 0);
    // An unreadable clip falls back to the frames sent with it, and says so.
    const fallback = await relayPeerAvatar({ character: 'nova', event: { type: 'discord-speech', speech: { type: 'start', id: 'a2', text: 'x', frames: [{ open: 0.3 }], audio: 'AAAA' } } }, { prepare: async () => { throw new Error('Expected an Ogg Opus speech clip.'); } });
    assert.equal(fallback.lips, 'frames'); assert.match(fallback.note, /Ogg Opus/);
    assert.equal(activePeerSpeech().some((p) => p.id === 'a2'), true);
    await relayPeerAvatar({ character: 'nova', event: { type: 'discord-speech', speech: { type: 'stop', id: 'a2' } } });
    // Nothing to move the mouth with: refused with the fix.
    await assert.rejects(relayPeerAvatar({ character: 'nova', event: { type: 'discord-speech', speech: { type: 'start', text: 'x' } } }), /needs something to move the mouth/);
  } finally { speech.off(); }
});

test('feelings, moves and thinking cues go to the peer avatar only, and bad names are explained', async () => {
  const feel = capture('avatar-expression'), play = capture('avatar-play'), cue = capture('avatar-cue');
  try {
    const f = await relayPeerAvatar({ character: 'nova', event: { type: 'expression', expression: { feelings: { joy: 0.7, sparkly: 1, curious: 5 } } } });
    assert.deepEqual(f.feelings, { joy: 0.7, curious: 1 }); assert.deepEqual(f.ignored, ['sparkly']);
    assert.equal(feel.seen[0].character, 'nova');
    assert.equal(peerExpressions().find((e) => e.character === 'nova').feelings.joy, 0.7);
    await assert.rejects(relayPeerAvatar({ character: 'nova', event: { type: 'expression', feelings: { sparkly: 1 } } }), /Fix: use names from/);
    const g = await relayPeerAvatar({ character: 'nova', event: { type: 'gesture', name: 'nod', ms: 900 } });
    assert.deepEqual(g.played, ['nod']); assert.deepEqual(play.seen[0], { ...play.seen[0], character: 'nova', name: 'nod', ms: 900 });
    await assert.rejects(relayPeerAvatar({ character: 'nova', event: { type: 'play', name: 'moonwalk' } }), /No move her stage knows/);
    await relayPeerAvatar({ character: 'nova', event: { type: 'cue', kind: 'thinking', strength: 3 } });
    assert.equal(cue.seen[0].character, 'nova'); assert.equal(cue.seen[0].strength, 1);
    await assert.rejects(relayPeerAvatar({ character: 'nova', event: { type: 'cue', kind: 'dreaming' } }), /doesn't exist/);
  } finally { feel.off(); play.off(); cue.off(); }
});

test('only straight-from-this-computer requests may drive a peer avatar', () => {
  assert.equal(peerRequestProblem(local), null);
  assert.equal(peerRequestProblem({ ...local, socket: { remoteAddress: '::1' } }), null);
  assert.match(peerRequestProblem({ ...local, socket: { remoteAddress: '192.168.1.20' } }), /only taken from this computer.*192\.168\.1\.20/);
  assert.match(peerRequestProblem({ ...local, headers: { ...local.headers, 'x-forwarded-for': '1.2.3.4' } }), /relayed/);
  assert.match(peerRequestProblem({ ...local, headers: { host: 'evil.example:3000' } }), /localhost name/);
});

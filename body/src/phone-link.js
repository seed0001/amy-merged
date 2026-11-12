// The phone link: a small HTTP API for Owner's Android app. The phone sends what it senses (phone-sense.js) and chats
// with the companion; what the companion says to him on its own reaches the phone too. Its own server, separate from
// the dashboard (which stays on 127.0.0.1), so only this API is reachable from the phone, and only from this computer
// or over Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48). Logins are the owner's only: accounts are made on this
// computer with scripts/phone-account.mjs, and a login acts as the first id in OWNER_IDS.
//
// JSON in and out. Every error is { error: "what failed, why, and the fix" }.
//   POST /auth/login {username, password, device}  -> {token, name}
//   GET  /ping                                      -> {ok, companion}
//   POST /sense {device, events:[{kind, at, data}]} -> {ok, received}
//   POST /chat {text, clientId}                     -> {ok, reply:{id, from:"james", text, at}}
//   GET  /chat?since=<id>                           -> {messages}
//   GET  /chat/wait?since=<id>                      -> {messages} as soon as there's a newer one, else [] after 50 s
//   GET  /status                                    -> {summary, recent}
import http from 'node:http';
import { BlockList, isIP } from 'node:net';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { createAccounts, accountsFile } from './phone-accounts.js';
import { createPhoneSense, MAX_EVENTS_PER_POST } from './phone-sense.js';
import { ownerDisplayName } from './owner-name.js';

const MAX_BODY = 512 * 1024;
const MAX_TEXT = 4000;
const KEEP_CHAT = 1000;
const LOGIN_TRIES = 5;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_LOCK_MS = 10 * 60_000;
const ONLY_TAILSCALE = 'The phone link only answers this computer or over Tailscale. Turn Tailscale on on the phone and use this computer\'s Tailscale address (100.x.y.z).';

// Who may talk to it: this computer, or a device on the tailnet.
const allowed = new BlockList();
allowed.addSubnet('127.0.0.0', 8, 'ipv4');
allowed.addSubnet('100.64.0.0', 10, 'ipv4');
allowed.addAddress('::1', 'ipv6');
allowed.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
export function allowedAddress(address) {
  let a = String(address ?? '').trim();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(a)) a = a.slice(7); // an IPv4 address on a dual-stack socket
  a = a.split('%')[0];
  const v = isIP(a);
  return v === 4 ? allowed.check(a, 'ipv4') : v === 6 ? allowed.check(a, 'ipv6') : false;
}

class Refusal extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const refuse = (status, message, extra) => { throw new Refusal(status, message, extra); };

// The chat as the phone sees it: data/phone-chat.jsonl, the last 1000 lines. Each line says who said it and where.
export function createChatStore({ file, now = Date.now, log = () => {} }) {
  let lines = [];
  try {
    if (existsSync(file)) lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && Number.isFinite(m.id));
  } catch (err) { log('error', { where: 'phone chat', message: `data/phone-chat.jsonl couldn't be read (${err.message}), so the phone's chat history starts empty; nothing else is affected.` }); }
  let lastId = lines.reduce((n, m) => Math.max(n, m.id), 0);
  const waiters = new Set();
  const save = () => {
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, lines.map((m) => JSON.stringify(m)).join('\n') + (lines.length ? '\n' : ''));
      renameSync(tmp, file);
    } catch (err) { log('error', { where: 'phone chat', message: `A chat line couldn't be saved to ${file}: ${err.message}. Check the disk and that the file isn't locked.` }); }
  };
  const view = ({ id, from, text, at }) => ({ id, from, text, at });
  const after = (since) => lines.filter((m) => m.id > since).map(view);
  return {
    // from: 'you' (the owner) or 'james' (the companion); source: who said it and where, kept with the line.
    append({ from, text, source, clientId = null }) {
      const m = { id: ++lastId, from, text: String(text), at: now(), source, ...(clientId && { clientId }) };
      lines.push(m);
      if (lines.length > KEEP_CHAT) lines = lines.slice(-KEEP_CHAT);
      save();
      for (const w of [...waiters]) if (m.id > w.since) { waiters.delete(w); w.resolve(after(w.since)); }
      return view(m);
    },
    since: (since = 0) => after(Number(since) || 0),
    byClientId: (clientId) => lines.find((m) => m.clientId === clientId) ?? null,
    replyTo: (id) => { const m = lines.find((x) => x.replyTo === id); return m ? view(m) : null; },
    markReply(reply, toId) { const m = lines.find((x) => x.id === reply.id); if (m) { m.replyTo = toId; save(); } },
    // Resolves with the newer messages as soon as there are any, or [] after waitMs. cancel() lets go early.
    wait(since, waitMs) {
      const s = Number(since) || 0;
      const now_ = after(s);
      if (now_.length) return { promise: Promise.resolve(now_), cancel() {} };
      let w;
      const promise = new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(w); resolve([]); }, waitMs);
        w = { since: s, resolve: (v) => { clearTimeout(timer); resolve(v); } };
        waiters.add(w);
      });
      return { promise, cancel: () => { if (waiters.delete(w)) w.resolve([]); } };
    },
    waiting: () => waiters.size,
    lastId: () => lastId,
  };
}

// respond({ text, ownerId, device, clientId }) -> the companion's reply text; injected so tests never call a model.
export function createPhoneLink({
  respond,
  dataDir = DATA_DIR,
  now = Date.now,
  ownerId = () => config.ownerIds?.[0],
  ownerName = ownerDisplayName,
  botName = () => config.botName,
  sense = null,
  log = () => {},
  chatTimeoutMs = 120_000,
  waitMs = 50_000,
  addressOf = (req) => req.socket?.remoteAddress,
} = {}) {
  const accounts = createAccounts({ file: accountsFile(dataDir), now });
  const senses = sense ?? createPhoneSense({ file: path.join(dataDir, 'phone-sense.json'), now, ownerName, log });
  const chat = createChatStore({ file: path.join(dataDir, 'phone-chat.jsonl'), now, log });
  const failures = new Map(); // address -> { times: [ms], lockedUntil }
  const inFlight = new Map(); // clientId -> promise of the reply
  const companion = () => String(botName() || 'Companion');

  const clockOf = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  function lockedOut(addr) {
    const f = failures.get(addr);
    if (f?.lockedUntil && f.lockedUntil > now()) return f.lockedUntil;
    return 0;
  }
  function failed(addr) {
    const t = now();
    const f = failures.get(addr) ?? { times: [], lockedUntil: 0 };
    f.times = f.times.filter((x) => t - x < LOGIN_WINDOW_MS);
    f.times.push(t);
    if (f.times.length >= LOGIN_TRIES) { f.lockedUntil = t + LOGIN_LOCK_MS; f.times = []; }
    failures.set(addr, f);
    return f.lockedUntil > t ? f.lockedUntil : 0;
  }

  async function login(body, addr) {
    const until = lockedOut(addr);
    if (until) refuse(429, `Too many wrong logins from this address (${LOGIN_TRIES} in 10 minutes), so logins from here are refused until ${clockOf(until)}. Check the username and password, then try again after that.`);
    const { username, password, device } = body;
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) refuse(400, 'Login needs a username and a password. Send {"username", "password", "device"}.');
    const owner = ownerId();
    if (!owner) refuse(503, `No owner is set in OWNER_IDS in ${companion()}'s .env, so a phone login has nobody to act as. Add the owner's Discord id there and restart ${companion()}.`);
    if (!(await accounts.verify(username, password))) {
      const locked = failed(addr);
      log('phone', { login: 'refused', username: username.slice(0, 40), address: addr, ...(locked && { lockedUntil: locked }) });
      if (locked) refuse(429, `Wrong username or password, and that's ${LOGIN_TRIES} wrong tries from this address in 10 minutes, so logins from here are refused until ${clockOf(locked)}. Check them, then try again after that.`);
      refuse(401, `Wrong username or password. Check both; an account is made on ${companion()}'s computer with: node scripts/phone-account.mjs <username>.`);
    }
    failures.delete(addr);
    const dev = String(device ?? '').slice(0, 60) || 'phone';
    const token = accounts.issueToken(username, dev);
    log('phone', { login: 'ok', username: username.slice(0, 40), device: dev, address: addr });
    return { token, name: companion() };
  }

  function authed(req) {
    const h = String(req.headers.authorization ?? '');
    const m = h.match(/^Bearer\s+(\S+)$/i);
    if (!m) refuse(401, 'This needs the token from logging in: send it as "Authorization: Bearer <token>". Log in with POST /auth/login.');
    const who = accounts.checkToken(m[1]);
    if (!who) refuse(401, 'That token isn\'t valid (it was revoked, the account was removed or its password changed). Log in again.');
    const owner = ownerId();
    if (!owner) refuse(503, `No owner is set in OWNER_IDS in ${companion()}'s .env, so the phone has nobody to act as. Add the owner's Discord id there and restart ${companion()}.`);
    return { ...who, ownerId: String(owner) };
  }

  function sensePost(body, who) {
    const events = body.events;
    if (!Array.isArray(events)) refuse(400, 'Send {"device", "events": [{"kind", "at", "data"}]}: "events" must be a list.');
    if (events.length > MAX_EVENTS_PER_POST) refuse(413, `That's ${events.length} events in one post; send at most ${MAX_EVENTS_PER_POST} per post and the rest in the next.`);
    const device = String(body.device ?? who.device ?? '').slice(0, 60);
    const { received, skipped } = senses.ingest(events, { device });
    if (events.length && !received) refuse(400, `None of the ${events.length} events could be used: ${skipped[0]}.`);
    return { ok: true, received, ...(skipped.length && { skipped: skipped.slice(0, 10) }) };
  }

  async function chatPost(body, who) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) refuse(400, 'Send {"text": "...", "clientId": "..."}: the message is empty.');
    if (text.length > MAX_TEXT) refuse(413, `That message is ${text.length} characters; keep it under ${MAX_TEXT}, or split it.`);
    const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim().slice(0, 80) : null;
    // The same message sent again (the app retrying): the same answer, never a second turn.
    if (clientId) {
      if (inFlight.has(clientId)) return { ok: true, reply: await inFlight.get(clientId) };
      const sent = chat.byClientId(clientId);
      const answered = sent && chat.replyTo(sent.id);
      if (answered) return { ok: true, reply: answered };
    }
    const mine = chat.append({ from: 'you', text, source: `${ownerName()}, typed on his phone${who.device ? ` (${who.device})` : ''}`, clientId });
    const turn = Promise.resolve()
      .then(() => respond({ text, ownerId: who.ownerId, device: who.device, clientId }))
      .then((line) => {
        const said = String(line ?? '').trim();
        if (!said) throw new Refusal(502, `${companion()}'s reply came back empty (asleep, shutting down, or the model failed). Look at the activity log for why, then send it again.`);
        const reply = chat.append({ from: 'james', text: said, source: `${companion()}, answering ${ownerName()} in the phone app` });
        chat.markReply(reply, mine.id);
        return reply;
      });
    if (clientId) { inFlight.set(clientId, turn); turn.catch(() => {}).finally(() => inFlight.delete(clientId)); }
    turn.catch((err) => log('error', { where: 'phone chat', message: `${companion()} couldn't answer "${text.slice(0, 60)}" from the phone: ${err.message}` }));
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Refusal(504, `${companion()} didn't answer within ${Math.round(chatTimeoutMs / 1000)} seconds. If it's still being worked on, the reply will show up in the chat when it's done; otherwise look at the activity log for why.`)), chatTimeoutMs); });
    try {
      const reply = await Promise.race([turn, late]);
      return { ok: true, reply };
    } catch (err) {
      if (err instanceof Refusal) throw err;
      refuse(502, `${companion()} couldn't answer: ${err.message}. Try again; if it keeps failing, look at the activity log.`);
    } finally { clearTimeout(timer); }
  }

  function sinceOf(url) {
    const raw = url.searchParams.get('since');
    if (raw === null || raw === '') return 0;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) refuse(400, `"since" must be a message id (a whole number), not "${String(raw).slice(0, 20)}".`);
    return n;
  }

  async function route(req, res, url, addr, body) {
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const key = `${req.method} ${p}`;
    if (key === 'POST /auth/login') return login(body, addr);
    const known = ['GET /ping', 'POST /sense', 'POST /chat', 'GET /chat', 'GET /chat/wait', 'GET /status'];
    if (!known.includes(key)) refuse(404, `There's no ${req.method} ${p} on the phone link. It has: POST /auth/login, GET /ping, POST /sense, POST /chat, GET /chat, GET /chat/wait, GET /status.`);
    const who = authed(req);
    switch (key) {
      case 'GET /ping': return { ok: true, companion: companion() };
      case 'POST /sense': return sensePost(body, who);
      case 'POST /chat': return chatPost(body, who);
      case 'GET /chat': return { messages: chat.since(sinceOf(url)) };
      case 'GET /chat/wait': {
        const w = chat.wait(sinceOf(url), waitMs);
        res.on('close', () => w.cancel()); // the phone hung up (the response's close: the request's fires once its body is read)
        return { messages: await w.promise };
      }
      case 'GET /status': return senses.status();
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Refusal(413, `That request is over ${MAX_BODY / 1024} KB; send less at once (at most ${MAX_EVENTS_PER_POST} events, short data).`)); req.destroy(); return; }
        parts.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8');
        if (!raw.trim()) return resolve({});
        try {
          const v = JSON.parse(raw);
          if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new Refusal(400, 'The body must be a JSON object.'));
          resolve(v);
        } catch { reject(new Refusal(400, 'The body isn\'t valid JSON. Send JSON with "Content-Type: application/json".')); }
      });
      req.on('error', reject);
    });
  }

  const send = (res, status, obj) => {
    if (res.headersSent || res.writableEnded) return;
    const json = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(json) });
    res.end(json);
  };

  async function handle(req, res) {
    const addr = addressOf(req);
    try {
      if (!allowedAddress(addr)) refuse(403, ONLY_TAILSCALE);
      const url = new URL(req.url, 'http://phone.link');
      const body = await readBody(req);
      send(res, 200, await route(req, res, url, addr, body));
    } catch (err) {
      if (err instanceof Refusal) return send(res, err.status, { error: err.message, ...err.extra });
      log('error', { where: 'phone link', message: `${req.method} ${String(req.url).split('?')[0]} failed: ${err.message}` });
      send(res, 500, { error: `The phone link hit an error handling that: ${err.message}. Try again; if it keeps happening, look at the activity log.` });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 0; // a chat turn or a long poll can take its time; each has its own limit
  server.headersTimeout = 30_000;

  return {
    server,
    handle,
    accounts,
    sense: senses,
    chat,
    // What the companion said to the owner on his own (a DM he started, a finished job): it reaches the phone too.
    mirror(text, source) {
      const said = String(text ?? '').trim();
      if (!said) return null;
      return chat.append({ from: 'james', text: said, source: source || `${companion()}, unprompted` });
    },
    listen(port, host) {
      return new Promise((resolve, reject) => {
        const onError = (err) => { server.off('listening', onListen); reject(err); };
        const onListen = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, host);
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// The running link, so what the companion sends the owner on his own can reach the phone (bot.js).
let current = null;
export function mirrorToPhone(text, source) {
  if (!current) return null;
  try { return current.mirror(text, source); } catch { return null; }
}

// Started from index.js next to the dashboard. Never throws: a link that can't start says why in the activity log.
export async function startPhoneLink(bot) {
  const { activity } = await import('./events.js');
  if (!config.phone?.enabled) { activity('phone', { message: 'The phone link is switched off (PHONE_ENABLED=false in .env), so the phone app can\'t reach the companion.' }); return null; }
  try {
    const { ownerDisplayName } = await import('./owner-name.js');
    const { phoneSense } = await import('./phone-sense.js');
    const link = createPhoneLink({ respond: phoneRespond(bot), sense: phoneSense(), ownerName: ownerDisplayName, log: activity });
    await link.listen(config.phone.port, config.phone.host);
    current = link;
    activity('phone', { message: `Phone link listening on ${config.phone.host}:${config.phone.port} (this computer and Tailscale only)` });
    return link;
  } catch (err) {
    const why = err.code === 'EADDRINUSE'
      ? `port ${config.phone.port} is already in use by another program (or another copy of the companion). Close it, or set PHONE_PORT in .env to a free port and restart`
      : err.code === 'EADDRNOTAVAIL'
        ? `${config.phone.host} isn't an address on this computer. Set PHONE_HOST in .env to 0.0.0.0 or this computer's Tailscale address and restart`
        : `${err.message}. Check PHONE_PORT and PHONE_HOST in .env and restart`;
    activity('error', { where: 'phone link', message: `The phone link couldn't start, so the phone app can't reach the companion: ${why}. Everything else runs as normal.` });
    return null;
  }
}

// A message from the owner's phone, answered through the normal text reply pipeline (companion.js respond), as a
// message from the owner in its own conversation (phone:<ownerId>), with the tools an owner DM has.
function phoneRespond(bot) {
  return async ({ text, ownerId, device }) => {
    const [{ respond, taskCue }, { ownerDisplayName }, { intake }, { onArrival }, { recentMessages }, { activity }] = await Promise.all([
      import('./companion.js'), import('./owner-name.js'), import('./intake.js'), import('./pressure.js'), import('./memory.js'), import('./events.js')]);
    const name = ownerDisplayName();
    const conversation = `phone:${ownerId}`;
    const place = `${name}'s phone${device ? ` (${device})` : ''}`;
    const speaker = { id: ownerId, name, dm: true };
    // As a DM from him on Discord: his arrival and what the line means feed her pressure (bot.js does the same).
    try { onArrival({ id: ownerId, name }, { via: 'phone' }); } catch (err) { activity('error', { where: 'anticipation', message: `Couldn't weigh ${name}'s arrival from his phone: ${err.message}. Nothing moved; check pressure.onArrival.` }); }
    try {
      intake().hear({ conversation, speaker: { id: ownerId, name }, text, owner: true, addressed: true,
        recent: recentMessages(conversation, 6).map((m) => ({ name: m.role === 'assistant' ? config.botName : m.name ?? 'someone', text: m.content })) });
    } catch (err) { activity('error', { where: 'intake', message: `The line from ${name}'s phone wasn't read into her pressure: ${err.message}.` }); }
    const files = [];
    const client = bot?.client ?? null;
    const reply = await respond({
      conversation, speaker, text, place,
      discord: {
        client,
        sendHere: async (file) => files.push(file),
        sendBackground: async (file) => files.push(file),
        // A helper that finishes later reports back here, in her words, into the phone chat.
        notify: async (report) => {
          const line = await respond({ conversation, speaker, text: '', cue: taskCue(report), evidence: report, place })
            .catch((err) => { activity('error', { where: 'task report reply', message: err.message }); return ''; });
          mirrorToPhone(line || report, `${config.botName}, reporting back to ${name} in the phone app`);
        },
        progress: (note) => mirrorToPhone(`⏳ ${note}`, `${config.botName}, a progress note in the phone app`),
      },
    });
    // The phone chat is text only: files she made go to his Discord DMs, and the reply says so.
    if (files.length && reply) {
      const names = files.map((f) => f.name).filter(Boolean).join(', ') || 'a file';
      try {
        if (!client?.isReady?.()) throw new Error('Discord is offline');
        const dm = await (await client.users.fetch(ownerId)).createDM();
        await dm.send({ files, allowedMentions: { parse: [] } });
        return `${reply}\n\n(Sent ${names} to your Discord DMs; the phone chat is text only.)`;
      } catch (err) {
        activity('error', { where: 'phone chat', message: `${names} couldn't be sent to ${name}'s Discord DMs: ${err.message}.` });
        return `${reply}\n\n(${names} couldn't be delivered: the phone chat is text only and ${err.message}. Ask again from Discord.)`;
      }
    }
    return reply;
  };
}

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';
import { findBrowser } from './avatarVideo.js';

// Her browser: a real, visible Chrome (or Edge) window that she drives and the owner streams to
// Discord. Her avatar has a tab of its own that always stays open, and every other page gets a small
// box with her in it, in a corner she picks (or hidden), so whoever's watching sees her while she
// works. She opens pages and tabs, reads them, clicks, types, and inside a game holds keys and moves
// the mouse like a player would. It runs on its own profile and outlives her restarts, so a stream
// isn't cut when she comes back; she just reconnects to it.
//
// Driven over the Chrome DevTools Protocol, the same channel developer tools use: the input is real
// input to the page, so games react exactly as they do to a person at the keyboard. Her dashboard's
// password is handed only to her dashboard's own address (the avatar tab and the box), never to
// other sites.

const PORT = Number(process.env.AMY_BROWSER_PORT || 9333);
const READ_CHARS = 8000; // one part of a page's text; she reads on with "from"
const LIST_ITEMS = 150;  // links listed by read; all of them can be clicked by their words

// Numbers every link, button and field on the page, on screen or not (data-amy-n), so she can click
// one by number or by its words. Defines els (the elements) and items (what she's shown).
const TAG_JS = `
  document.querySelectorAll('[data-amy-n]').forEach((e) => e.removeAttribute('data-amy-n'));
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const els = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [onclick], summary')]
    .filter((el) => !el.closest('#__amy_pip') && shown(el)).slice(0, 600);
  // The page's own content (an article, a main section) before menus and sidebars, when it has one.
  const mainEl = document.querySelector('main, article, [role=main], #content');
  const mainText = mainEl && mainEl.innerText.length > 500 ? mainEl.innerText : (document.body ? document.body.innerText : '');
  const items = els.map((el, i) => {
    el.setAttribute('data-amy-n', String(i + 1));
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.title || el.name || (el.type && el.tagName === 'INPUT' ? el.type + ' box' : '') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    let href = '';
    if (el.tagName === 'A' && el.href) { try { const u = new URL(el.href); href = (u.origin === location.origin ? u.pathname + u.search + u.hash : u.href).slice(0, 90); } catch {} }
    return { n: i + 1, tag: el.tagName === 'A' ? 'link' : el.tagName.toLowerCase(), label, href };
  });`;
const MAX_HOLD_MS = 15_000;
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// Key names she can use -> what the page sees.
const KEYS = {
  space: ['Space', ' ', 32], enter: ['Enter', 'Enter', 13], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
  tab: ['Tab', 'Tab', 9], backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46],
  shift: ['ShiftLeft', 'Shift', 16], ctrl: ['ControlLeft', 'Control', 17], control: ['ControlLeft', 'Control', 17], alt: ['AltLeft', 'Alt', 18],
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34], home: ['Home', 'Home', 36], end: ['End', 'End', 35],
};
export function keyInfo(name) {
  const n = String(name ?? '').trim();
  const known = KEYS[n.toLowerCase()];
  if (known) return { code: known[0], key: known[1], vk: known[2] };
  if (/^[a-z]$/i.test(n)) return { code: `Key${n.toUpperCase()}`, key: n.toLowerCase(), vk: n.toUpperCase().charCodeAt(0), text: n.toLowerCase() };
  if (/^[0-9]$/.test(n)) return { code: `Digit${n}`, key: n, vk: n.charCodeAt(0), text: n };
  if (/^f([1-9]|1[0-2])$/i.test(n)) return { code: n.toUpperCase(), key: n.toUpperCase(), vk: 111 + Number(n.slice(1)) };
  throw new Error(`Unknown key "${n}". Use a letter, a digit, F1-F12, or: ${Object.keys(KEYS).join(', ')}.`);
}
const MODIFIER_BITS = { Alt: 1, Control: 2, Shift: 8 };

// The script every page gets: the box with her in it. window.__amyPip(state) moves or hides it.
export function pipScript(dash, state) {
  return `(() => {
  if (window.top !== window || location.origin === ${JSON.stringify(dash)}) return;
  const ID = '__amy_pip';
  const apply = (s) => {
    window.__amyPipState = s;
    const root = document.body || document.documentElement;
    let box = document.getElementById(ID);
    if (!s || s.hidden) { if (box) box.remove(); return; }
    if (!root) return;
    if (!box) {
      box = document.createElement('div');
      box.id = ID;
      const f = document.createElement('iframe');
      f.src = ${JSON.stringify(`${dash}/avatar.html?pip=1&silent=1&character=main`)};
      f.allow = 'autoplay';
      f.style.cssText = 'width:100%;height:100%;border:0;display:block;background:transparent;pointer-events:none';
      box.appendChild(f);
      root.appendChild(box);
    }
    const [v, h] = s.corner.split('-');
    box.style.cssText = 'position:fixed;z-index:2147483647;overflow:hidden;border-radius:16px;pointer-events:none;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.45);border:2px solid rgba(255,255,255,.25);background:#111;'
      + 'width:' + s.size + 'px;height:' + Math.round(s.size * 1.15) + 'px;'
      + v + ':16px;' + h + ':16px;';
  };
  window.__amyPip = apply;
  apply(window.__amyPipState || ${JSON.stringify(state)});
  if (!document.body) addEventListener('DOMContentLoaded', () => apply(window.__amyPipState), { once: true });
})();`;
}

// The DevTools Protocol over one websocket to the whole browser; each tab and frame is a session on it.
class Connection {
  constructor(ws) {
    this.ws = ws; this.next = 1; this.waiting = new Map(); this.handlers = new Set();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) for (const h of this.handlers) { try { h(msg.method, msg.params, msg.sessionId); } catch {} }
    });
    ws.addEventListener('close', () => { this.closed = true; for (const { reject } of this.waiting.values()) reject(new Error('The browser closed.')); this.waiting.clear(); });
  }
  on(fn) { this.handlers.add(fn); }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('The browser closed.'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`${method} timed out`)); }, 30_000);
    });
  }
}

export function createBrowser({
  port = PORT,
  profile = path.join(DATA_DIR, 'browser-profile'),
  stateFile = path.join(DATA_DIR, 'browser.json'),
  dash = `http://127.0.0.1:${config.dashboard.port}`,
  password = config.dashboard.password,
  find = findBrowser,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const AVATAR_URL = `${dash}/avatar.html?silent=1`; // the whole cast (her, Mateo, Nova); the corner box (pip) is just her
  const base = `http://127.0.0.1:${port}`;
  const json = (p) => fetch(base + p, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
  const auth = password ? `Basic ${Buffer.from(`viewer:${password}`).toString('base64')}` : null;
  const ours = (url) => String(url ?? '').startsWith(dash + '/') || url === dash; // his dashboard: gets his password, no corner box
  // His avatar tab is the avatar page only. His other dashboard pages (his mind, the studio) are ordinary tabs he can
  // switch to, reuse and read. Counting every dashboard page as "the avatar" made switching to his mind page say
  // "Switched to your avatar tab", opened duplicates, and on reconnect loaded the avatar over his mind page.
  const avatarPage = (url) => { try { return ours(url) && new URL(url).pathname === '/avatar.html'; } catch { return false; } };
  const sameAddress = (a, b) => { try { const x = new URL(a), y = new URL(b); x.hash = y.hash = ''; return x.href === y.href; } catch { return false; } };

  let conn = null, connecting = null, current = null, targets = [];
  let lastGlance = null, lastLook = null; // what she last saw, for her context every turn (awareness.js)
  const tabs = new Map(); // targetId -> { sessionId, url, title, log, scriptId }
  let pip = (() => { try { return { corner: 'bottom-right', size: 280, hidden: false, ...JSON.parse(readFileSync(stateFile, 'utf8')).pip }; } catch { return { corner: 'bottom-right', size: 280, hidden: false }; } })();
  const savePip = () => { try { writeFileSync(stateFile, JSON.stringify({ pip }, null, 2)); } catch {} };

  async function running() { try { await json('/json/version'); return true; } catch { return false; } }

  async function launch() {
    const exe = find();
    if (!exe) throw new Error('No Chrome or Edge found on this computer.');
    mkdirSync(profile, { recursive: true });
    const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', // window size: whatever the owner last left it at (Chrome remembers) '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', AVATAR_URL], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref(); // it stays open when she restarts
    for (let i = 0; i < 40 && !await running(); i++) await sleep(250);
    if (!await running()) throw new Error('The browser started but never answered.');
    activity('browser', { opened: 'avatar tab' });
  }

  // Every tab and frame that appears: her password goes only to her dashboard; pages get her box.
  async function attach(sessionId, info, waiting) {
    const send = (m, p) => conn.send(m, p, sessionId).catch(() => {});
    try {
      if (info.type === 'page' || info.type === 'iframe') {
        if (auth) await send('Fetch.enable', { patterns: [{ urlPattern: `${dash}/*` }], handleAuthRequests: true });
        await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      }
      if (info.type === 'page') {
        const tab = { sessionId, url: info.url, title: info.title, log: [], scriptId: null };
        tabs.set(info.targetId, tab);
        await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Page.setBypassCSP', { enabled: true })]);
        tab.scriptId = (await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: pipScript(dash, pip) }, sessionId).catch(() => null))?.identifier ?? null;
        if (!ours(info.url)) await send('Runtime.evaluate', { expression: pipScript(dash, pip) });
      }
    } finally {
      if (waiting) await send('Runtime.runIfWaitingForDebugger');
    }
  }

  function onEvent(method, params, sessionId) {
    const tabOf = () => [...tabs.values()].find((t) => t.sessionId === sessionId);
    if (method === 'Target.attachedToTarget') attach(params.sessionId, params.targetInfo, params.waitingForDebugger);
    else if (method === 'Target.detachedFromTarget') { for (const [id, t] of tabs) if (t.sessionId === params.sessionId) tabs.delete(id); }
    else if (method === 'Target.targetInfoChanged') { const t = tabs.get(params.targetInfo.targetId); if (t) Object.assign(t, { url: params.targetInfo.url, title: params.targetInfo.title }); }
    else if (method === 'Target.targetDestroyed') { tabs.delete(params.targetId); if (current === params.targetId) current = null; }
    else if (method === 'Fetch.requestPaused') {
      const headers = Object.entries(params.request.headers ?? {}).map(([name, value]) => ({ name, value }));
      if (ours(params.request.url) && auth) headers.push({ name: 'Authorization', value: auth });
      conn.send('Fetch.continueRequest', { requestId: params.requestId, headers }, sessionId).catch(() => {});
    } else if (method === 'Fetch.authRequired') {
      conn.send('Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: ours(params.request.url) && password ? { response: 'ProvideCredentials', username: 'viewer', password } : { response: 'Default' } }, sessionId).catch(() => {});
    } else if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(params.type)) {
      const t = tabOf(); if (t) note(t, `${params.type}: ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (method === 'Runtime.exceptionThrown') {
      const t = tabOf(); if (t) note(t, `exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
    }
  }
  const note = (t, text) => { t.log.push({ at: Date.now(), text: String(text).slice(0, 400) }); t.log.splice(0, Math.max(0, t.log.length - 50)); };

  async function connect() {
    if (conn && !conn.closed) return conn;
    return (connecting ??= (async () => {
      if (!await running()) await launch();
      const { webSocketDebuggerUrl } = await json('/json/version');
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error("Couldn't connect to the browser.")), { once: true }); });
      conn = new Connection(ws);
      tabs.clear();
      conn.on(onEvent);
      await conn.send('Target.setDiscoverTargets', { discover: true });
      await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      for (let i = 0; i < 20 && !tabs.size; i++) await sleep(100);
      await sleep(300);
      // Her avatar always has a tab of its own, showing just her.
      // Only his avatar page is it: no other tab is ever navigated to make one.
      if (![...tabs.values()].some((t) => avatarPage(t.url))) await conn.send('Target.createTarget', { url: AVATAR_URL, background: true });
      return conn;
    })().finally(() => { connecting = null; }));
  }

  const list = () => [...tabs.entries()].map(([id, t]) => ({ id, ...t, avatar: avatarPage(t.url) }));
  // Titles and addresses as they are right now ("Lyra — World", not the address it started at).
  async function refresh() {
    const { targetInfos = [] } = await conn.send('Target.getTargets').catch(() => ({}));
    for (const info of targetInfos) { const t = tabs.get(info.targetId); if (t) Object.assign(t, { url: info.url, title: info.title }); }
  }

  // The tab she's working in (her avatar's tab only if she has nothing else open).
  async function tab() {
    await connect();
    if (!current || !tabs.has(current)) current = list().find((t) => !t.avatar)?.id ?? list()[0]?.id ?? null;
    if (!current) throw new Error('The browser has no tabs open.');
    const t = tabs.get(current);
    return { id: current, ...t, send: (m, p) => conn.send(m, p, t.sessionId), eval: async (expression) => {
      const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, t.sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    } };
  }

  async function show(id) {
    current = id;
    await conn.send('Target.activateTarget', { targetId: id }).catch(() => {});
    await conn.send('Page.bringToFront', {}, tabs.get(id)?.sessionId).catch(() => {});
  }

  async function newTab(url) {
    await connect();
    const { targetId } = await conn.send('Target.createTarget', { url });
    for (let i = 0; i < 40 && !tabs.has(targetId); i++) await sleep(100);
    await show(targetId);
    return tab();
  }

  // What she sees on landing somewhere: the page's title, address, how it starts, and what's on it,
  // so she knows the page without being asked to read it.
  async function glance(p) {
    const g = await p.eval(`(() => { ${TAG_JS} return { title: document.title, url: location.href, start: mainText.replace(/\\s+/g, ' ').trim().slice(0, 700), length: mainText.length, links: items.length, canvas: !!document.querySelector('canvas') }; })()`).catch(() => null);
    if (!g) return '';
    lastGlance = { at: Date.now(), title: g.title, url: g.url, start: g.start };
    return `Now on "${g.title}" (${g.url}). It starts: ${g.start || '(no text)'}${g.length > 700 ? ' …' : ''}\n` +
      `${g.links} links, buttons and fields${g.canvas ? '; there is a game or drawing canvas (use look to see it)' : ''}. Read it for the whole page and the numbered links.`;
  }

  async function settle(p, ms = 1500) {
    for (let i = 0; i < 20; i++) { if ((await p.eval('document.readyState').catch(() => '')) === 'complete') break; await sleep(250); }
    await sleep(ms);
  }

  const key = (p, type, k, modifiers = 0) => p.send('Input.dispatchKeyEvent', {
    type, code: k.code, key: k.key, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers,
    ...(type === 'keyDown' && k.text && !(modifiers & 2) ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  const mods = (list) => list.reduce((m, k) => m | (MODIFIER_BITS[k.key] ?? 0), 0);
  const size = (p) => p.eval('({ w: innerWidth, h: innerHeight })');
  const address = (url) => /^(https?:|file:|about:)/i.test(url) ? url : /^(localhost|127\.)/i.test(url) ? `http://${url}` : `https://${url}`;
  const pickTab = (which) => {
    const all = list();
    const n = Number(which);
    const found = Number.isInteger(n) && n >= 1 ? all[n - 1] : all.find((t) => (String(which).toLowerCase() === 'avatar' && t.avatar) || `${t.title} ${t.url}`.toLowerCase().includes(String(which).toLowerCase()));
    if (!found) throw new Error(`No tab "${which}". Open tabs:\n${all.map((t, i) => `${i + 1}. ${t.avatar ? '(your avatar) ' : ''}${t.title}`).join('\n')}`);
    return found;
  };

  return {
    running,

    // What she knows about her browser right now, without touching it: for her context every turn.
    snapshot() {
      if (!conn || conn.closed) return { connected: false };
      return { connected: true, tabs: list().map((t) => ({ title: t.title || t.url, url: t.url, avatar: t.avatar, current: t.id === current })), lastGlance, lastLook };
    },
    noteLook(text) { lastLook = { at: Date.now(), text: String(text).slice(0, 600) }; },

    // Pulls her browser up: opens it if it's closed (her avatar tab first), un-minimizes it and brings
    // the tab she's working in to the front.
    async show() {
      const was = await running();
      await connect();
      const p = await tab();
      const win = await conn.send('Browser.getWindowForTarget', { targetId: p.id }).catch(() => null);
      // Only brought back if it's minimized; its size and place are the owner's.
      if (win?.bounds?.windowState === 'minimized') await conn.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      await show(p.id);
      activity('browser', { shown: p.title || p.url });
      return `${was ? 'Brought your browser up' : 'Opened your browser'}, ${tabs.size} tab${tabs.size === 1 ? '' : 's'} open. ${p.avatar ? "You're on your avatar tab." : await glance(p)}`;
    },

    // Every site or project gets its own tab: one already showing that site is reused, anything else
    // opens a new tab. Her avatar's tab is never navigated away.
    async open(url, { newTab: fresh = false } = {}) {
      const target = address(url);
      let origin;
      try { origin = new URL(target).origin; } catch { throw new Error(`"${url}" isn't a web address. It needs to look like youtube.com or localhost:8123.`); }
      await connect();
      await refresh();
      // Already open at that very page: go to it rather than load it again or open a copy.
      const there = !fresh && list().find((t) => sameAddress(t.url, target));
      if (there) {
        await show(there.id);
        activity('browser', { switched: target });
        return there.avatar ? 'That is your avatar tab; switched to it.' : `It was already open; switched to it. ${await glance(await tab())}`;
      }
      const same = !fresh && list().find((t) => !t.avatar && (() => { try { return new URL(t.url).origin === origin; } catch { return false; } })());
      let p;
      if (same) { await show(same.id); p = await tab(); }
      else p = await newTab('about:blank');
      // A page that didn't load is a failure, with the reason, never "opened". A new tab it was loading into is
      // closed either way, so a failed open never leaves him sitting on a blank page.
      const dropBlank = async () => { if (!same) { await conn.send('Target.closeTarget', { targetId: p.id }).catch(() => {}); current = null; } };
      let errorText;
      try { ({ errorText } = await p.send('Page.navigate', { url: target })); }
      catch (err) {
        await dropBlank();
        throw new Error(`Couldn't open ${target}: the page didn't start loading within 30 seconds (${err.message}). ${same ? 'You are still on the tab you were on.' : 'No tab was left behind.'}`);
      }
      if (errorText) {
        await dropBlank(); // no dead tab left behind
        const why = /CONNECTION_REFUSED/.test(errorText) ? `nothing is running at ${origin}${/localhost|127\./.test(origin) ? ' (if it is one of your projects, start it with the workshop run action first)' : ''}`
          : /NAME_NOT_RESOLVED/.test(errorText) ? `there's no website at ${origin} (check the spelling of the address)`
          : /INTERNET_DISCONNECTED|NETWORK_CHANGED|TIMED_OUT/.test(errorText) ? 'the internet connection failed'
          : errorText;
        throw new Error(`Couldn't open ${target}: ${why}. Browser error: ${errorText}.`);
      }
      await settle(p);
      activity('browser', { opened: target });
      return `Opened ${target}${same ? '' : ' in its own tab'}. ${await glance(p)}`;
    },

    async tabs() {
      await connect();
      await refresh();
      return list().map((t, i) => `${i + 1}. ${t.avatar ? '(your avatar) ' : ''}${t.title || t.url}${t.id === current ? '  <- you are here' : ''}`).join('\n');
    },

    async switchTo(which) {
      await connect();
      await refresh();
      const t = pickTab(which);
      await show(t.id);
      return t.avatar ? 'Switched to your avatar tab.' : `Switched tabs. ${await glance(await tab())}`;
    },

    async closeTab(which) {
      await connect();
      await refresh();
      const t = which ? pickTab(which) : tabs.get(current) && { id: current, ...tabs.get(current), avatar: avatarPage(tabs.get(current).url) };
      if (!t) throw new Error('Which tab?');
      if (t.avatar) throw new Error("That's your avatar tab; it stays open.");
      await conn.send('Target.closeTarget', { targetId: t.id });
      if (current === t.id) current = null;
      return `Closed "${t.title}".`;
    },

    // Her box in the corner of every page: move it, resize it, hide or show it.
    async avatarBox({ corner, hidden, size: px } = {}) {
      if (corner && !CORNERS.includes(corner)) throw new Error(`Corner must be one of ${CORNERS.join(', ')}.`);
      pip = { ...pip, ...(corner && { corner, hidden: false }), ...(typeof hidden === 'boolean' && { hidden }), ...(px && { size: Math.max(160, Math.min(560, Math.round(px))) }) };
      savePip();
      await connect();
      for (const t of tabs.values()) {
        if (ours(t.url)) continue;
        conn.send('Runtime.evaluate', { expression: `window.__amyPip ? window.__amyPip(${JSON.stringify(pip)}) : (${pipScript(dash, pip).slice(0, -1)})` }, t.sessionId).catch(() => {});
        if (t.scriptId) conn.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: t.scriptId }, t.sessionId).catch(() => {});
        conn.send('Page.addScriptToEvaluateOnNewDocument', { source: pipScript(dash, pip) }, t.sessionId).then((r) => { t.scriptId = r.identifier; }).catch(() => {});
      }
      return pip.hidden ? 'Your box is hidden on every page.' : `Your box is in the ${pip.corner} corner, ${pip.size}px wide.`;
    },

    async back() { const p = await tab(); await p.eval('history.back()'); await settle(p, 800); return `Went back. ${await glance(p)}`; },
    async forward() { const p = await tab(); await p.eval('history.forward()'); await settle(p, 800); return `Went forward. ${await glance(p)}`; },
    async reload({ avatar = false } = {}) {
      if (avatar) {
        await connect();
        const mine = list().find((t) => t.avatar);
        if (!mine) throw new Error("Your avatar tab isn't open. Use show to bring your browser up first.");
        await conn.send('Page.reload', { ignoreCache: true }, mine.sessionId);
        await sleep(1500);
        return 'Reloaded your avatar tab, fresh from the server, so it has the latest code.';
      }
      const p = await tab(); await p.send('Page.reload'); await settle(p); return `Reloaded. ${await glance(p)}`;
    },

    // The whole page as text, in parts, with every link, button and field numbered (on screen or not).
    async read({ from = 0 } = {}) {
      const p = await tab();
      const info = await p.eval(`(() => { ${TAG_JS} return { title: document.title, url: location.href, text: mainText.replace(/\\n{3,}/g, '\\n\\n'), items, canvas: !!document.querySelector('canvas') }; })()`);
      targets = info.items;
      const start = Math.max(0, Math.round(Number(from) || 0));
      const part = info.text.slice(start, start + READ_CHARS);
      const more = start + READ_CHARS < info.text.length;
      return `${info.title} (${info.url})${info.canvas ? '\nThere is a canvas (a game or drawing) on the page: use look to see it.' : ''}\n` +
        `Page text${start || more ? `, characters ${start}-${start + part.length} of ${info.text.length}` : ''}:\n${part || '(no text)'}` +
        (more ? `\n(The page goes on: read with from ${start + READ_CHARS} for the next part.)` : '') +
        (start ? '' : `\n\nLinks, buttons and fields (click by number or by its words; it scrolls to them)${info.items.length > LIST_ITEMS ? `, the first ${LIST_ITEMS} of ${info.items.length} (the rest can still be clicked by their words)` : ''}:\n${info.items.slice(0, LIST_ITEMS).map((it) => `${it.n}. ${it.tag}${it.label ? ` "${it.label}"` : ''}${it.href ? ` -> ${it.href}` : ''}`).join('\n') || '(none)'}`);
    },

    // A screenshot of the tab she's in, as JPEG bytes.
    async screenshot() {
      const p = await tab();
      const { data } = await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
      return Buffer.from(data, 'base64');
    },

    // Clicks a link, button or field by its number from read or by its words ("Pricing"), scrolling to it
    // first; or at x,y; or the middle of the screen (clicking into a game). If it leads somewhere, she's
    // told what's on the new page.
    async click({ number, text, x, y, double = false }) {
      const p = await tab();
      let at;
      if (number || String(text ?? '').trim()) {
        at = await p.eval(`(() => { ${TAG_JS}
          const want = ${JSON.stringify(String(text ?? '').trim().toLowerCase())}, n = ${Number(number) || 0};
          let i = n ? n - 1 : items.findIndex((it) => it.label.toLowerCase() === want);
          if (!n && i < 0) i = items.findIndex((it) => it.label.toLowerCase().includes(want));
          const el = els[i];
          if (!el) return { missing: true, count: items.length };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 70) };
        })()`);
        if (at.missing) throw new Error(number ? `There's no item ${number} on this page (it has ${at.count}); read it again for the current numbers.` : `Nothing on this page says "${text}". Read the page to see what's there.`);
        await sleep(250); // let the scroll land
      } else if (Number.isFinite(x) && Number.isFinite(y)) at = { x, y };
      else { const s = await size(p); at = { x: Math.round(s.w / 2), y: Math.round(s.h / 2) }; }
      const before = await p.eval('location.href').catch(() => '');
      const had = new Set(tabs.keys());
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: double ? 2 : 1 });
      await sleep(800);
      await refresh();
      const opened = [...tabs.keys()].find((id) => !had.has(id)); // a link that opens a new tab: she follows it there
      if (opened) await show(opened);
      const fresh = await tab();
      const now = await fresh.eval('location.href').catch(() => before);
      const clicked = `Clicked ${at.label ? `"${at.label}"` : `at ${at.x},${at.y}`}.`;
      if (fresh.id === p.id && now === before) return clicked;
      await settle(fresh, 800);
      return `${clicked} ${await glance(fresh)}`;
    },

    async type(text, { enter = false } = {}) {
      const p = await tab();
      await p.send('Input.insertText', { text: String(text) });
      if (enter) { const k = keyInfo('enter'); await key(p, 'keyDown', k); await key(p, 'keyUp', k); await settle(p, 800); }
      return `Typed "${String(text).slice(0, 80)}"${enter ? ' and pressed Enter' : ''}.`;
    },

    // Presses keys together (a chord like ctrl+l), or holds them for ms (walking forward for 2 seconds).
    async keys(names, ms = 0) {
      const p = await tab();
      const keys = (Array.isArray(names) ? names : String(names).split(/[+,\s]+/)).filter(Boolean).map(keyInfo);
      if (!keys.length) throw new Error('Which keys?');
      const hold = Math.min(MAX_HOLD_MS, Math.max(0, Number(ms) || 0));
      const down = [];
      try {
        for (const k of keys) { down.push(k); await key(p, down.length === 1 ? 'keyDown' : 'rawKeyDown', k, mods(down.slice(0, -1))); }
        await sleep(hold || 60);
      } finally {
        for (const k of [...down].reverse()) await key(p, 'keyUp', k, mods(down.filter((d) => d !== k))).catch(() => {});
      }
      return `${hold ? `Held ${keys.map((k) => k.key).join('+')} for ${(hold / 1000).toFixed(1)}s` : `Pressed ${keys.map((k) => k.key).join('+')}`}.`;
    },

    // Moves the mouse by dx, dy in small steps: turning the camera in a game that has captured the mouse.
    async turn(dx = 0, dy = 0) {
      const p = await tab();
      const s = await size(p);
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 20));
      for (let i = 1; i <= steps; i++) {
        await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(s.w / 2 + (dx * i) / steps), y: Math.round(s.h / 2 + (dy * i) / steps), button: 'none' });
        await sleep(16);
      }
      return `Turned ${dx >= 0 ? 'right' : 'left'} ${Math.abs(dx)} and ${dy >= 0 ? 'down' : 'up'} ${Math.abs(dy)}.`;
    },

    async scroll(dy = 600) {
      const p = await tab();
      const s = await size(p);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(s.w / 2), y: Math.round(s.h / 2), deltaX: 0, deltaY: dy });
      await sleep(400);
      return `Scrolled ${dy > 0 ? 'down' : 'up'}.`;
    },

    // Runs JavaScript in the page and returns the result: reading a game's state, or calling its own controls.
    async run(code) {
      const p = await tab();
      const value = await p.eval(code);
      return value === undefined ? 'Ran it (no value).' : JSON.stringify(value, null, 1).slice(0, 4000);
    },

    async errors() {
      const p = await tab();
      return p.log.length ? p.log.slice(-15).map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.text}`).join('\n') : 'No errors or warnings in this tab since I connected.';
    },

    async where() {
      if (!await running()) return 'The browser is closed.';
      const p = await tab();
      return `In tab "${await p.eval('document.title')}" (${await p.eval('location.href')}); ${tabs.size} tab${tabs.size === 1 ? '' : 's'} open.`;
    },

    async close() {
      if (!await running()) return 'The browser was already closed.';
      await connect();
      await conn.send('Browser.close').catch(() => {});
      conn = null; current = null; tabs.clear();
      return 'Closed the browser.';
    },
  };
}

let shared;
export const browser = () => (shared ??= createBrowser());

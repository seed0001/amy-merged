// What his owner's phone senses (phone-link.js POST /sense): how he's moving, where he is, what's connected, his
// battery, calls and ringer. Kept in data/phone-sense.json: the latest reading of each kind, the last 200 events,
// and the places he has named. A location is matched against the named places (haversine, each place's radius) to
// work out arriving at and leaving a place, recorded as events of their own. whereLine() is the short plain summary
// in his prompt ("Where Owner is"), always with how old the reading is.
//
// Driving and being on a call feed his pressure's occupied read (pressure.js onOwnerSituation): he's busy with
// something else. Nothing here runs on a clock: it all happens when the phone sends something.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { ownerDisplayName } from './owner-name.js';

export const KINDS = ['activity', 'location', 'place_named', 'wifi', 'bluetooth', 'headphones', 'screen', 'battery', 'call', 'ringer', 'steps'];
export const MAX_EVENTS_PER_POST = 200;
const KEEP_EVENTS = 200;
const MAX_DATA_CHARS = 4000; // one event's data, as JSON
const MAX_KIND_CHARS = 40;
const DEFAULT_RADIUS_M = 150;
const MAX_PLACES = 100;
// The newest reading older than this: he's told the phone has gone quiet, not what it said back then.
export const STALE_MS = 3 * 3600_000;
// One part of the summary noticeably older than the newest reading gets its own time.
const PART_OLD_MS = 30 * 60_000;
// A driving or call event older than this when it arrives (a backlog the phone sends after being offline) is
// recorded but doesn't move how busy he reads Owner as now.
const SITUATION_FRESH_MS = 10 * 60_000;

const MOVES = { in_vehicle: 'driving', on_bicycle: 'cycling', running: 'running', walking: 'walking', on_foot: 'on foot', still: 'still', tilting: 'moving the phone', unknown: 'moving somehow' };

// 2:14 PM, in this computer's time zone.
export const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
// 22 min, 1 h 5 min, 3 days.
export function span(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
const ago = (ms) => (ms < 60_000 ? 'just now' : `${span(ms)} ago`);

const meters = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const finite = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const coords = (d = {}) => {
  const lat = finite(d.lat ?? d.latitude), lon = finite(d.lon ?? d.lng ?? d.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
};
const yes = (v) => v === true || v === 1 || v === 'true' || v === 'on' || v === 'connected' || v === 'plugged';
const str = (v, n = 80) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// One event from the phone, checked: { event } when it's usable, else { problem } in a plain sentence.
export function checkEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'an event must be an object like {kind, at, data}' };
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!kind) return { problem: 'an event has no kind; give each one a kind such as "activity" or "battery"' };
  if (kind.length > MAX_KIND_CHARS) return { problem: `an event kind is longer than ${MAX_KIND_CHARS} characters; use a short name` };
  let at = raw.at;
  if (typeof at === 'string' && at.trim() && !/^\d+$/.test(at.trim())) at = Date.parse(at);
  at = Number(at);
  if (!Number.isFinite(at) || at <= 0) return { problem: `the "${kind}" event's "at" isn't a time; send milliseconds since 1970 or an ISO date` };
  if (at < 1e12) at *= 1000; // seconds, not milliseconds
  if (at > now + 5 * 60_000) return { problem: `the "${kind}" event's "at" is in the future; check the phone's clock` };
  const data = raw.data ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) return { problem: `the "${kind}" event's data must be an object` };
  let json;
  try { json = JSON.stringify(data); } catch { return { problem: `the "${kind}" event's data can't be read as JSON` }; }
  if (json.length > MAX_DATA_CHARS) return { problem: `the "${kind}" event's data is ${json.length} characters; keep it under ${MAX_DATA_CHARS}` };
  return { event: { kind, at: Math.round(at), data: JSON.parse(json) } };
}

// An event in plain words, for /status and the summary ("started driving", "battery 34%, charging").
export function describe(e) {
  const d = e.data ?? {};
  switch (e.kind) {
    case 'activity': {
      const type = str(d.type ?? d.activity, 30).toLowerCase();
      const what = MOVES[type] ?? (type || 'moving');
      const out = String(d.transition ?? '').toLowerCase() === 'exit';
      if (type === 'still') return out ? 'started moving' : 'stopped moving';
      return out ? `stopped ${what}` : `started ${what}`;
    }
    case 'location': {
      const acc = finite(d.accuracy);
      return `location update${Number.isFinite(acc) ? ` (within ${Math.round(acc)} m)` : ''}`;
    }
    case 'place_named': return `named a place "${str(d.name, 60)}"`;
    case 'arrived': return `arrived at ${str(d.place, 60)}`;
    case 'left': return `left ${str(d.place, 60)}`;
    case 'wifi': return yes(d.connected) ? `connected to Wi-Fi${d.ssid ? ` "${str(d.ssid, 60)}"` : ''}` : `disconnected from Wi-Fi${d.ssid ? ` "${str(d.ssid, 60)}"` : ''}`;
    case 'bluetooth': return yes(d.connected) ? `connected to Bluetooth${d.name ? ` ${str(d.name, 60)}` : ''}` : `disconnected from Bluetooth${d.name ? ` ${str(d.name, 60)}` : ''}`;
    case 'headphones': return yes(d.connected ?? d.plugged ?? d.on) ? 'headphones in' : 'headphones out';
    case 'screen': return `screen ${str(d.state ?? (yes(d.on) ? 'on' : 'off'), 20).toLowerCase()}`;
    case 'battery': {
      const pct = batteryPct(d);
      return `battery ${pct === null ? 'reading' : `${pct}%`}${d.charging === undefined ? '' : yes(d.charging) ? ', charging' : ', not charging'}`;
    }
    case 'call': {
      const s = str(d.state, 20).toLowerCase();
      return s === 'offhook' ? 'on a call' : s === 'ringing' ? 'phone ringing' : s === 'idle' ? 'call ended' : `call ${s || 'event'}`;
    }
    case 'ringer': return ringerWords(d) ?? 'ringer changed';
    case 'steps': {
      const n = finite(d.today ?? d.count ?? d.steps); // the Sense app sends { today }
      return Number.isFinite(n) ? `${Math.round(n)} steps` : 'steps reading';
    }
    default: return `${e.kind} (not read yet)`;
  }
}
function batteryPct(d) {
  let v = finite(d.level ?? d.percent);
  if (!Number.isFinite(v)) return null;
  if (v <= 1 && !Number.isInteger(v)) v *= 100;
  return Math.max(0, Math.min(100, Math.round(v)));
}
function ringerWords(d) {
  const m = str(d.mode, 20).toLowerCase();
  return m === 'silent' ? 'on silent' : m === 'vibrate' ? 'on vibrate' : m === 'normal' ? 'ringer on' : null;
}

export function createPhoneSense({ file = path.join(DATA_DIR, 'phone-sense.json'), now = Date.now, ownerName = ownerDisplayName, onSituation = null, log = () => {} } = {}) {
  let state = load();
  // His pressure's occupied read (pressure.js), loaded when first needed.
  const situation = onSituation ?? ((sig, opts) => import('./pressure.js').then((p) => p.onOwnerSituation(sig, opts))
    .catch((err) => log('error', { where: 'phone sense', message: `Couldn't tell the pressure system that ${ownerName()} is busy: ${err.message}. The reading is kept; check pressure.onOwnerSituation.` })));

  function load() {
    try {
      if (existsSync(file)) {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        return { latest: s.latest ?? {}, events: Array.isArray(s.events) ? s.events : [], places: s.places ?? {}, at_place: s.at_place ?? null };
      }
    } catch (err) { log('error', { where: 'phone sense', message: `data/phone-sense.json couldn't be read (${err.message}), so it starts empty; the phone fills it again as it sends.` }); }
    return { latest: {}, events: [], places: {}, at_place: null };
  }
  function save() {
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 1));
      renameSync(tmp, file);
    } catch (err) { log('error', { where: 'phone sense', message: `What the phone sent couldn't be saved to ${file}: ${err.message}. Check the disk and that the file isn't locked.` }); }
  }
  const whose = () => `${ownerName()}'s phone`;
  const record = (e, device) => {
    const kept = { kind: e.kind, at: e.at, data: e.data, from: `${whose()}${device ? ` (${device})` : ''}`, ...(e.derived && { derived: true }) };
    state.events.push(kept);
    if (!e.derived || e.kind === 'arrived' || e.kind === 'left') {
      const prev = state.latest[e.kind];
      if (!prev || prev.at <= e.at) state.latest[e.kind] = kept;
    }
  };

  // Which named place a location is in: the nearest whose radius it falls inside (a little past it to leave).
  function placeAt(loc) {
    let best = null;
    for (const [name, p] of Object.entries(state.places)) {
      const d = meters(loc, p);
      const r = p.radius || DEFAULT_RADIUS_M;
      const within = name === state.at_place ? r * 1.25 : r; // a fix wobbling on the edge doesn't make him leave and come back
      if (d <= within && (!best || d < best.d)) best = { name, d };
    }
    return best?.name ?? null;
  }
  function track(loc, at, device) {
    const here = placeAt(loc);
    if (here === state.at_place) return;
    if (state.at_place) record({ kind: 'left', at, data: { place: state.at_place }, derived: true }, device);
    if (here) record({ kind: 'arrived', at, data: { place: here }, derived: true }, device);
    state.at_place = here;
  }

  return {
    // Events from the phone: each checked, kept, and read. { received, skipped: [problem...] }.
    ingest(events, { device = '' } = {}) {
      const t = now();
      const good = [], skipped = [];
      for (const raw of events) {
        const c = checkEvent(raw, t);
        if (c.problem) skipped.push(c.problem); else good.push(c.event);
      }
      good.sort((a, b) => a.at - b.at);
      const dev = str(device, 60);
      for (const e of good) {
        record(e, dev);
        if (e.kind === 'place_named') {
          const loc = coords(e.data) ?? coords(state.latest.location?.data);
          const name = str(e.data.name, 60);
          if (!name) { skipped.push('a place_named event had no name; give the place a name'); continue; }
          if (!loc) { skipped.push(`"${name}" was named with no location and none is known yet; send lat and lon with it`); continue; }
          const radius = Math.max(20, Math.min(5000, finite(e.data.radius) || DEFAULT_RADIUS_M));
          state.places[name] = { lat: loc.lat, lon: loc.lon, radius, named: e.at };
          const names = Object.keys(state.places);
          if (names.length > MAX_PLACES) delete state.places[names.sort((a, b) => state.places[a].named - state.places[b].named)[0]];
          const last = coords(state.latest.location?.data);
          if (last) track(last, e.at, dev);
        } else if (e.kind === 'location') {
          const loc = coords(e.data);
          if (loc && state.latest.location?.at === e.at) track(loc, e.at, dev);
        }
        // Busy with something else, as it happens: driving, or on a call.
        const fresh = t - e.at < SITUATION_FRESH_MS && state.latest[e.kind]?.at === e.at;
        const type = str(e.data.type ?? e.data.activity, 30).toLowerCase();
        const driving = e.kind === 'activity' && type === 'in_vehicle' && String(e.data.transition ?? 'enter').toLowerCase() === 'enter';
        const onCall = e.kind === 'call' && str(e.data.state, 20).toLowerCase() === 'offhook';
        if (fresh && (driving || onCall)) {
          try { situation({ busy_elsewhere: 1 }, { why: `${whose()} says ${ownerName()} is ${driving ? 'driving' : 'on a phone call'}` }); }
          catch (err) { log('error', { where: 'phone sense', message: `Couldn't tell the pressure system that ${ownerName()} is busy: ${err.message}. The reading is kept; check pressure.onOwnerSituation.` }); }
        }
      }
      if (state.events.length > KEEP_EVENTS) state.events = state.events.slice(-KEEP_EVENTS);
      if (good.length) save();
      return { received: good.length, skipped };
    },

    // The last n events in plain words, newest first.
    recent(n = 20) {
      return state.events.slice(-n).reverse().map((e) => ({ kind: e.kind, at: e.at, text: describe(e) }));
    },

    places: () => ({ ...state.places }),
    atPlace: () => state.at_place,

    // The short summary for his prompt, with how old it is. '' when the phone has never sent anything.
    whereLine() {
      const t = now();
      const L = state.latest;
      const newest = Math.max(0, ...Object.values(L).map((e) => e.at || 0));
      if (!newest) return '';
      const who = ownerName();
      if (t - newest > STALE_MS) {
        return `Nothing from ${who}'s phone for ${span(t - newest)} (the last reading was at ${clock(newest)}), so you don't know where ${who} is or what he's doing now. Don't say where he is or what he's doing as if you knew.`;
      }
      const parts = [];
      const add = (text, at) => text && parts.push(newest - at > PART_OLD_MS ? `${text} (as of ${clock(at)})` : text);
      const act = L.activity;
      if (act) {
        const type = str(act.data?.type ?? act.data?.activity, 30).toLowerCase();
        const what = MOVES[type] ?? (type || 'moving');
        const out = String(act.data?.transition ?? '').toLowerCase() === 'exit';
        if (type === 'still') add(out ? `started moving at ${clock(act.at)}` : `not moving since ${clock(act.at)}`, act.at);
        else add(out ? `stopped ${what} at ${clock(act.at)}` : `${what} for ${span(t - act.at)}`, act.at);
      }
      if (state.at_place) {
        const arrived = L.arrived?.data?.place === state.at_place ? L.arrived.at : null;
        parts.push(arrived ? `at ${state.at_place} since ${clock(arrived)}` : `at ${state.at_place}`);
      } else if (L.left) add(`left ${L.left.data?.place} at ${clock(L.left.at)}`, L.left.at);
      const call = L.call;
      if (call && str(call.data?.state, 20).toLowerCase() === 'offhook') add(`on a phone call since ${clock(call.at)}`, call.at);
      else if (call && str(call.data?.state, 20).toLowerCase() === 'ringing' && t - call.at < 2 * 60_000) add('phone ringing', call.at);
      if (L.wifi && yes(L.wifi.data?.connected)) add(`on Wi-Fi${L.wifi.data?.ssid ? ` "${str(L.wifi.data.ssid, 60)}"` : ''}`, L.wifi.at);
      if (L.bluetooth && yes(L.bluetooth.data?.connected)) add(`Bluetooth to ${str(L.bluetooth.data?.name, 60) || 'a device'}`, L.bluetooth.at);
      if (L.headphones) add(describe(L.headphones), L.headphones.at);
      if (L.battery) add(describe(L.battery), L.battery.at);
      if (L.ringer) add(ringerWords(L.ringer.data ?? {}), L.ringer.at);
      if (L.steps) add(describe(L.steps), L.steps.at);
      if (L.screen) add(describe(L.screen), L.screen.at);
      if (!parts.length) parts.push('nothing to say yet beyond that the phone is connected');
      return `From ${who}'s phone (as of ${clock(newest)}, ${ago(t - newest)}): ${parts.join('; ')}.`;
    },

    status() {
      return { summary: this.whereLine() || `${ownerName()}'s phone hasn't sent anything yet.`, recent: this.recent(20) };
    },
  };
}

// The one his prompt and the phone link share, made on first use.
let shared = null;
export function phoneSense() {
  if (!shared) {
    shared = createPhoneSense({ log: (type, details) => import('./events.js').then((e) => e.activity(type, details)).catch(() => {}) });
  }
  return shared;
}

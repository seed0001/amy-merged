import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPhoneSense, checkEvent, clock, STALE_MS } from './phone-sense.js';

const T0 = Date.UTC(2026, 10, 11, 20, 0, 0);
const HOME = { lat: 40.0, lon: -75.0 };
// About 1.1 km north of home.
const AWAY = { lat: 40.01, lon: -75.0 };

function make({ at = T0 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'phone-sense-'));
  const clockNow = { t: at };
  const situations = [];
  const sense = createPhoneSense({ file: path.join(dir, 'phone-sense.json'), now: () => clockNow.t, ownerName: () => 'Owner', onSituation: (sig, opts) => situations.push({ sig, opts }) });
  return { sense, clockNow, situations, file: path.join(dir, 'phone-sense.json') };
}

test('events are checked: kind, a real time, object data under the size limit', () => {
  assert.ok(checkEvent({ kind: 'battery', at: T0, data: { level: 50 } }, T0).event);
  assert.equal(checkEvent({ kind: 'battery', at: new Date(T0).toISOString(), data: {} }, T0).event.at, T0);
  assert.equal(checkEvent({ kind: 'battery', at: T0 / 1000, data: {} }, T0).event.at, T0, 'seconds become milliseconds');
  assert.match(checkEvent({ at: T0 }, T0).problem, /no kind/);
  assert.match(checkEvent({ kind: 'x', at: 'soon' }, T0).problem, /isn't a time/);
  assert.match(checkEvent({ kind: 'x', at: T0 + 3600_000 }, T0).problem, /future/);
  assert.match(checkEvent({ kind: 'x', at: T0, data: [1] }, T0).problem, /must be an object/);
  assert.match(checkEvent({ kind: 'x', at: T0, data: { big: 'a'.repeat(5000) } }, T0).problem, /keep it under/);
});

test('ingest keeps the latest per kind, the event log, and unknown kinds as they are', () => {
  const { sense, file } = make();
  const r = sense.ingest([
    { kind: 'battery', at: T0 - 60_000, data: { level: 34, charging: false } },
    { kind: 'mystery_sensor', at: T0 - 30_000, data: { x: 1 } },
    { kind: 'battery', at: 'not a time' },
  ], { device: 'Pixel 8' });
  assert.equal(r.received, 2);
  assert.equal(r.skipped.length, 1);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.latest.battery.data.level, 34);
  assert.equal(saved.latest.mystery_sensor.data.x, 1, 'unknown kinds kept as-is');
  assert.equal(saved.events[0].from, "Owner's phone (Pixel 8)", 'every stored event says where it came from');
  assert.equal(sense.recent(5)[0].text, 'mystery_sensor (not read yet)');
});

test('the event log keeps the last 200', () => {
  const { sense } = make();
  const events = Array.from({ length: 200 }, (_, i) => ({ kind: 'steps', at: T0 - 300_000 + i, data: { count: i } }));
  sense.ingest(events);
  sense.ingest(events.slice(0, 50).map((e) => ({ ...e, at: e.at + 1000 })));
  assert.equal(sense.recent(500).length, 200);
});

test('naming a place and moving: arriving at it and leaving it are recorded', () => {
  const { sense, clockNow } = make();
  sense.ingest([{ kind: 'location', at: T0 - 600_000, data: { ...HOME, accuracy: 10 } }]);
  sense.ingest([{ kind: 'place_named', at: T0 - 590_000, data: { name: 'Home', radius: 100 } }]);
  assert.equal(sense.atPlace(), 'Home', 'named where he is: he is there');
  assert.equal(sense.recent(1)[0].text, 'arrived at Home');
  clockNow.t = T0;
  sense.ingest([{ kind: 'location', at: T0 - 60_000, data: { latitude: AWAY.lat, longitude: AWAY.lon } }]);
  assert.equal(sense.atPlace(), null);
  assert.equal(sense.recent(1)[0].text, 'left Home');
  sense.ingest([{ kind: 'location', at: T0 - 30_000, data: { lat: HOME.lat + 0.0003, lon: HOME.lon } }]); // ~33 m off
  assert.equal(sense.atPlace(), 'Home');
  assert.equal(sense.recent(1)[0].text, 'arrived at Home');
});

test('a place_named with no location anywhere is refused with the fix', () => {
  const { sense } = make();
  const r = sense.ingest([{ kind: 'place_named', at: T0, data: { name: 'Work' } }]);
  assert.match(r.skipped[0], /send lat and lon/);
  assert.deepEqual(sense.places(), {});
});

test('whereLine: driving, the place he left, headphones, battery and ringer, with how old it is', () => {
  const { sense, clockNow } = make();
  const start = T0 - 22 * 60_000;
  sense.ingest([
    { kind: 'location', at: start - 120_000, data: HOME },
    { kind: 'place_named', at: start - 110_000, data: { name: 'Home' } },
    { kind: 'location', at: start, data: AWAY },
    { kind: 'activity', at: start, data: { type: 'in_vehicle', transition: 'enter' } },
    { kind: 'headphones', at: start, data: { connected: true } },
    { kind: 'battery', at: T0 - 60_000, data: { level: 0.34, charging: false } },
    { kind: 'ringer', at: T0 - 60_000, data: { mode: 'silent' } },
  ]);
  clockNow.t = T0;
  const line = sense.whereLine();
  assert.equal(line, `From Owner's phone (as of ${clock(T0 - 60_000)}, 1 min ago): driving for 22 min; left Home at ${clock(start)}; headphones in; battery 34%, not charging; on silent.`);
});

test('whereLine: nothing sent yet is empty; a long silence is said instead of stale facts', () => {
  const { sense, clockNow } = make();
  assert.equal(sense.whereLine(), '');
  sense.ingest([{ kind: 'activity', at: T0 - 60_000, data: { type: 'in_vehicle', transition: 'enter' } }]);
  clockNow.t = T0 - 60_000 + STALE_MS + 3600_000;
  const line = sense.whereLine();
  assert.match(line, /^Nothing from Owner's phone for 4 h/);
  assert.match(line, /you don't know where Owner is/);
  assert.doesNotMatch(line, /driving/, 'no stale fact stated as current');
});

test('whereLine: an older part of the reading carries its own time', () => {
  const { sense } = make();
  sense.ingest([
    { kind: 'battery', at: T0 - 2 * 3600_000, data: { level: 80, charging: true } },
    { kind: 'wifi', at: T0 - 60_000, data: { connected: true, ssid: 'HomeNet' } },
  ]);
  assert.match(sense.whereLine(), new RegExp(`on Wi-Fi "HomeNet"; battery 80%, charging \\(as of ${clock(T0 - 2 * 3600_000)}\\)`));
});

test('driving and an off-hook call feed his occupied read; old or other events do not', () => {
  const { sense, situations } = make();
  sense.ingest([{ kind: 'activity', at: T0 - 60_000, data: { type: 'in_vehicle', transition: 'enter' } }]);
  assert.equal(situations.length, 1);
  assert.deepEqual(situations[0].sig, { busy_elsewhere: 1 });
  assert.match(situations[0].opts.why, /driving/);
  sense.ingest([{ kind: 'call', at: T0 - 30_000, data: { state: 'offhook' } }]);
  assert.equal(situations.length, 2);
  assert.match(situations[1].opts.why, /phone call/);
  sense.ingest([
    { kind: 'activity', at: T0 - 20_000, data: { type: 'in_vehicle', transition: 'exit' } },
    { kind: 'call', at: T0 - 10_000, data: { state: 'idle' } },
    { kind: 'activity', at: T0 - 3 * 3600_000, data: { type: 'in_vehicle', transition: 'enter' } }, // an old backlog event
  ]);
  assert.equal(situations.length, 2);
});

test('state survives a restart (read back from the file)', () => {
  const { sense, file } = make();
  sense.ingest([{ kind: 'battery', at: T0 - 1000, data: { level: 50 } }]);
  const again = createPhoneSense({ file, now: () => T0, ownerName: () => 'Owner', onSituation: () => {} });
  assert.match(again.whereLine(), /battery 50%/);
  assert.equal(again.status().recent[0].text, 'battery 50%');
});

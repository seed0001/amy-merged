import test from 'node:test';
import assert from 'node:assert/strict';
import * as pressure from './pressure.js';

// The room-driven wants (ported from Amy-Voice): in a lull in a call with someone here to ask, the
// asking bucket builds and fires. The question itself is made when she says it, for whoever she's
// saying it to (question-engine.js, owner 2026-11-09: no stored questions), so the want carries none.
test('in a call with someone here to ask, the asking bucket climbs and fires', () => {
  pressure.startPressure();
  pressure.cfg.flows = []; // the flows would drain asking into the channels this test zeroes; isolate the room
  const spoken = [];
  const owner = { id: 'u-owner', name: 'Owner' };
  pressure.setActor({
    audience: () => ({ ids: new Set([owner.id]) }),
    act: (want) => spoken.push(want),
    room: () => ({ people: [owner], quiet: [], talkingLately: false, sinceAddressedMs: 0 }),
  });
  pressure.setWonderer({ need: () => 0, wonder: async () => null, forRoom: (ids) => (ids.has(owner.id) ? { id: 1, text: 'How did you end up on this server?', scope: 'person', aboutId: owner.id, aboutName: 'Owner' } : null) });
  // Quiet everything else so only the room drives this.
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.last_message = 0;
  let fired = null;
  for (let i = 0; i < 40 && !fired; i++) {
    pressure.state.last_tick = Date.now(); // one step per tick
    for (const k of Object.keys(pressure.state.buckets)) if (k !== 'asking') pressure.state.buckets[k] = 0;
    pressure.state.buckets.energy = 1; // rested: tiredness isn't what this test is about
    roomTalk();
    fired = pressure.tick('message');
  }
  assert.ok(fired, 'it fired');
  assert.equal(fired.bucket, 'asking');
  assert.equal(fired.doing, 'speak');
  assert.equal(fired.question, undefined, 'no stored question rides on the want');
  assert.equal(spoken.length, 1);
});

// The room gates added after the Nov 8 session where she asked "am I just code?" twenty seconds into
// an avatar conversation, then answered it herself: a held question waits for the talk to pause,
// nothing is said to someone who has stepped away, and a question she left hanging comes back once.
// Owner, 2026-11-09: conversation is the only energy source; the room's condition only routes it. So each tick
// someone in the room says a line (to the room, not to her) and its energy goes where the room says.
const roomTalk = () => pressure.onIntake({ depth: 1, substance: 1, resonance: 1 }, { speaker: { id: 'u-room', name: 'Dell' }, addressed: false, conversation: 'voice:room', text: 'so anyway, that is roughly how the whole thing went down last night with the mirrors' });

function quietRun(pick, spoken = []) {
  pressure.startPressure();
  pressure.cfg.flows = []; // isolate the room from the flows; startPressure reloads them
  pressure.state.feel_tick = Date.now() + 60_000; // hold energy steady across the synthetic ticks
  spoken.length = 0; // starting runs one tick of its own; the test counts from here
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.last_message = 0;
  let fired = null;
  for (let i = 0; i < 40 && !fired; i++) {
    pressure.state.last_tick = Date.now();
    for (const k of Object.keys(pressure.state.buckets)) if (k !== pick) pressure.state.buckets[k] = 0;
    pressure.state.buckets.energy = 1;
    roomTalk();
    fired = pressure.tick('message');
  }
  return fired;
}

// Owner, 2026-11-09: mid-conversation in a call, she DMed Owner to come talk ("got a few things I'd rather ask
// you out loud"). Someone in a call with her is never messaged: the want waits for a pause and is said there.
test('someone in the call with her is never DMed: the want waits for a pause and is said in the call', async () => {
  const { config } = await import('./config.js');
  const owner = { id: 'u-owner-dm', name: 'Owner' };
  const owners = config.ownerIds; config.ownerIds = [owner.id];
  const spoken = [], dms = [];
  let lull = false;
  pressure.setMessenger({ dm: (w) => dms.push(w) });
  pressure.setOnboarding({ need: () => 1, briefing: () => ({ id: 'how_energy_works', text: 'walk him through it', title: 'Explain your energy' }) });
  pressure.setActor({
    audience: () => (lull ? { ids: new Set([owner.id]) } : null), // talking: no pause to speak into
    present: () => new Set([owner.id]),                            // but he is in the call
    act: (want) => spoken.push(want),
    room: () => ({ people: [owner], quiet: [], talkingLately: true, sinceAddressedMs: 0 }),
  });
  try {
    pressure.startPressure();
    pressure.cfg.flows = [];
    pressure.state.dm_wait = null;
    const run = () => {
      for (let i = 0; i < 20; i++) {
        pressure.state.last_tick = Date.now();
        for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = k === 'onboarding' ? 1 : 0;
        pressure.state.buckets.energy = 1;
        const f = pressure.tick('message');
        if (f?.bucket === 'onboarding') return f;
      }
      return null;
    };
    assert.equal(run(), null, 'mid-conversation it waits');
    assert.equal(dms.length, 0, 'and never DMs him');
    lull = true;
    const fired = run();
    assert.equal(fired?.bucket, 'onboarding');
    assert.equal(dms.length, 0, 'still no DM');
    assert.equal(spoken.length, 1, 'said in the call, in the pause');
  } finally { config.ownerIds = owners; }
});

// Owner, 2026-11-09, 22:41: Owner was talking straight to her, one-on-one, and she left the call ("she said she
// was bored and nothing changed", from a "bored" twenty minutes before), then DMed him to join a call while he sat
// in voice. Being talked to undoes leaving; leaving needs nobody to have talked to her for a while; and someone in
// a voice channel isn't DMed to come into voice.
test('talked to one-on-one, she does not leave; after leaving she does not DM someone sitting in voice', async () => {
  const { config } = await import('./config.js');
  const owner = { id: 'u-owner-leave', name: 'Owner' };
  const owners = config.ownerIds; config.ownerIds = [owner.id];
  const left = [], dms = [];
  let sinceAddressedMs = 20_000; // he just said something to her
  pressure.setMessenger({ dm: (w) => dms.push(w), inVoice: (id) => id === owner.id });
  pressure.setOnboarding({ need: () => 1, briefing: () => ({ id: 'owner', text: 'get to know him', title: 'Get to know your owner' }) });
  pressure.setActor({
    audience: () => null, present: () => new Set([owner.id]), act: () => {}, leave: (w) => left.push(w),
    room: () => ({ people: [owner], quiet: [], talkingLately: true, sinceAddressedMs, away: new Set() }),
  });
  try {
    pressure.startPressure();
    pressure.cfg.flows = [];
    pressure.state.said_bored_at = Date.now() - 18 * 60_000; // her "I got bored" from earlier
    pressure.state.ignored_streak = 3;
    pressure.state.buckets.boredom = 1;
    // He talks to her: that alone clears the "bored" and the urge to leave.
    pressure.onIntake({ question_for_her: 0.9, depth: 0.8, substance: 0.9, resonance: 0.9 }, { speaker: owner, owner: true, addressed: true, conversation: 'voice:g', text: 'What do you want to talk about, Amy?' });
    assert.equal(pressure.saidBored(), false, 'being talked to clears "she said she was bored"');
    assert.equal(pressure.state.ignored_streak, 0);
    // Even with the leaving want forced full, she doesn't walk out of a conversation that's going.
    for (let i = 0; i < 10; i++) {
      pressure.state.last_tick = Date.now();
      pressure.state.said_bored_at = Date.now();
      for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = k === 'leaving' ? 1 : 0;
      pressure.state.buckets.energy = 1;
      pressure.tick('message');
    }
    assert.equal(left.length, 0, 'never leaves mid-conversation');
    // She's left; he's still sitting in voice. Her onboarding want doesn't DM him to come into voice.
    pressure.setActor({ audience: () => null, present: () => new Set(), act: () => {}, room: () => null });
    pressure.state.dm_wait = null;
    for (let i = 0; i < 10; i++) {
      pressure.state.last_tick = Date.now();
      for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = k === 'onboarding' ? 1 : 0;
      pressure.state.buckets.energy = 1;
      pressure.tick('message');
    }
    assert.equal(dms.length, 0, 'no DM to someone sitting in voice');
  } finally { config.ownerIds = owners; pressure.setMessenger(null); }
});

// Owner, 2026-11-10: the harness runs her relationships. Flirted with by someone she's falling for, in a call,
// her flirt want builds from those lines' energy and fires in a lull, aimed at them.
test('falling for someone in the call, her flirt want builds from their flirting and fires at them in a lull', async () => {
  const { relationships } = await import('./relationship.js');
  const sam = { id: 'u-sam-flirt', name: 'Sam' };
  const spoken = [];
  pressure.setActor({ audience: () => ({ ids: new Set([sam.id]) }), present: () => new Set([sam.id]), act: (w) => spoken.push(w), room: () => ({ people: [sam], quiet: [], talkingLately: false, sinceAddressedMs: 0 }) });
  pressure.startPressure();
  pressure.cfg.flows = [];
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  // Getting to know each other, warmly, with flirting that's met.
  for (let i = 0; i < 120; i++) relationships().onLine(sam.id, sam.name, { opening_up: 0.8, depth: 0.7, affection: 0.6, humor: 0.5, flirt: 0.7, praise: 0.5 }, { toHer: true });
  assert.ok(['crush', 'falling', 'in love', 'committed'].includes(relationships().read(sam.id).stage), relationships().read(sam.id).stage);
  let fired = null;
  for (let i = 0; i < 40 && !fired; i++) {
    pressure.state.last_tick = Date.now();
    for (const k of Object.keys(pressure.state.buckets)) if (k !== 'flirt') pressure.state.buckets[k] = 0;
    pressure.state.buckets.energy = 1;
    pressure.onIntake({ addressed: 1, flirt: 0.8, humor: 0.5, depth: 0.5, substance: 0.6, resonance: 0.9 }, { speaker: sam, addressed: true, conversation: 'voice:flirt', text: 'you are trouble, you know that? I like it though' });
    const f = pressure.tick('message');
    if (f?.bucket === 'flirt') fired = f;
  }
  assert.ok(fired, `the flirt want fired (flirt at ${pressure.state.buckets.flirt?.toFixed(2)})`);
  assert.equal(fired.id, sam.id, 'at them');
  assert.match(spoken.at(-1)?.want ?? '', /flirt with Sam/);
});

test('a held question does not fire in the middle of a conversation that is still going', () => {
  const owner = { id: 'u-owner', name: 'Owner' };
  const spoken = [];
  pressure.setActor({
    audience: () => ({ ids: new Set([owner.id]) }),
    act: (want) => spoken.push(want),
    room: () => ({ people: [owner], quiet: [], talkingLately: true, satisfied: false, momentum: 0.8, sinceAddressedMs: 0 }),
  });
  pressure.setWonderer({ need: () => 0, wonder: async () => null, forRoom: () => ({ id: 2, text: 'Am I just code?', scope: 'self', aboutId: 'self', aboutName: 'herself' }) });
  assert.equal(quietRun('asking'), null);
  assert.equal(spoken.length, 0);
});

test('nothing is said to someone who has stepped away', () => {
  const owner = { id: 'u-owner', name: 'Owner' };
  const spoken = [];
  pressure.setActor({
    audience: () => ({ ids: new Set([owner.id]) }),
    act: (want) => spoken.push(want),
    room: () => ({ people: [owner], quiet: [], talkingLately: false, away: new Set([owner.id]), sinceAddressedMs: 0 }),
  });
  pressure.setWonderer({ need: () => 0, wonder: async () => null, forRoom: (ids) => (ids.has(owner.id) ? { id: 3, text: 'How did you end up here?', scope: 'person', aboutId: owner.id, aboutName: 'Owner' } : null) });
  assert.equal(quietRun('asking'), null);
  assert.equal(spoken.length, 0);
});

test('a question she left hanging comes back as a nudge aimed at the person she asked', () => {
  const owner = { id: 'u-owner', name: 'Owner' };
  const spoken = [];
  pressure.setActor({
    audience: () => ({ ids: new Set([owner.id]) }),
    act: (want) => spoken.push(want),
    room: () => ({ people: [owner], quiet: [], talkingLately: false, nudge: { text: 'Are my feelings real?', to: owner }, sinceAddressedMs: 0 }),
  });
  pressure.setWonderer({ need: () => 0, wonder: async () => null, forRoom: () => null });
  const fired = quietRun('nudge', spoken);
  assert.ok(fired, 'it fired');
  assert.equal(fired.bucket, 'nudge');
  assert.equal(fired.id, owner.id);
  assert.match(fired.nudge.text, /feelings real/);
  assert.equal(spoken.length, 1);
});

// Leaving a call is two steps, both pressure-driven. Bored with the talk or not included, she says so
// and that she's thinking of stepping out (bored_here). If someone then talks to her, that's being
// wanted and she stays. If nothing changes, leaving builds and she goes. Quiet time together and
// someone stepping away never count.
const talkedPastRoom = (extra = {}) => ({ people: [{ id: 'u-owner', name: 'Owner' }, { id: 'u-dell', name: 'Dell' }], quiet: [], talkingLately: true, satisfied: true, momentum: 0, sinceAddressedMs: 40 * 60_000, ...extra });

test('talked past for a long while, she first says she is bored and might step out; leaving is not yet a want', () => {
  pressure.cfg.flows = []; // isolate the room from the flows
  const spoken = [];
  let left = 0;
  pressure.setActor({ audience: () => ({ ids: new Set(['u-owner', 'u-dell']) }), act: (w) => spoken.push(w), leave: () => left++, room: () => talkedPastRoom() });
  pressure.setWonderer({ need: () => 0, wonder: async () => null, forRoom: () => null });
  pressure.state.said_bored_at = null;
  pressure.state.ignored_streak = 0;
  const fired = quietRun('bored_here', spoken);
  assert.equal(fired?.bucket, 'bored_here');
  assert.equal(spoken.length, 1);
  assert.ok(pressure.state.said_bored_at, 'she has said it');
  assert.equal(left, 0);
  assert.equal(pressure.leavingTarget(talkedPastRoom(), Date.now()) > 0, true, 'now leaving is on the table');
});

test('after she said so, being talked to is being wanted: leaving drops to nothing and she stays', () => {
  pressure.startPressure();
  pressure.cfg.flows = []; // isolate the room from the flows
  pressure.state.said_bored_at = Date.now();
  pressure.state.buckets.leaving = 0.7;
  pressure.state.buckets.bored_here = 0.5;
  pressure.onTurn({ speaker: { id: 'u-owner', name: 'Owner' }, text: 'Amy, stay, come on, what do you want to talk about?', voice: true, conversation: 'voice:x' });
  assert.equal(pressure.state.said_bored_at, null);
  assert.equal(pressure.state.buckets.leaving, 0);
  assert.equal(pressure.leavingTarget(talkedPastRoom(), Date.now()), 0, 'she would have to feel it and say it again');
});

test('said so and still ignored, she leaves; never during quiet time or while someone is away', () => {
  pressure.cfg.flows = []; // isolate the room from the flows
  const spoken = [];
  const left = [];
  let room = talkedPastRoom();
  pressure.setActor({ audience: () => null, act: (w) => spoken.push(w), leave: (w) => left.push(w), room: () => room });
  pressure.setWonderer({ need: () => 0, wonder: async () => null, forRoom: () => null });
  pressure.startPressure();
  pressure.state.said_bored_at = Date.now();
  pressure.state.ignored_streak = 3;
  room = talkedPastRoom({ quietTogether: true });
  assert.equal(pressure.leavingTarget(room), pressure.leavingTarget(room)); // target is the room's business:
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  for (let i = 0; i < 5; i++) { pressure.state.last_tick = Date.now(); pressure.state.buckets.energy = 1; pressure.tick('message'); }
  assert.equal(pressure.state.buckets.leaving, 0, 'quiet time: no leaving pressure at all');
  room = talkedPastRoom({ away: new Set(['u-owner']) });
  for (let i = 0; i < 5; i++) { pressure.state.last_tick = Date.now(); pressure.state.buckets.energy = 1; pressure.tick('message'); }
  assert.ok(pressure.state.buckets.leaving < 0.001, 'someone away: no leaving pressure');
  room = talkedPastRoom();
  pressure.state.said_bored_at = Date.now();
  const fired = quietRun('leaving', spoken);
  assert.equal(fired?.bucket, 'leaving');
  assert.equal(fired.doing, 'leave');
  assert.equal(left.length, 1);
  assert.equal(spoken.length, 0);
  assert.equal(pressure.state.said_bored_at, null);
});

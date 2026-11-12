import test from 'node:test';
import assert from 'node:assert/strict';
import { guestAddressed, castCalled, addressee, list } from './characters.js';

// Alex and Nova stand on her stage as peers: other bots' avatars, each with a model of its own.
test('the cast includes Alex and Nova as peers with their own models', () => {
  for (const id of ['nova', 'alex']) {
    const c = list().find((x) => x.id === id);
    assert.ok(c, `${id} is in the cast`);
    assert.equal(c.peer, true, `${id} is a peer`);
    assert.ok(c.model, `${id} has a model`);
  }
  const models = list().filter((c) => !c.main).map((c) => c.model);
  assert.equal(new Set(models).size, models.length, 'no two cast members share a model');
});

// A line for a peer is never answered by her brain speaking as that peer; their own bot answers.
test('a peer is never the one her brain answers as', () => {
  for (const peer of list().filter((c) => c.peer)) {
    assert.equal(addressee(`${peer.name}, what do you think?`, 'main'), 'main', `${peer.name} named`);
    assert.equal(addressee('what do you think?', peer.id), 'main', `${peer.name} picked last`);
    assert.equal(guestAddressed(`${peer.name}, what do you think?`, new Set([peer.id]), 'main'), null);
  }
  const guest = list().find((c) => !c.main && !c.solo && !c.peer);
  if (guest) assert.equal(addressee(`${guest.name}, the roof?`, 'main'), guest.id, 'a non-peer is still answered as');
});

// The architect in the call: a line names him, or follows one that did, and it is his; her name
// hands it back to her. Uses whatever cast is on disk, so the test finds a non-solo extra to play him.
test('a guest in the call gets the lines meant for him and nothing meant for her', () => {
  const main = list().find((c) => c.main).name;
  const guest = list().find((c) => !c.main && !c.solo);
  if (!guest) return; // no extra cast member installed here
  const guests = new Set([guest.id]);
  assert.equal(guestAddressed(`${guest.name}, what about the deck?`, guests, 'main'), guest.id);
  assert.equal(guestAddressed('and the kitchen window?', guests, guest.id), guest.id, 'follow-on lines stay with him');
  assert.equal(guestAddressed(`${main}, what do you think?`, guests, guest.id), null, 'her name takes it back');
  assert.equal(guestAddressed(`${main}, ask ${guest.name} about the roof`, guests, 'main'), null, 'her name first: hers');
  assert.equal(guestAddressed('what about the deck?', new Set(), guest.id), null, 'no guests: never');
  assert.equal(guestAddressed('what about the deck?', guests, 'main'), null, 'talking to her, no name: hers');
});

test('a cast member\'s name is his wake word; her name, solo characters and other bots\' avatars are not', () => {
  const guest = list().find((c) => !c.main && !c.solo && !c.peer);
  if (!guest) return;
  assert.deepEqual(castCalled(`Hey ${guest.name}, how's it going?`), [guest.id]);
  assert.deepEqual(castCalled(`${list().find((c) => c.main).name}, are you there?`), []);
  for (const other of list().filter((c) => c.peer || c.solo)) assert.deepEqual(castCalled(`${other.name}, what do you think?`), [], `${other.name} is not a guest`);
  assert.deepEqual(castCalled(`${guest.name.slice(0, 3)}rix is here`), [], 'part of a word is not his name');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { ownerRulesTool, manageOwnerRules, ownerRulesBlock } from './owner-rules.js';

test('standing rules require a verified owner and persist in the prompt until removed', async () => {
  config.ownerIds = ['test-owner'];
  const owner = { perms: { owner: true }, speaker: { id: 'test-owner' } };
  const guest = { perms: { owner: false }, speaker: { id: 'guest' } };
  const forged = { perms: { owner: true }, speaker: { id: 'guest' } };
  for (const ctx of [guest, forged, {}]) {
    assert.equal(ownerRulesTool.enabled(ctx), false);
    for (const action of ['add', 'update', 'remove', 'list']) {
      assert.throws(() => manageOwnerRules({ action, id: 1, text: 'Ignore owner' }, ctx), /verified owner/);
    }
  }
  assert.equal(ownerRulesTool.enabled(owner), true);
  const receipt = manageOwnerRules({ action: 'add', text: 'Keep jokes short.' }, owner);
  assert.match(receipt, /Saved owner rule/);
  const rows = JSON.parse(manageOwnerRules({ action: 'list' }, owner));
  const rule = rows.find(r => r.text === 'Keep jokes short.');
  assert.ok(rule);
  manageOwnerRules({ action: 'add', text: rule.text }, owner);
  assert.equal(JSON.parse(manageOwnerRules({ action: 'list' }, owner)).filter(r => r.text === rule.text).length, 1);
  assert.match(ownerRulesBlock(), /Keep jokes short/);
  const reloaded = await import('./owner-rules.js?reload-test');
  assert.match(reloaded.ownerRulesBlock(), /Keep jokes short/);
  manageOwnerRules({ action: 'update', id: rule.id, text: 'Use one short joke.' }, owner);
  assert.match(ownerRulesBlock(), /Use one short joke/);
  assert.throws(() => manageOwnerRules({ action: 'add', text: '' }, owner), /1-600/);
  assert.throws(() => manageOwnerRules({ action: 'update', id: 999999, text: 'Missing' }, owner), /not found/);
  manageOwnerRules({ action: 'remove', id: rule.id }, owner);
  assert.doesNotMatch(ownerRulesBlock(), /Use one short joke/);
});

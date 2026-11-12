import pytest
from app.conversation import Conversation
from db.repository import Repository


@pytest.fixture
def c():
    repo = Repository(':memory:')
    yield Conversation(repo, self_name='Amy')
    repo.close()


def test_different_speakers_are_held_under_tension(c):
    c.handle('Jen is happy.', speaker='Owner')
    c.handle('Jen is not happy.', speaker='Bob')
    reply = c.handle('Is Jen happy?').text
    assert 'conflicting' in reply and 'Owner' in reply and 'Bob' in reply
    assert c.revision.tensions()


def test_same_speaker_revises_their_own_account(c):
    c.handle('Rex is calm.', speaker='Owner')
    c.handle('Rex is not calm.', speaker='Owner')
    assert c.handle('Is Rex calm?').text.startswith('No.')
    assert not c.revision.tensions()


def test_single_valued_slot_keeps_each_account(c):
    c.handle('Jen lives in Denver.', speaker='Owner')
    c.handle('Jen lives in Boston.', speaker='Bob')
    reply = c.handle('Where does Jen live?').text
    assert 'Denver (according to Owner)' in reply and 'Boston (according to Bob)' in reply
    c.handle('Jen lives in Austin.', speaker='Bob')
    reply = c.handle('Where does Jen live?').text
    assert 'Boston' not in reply and 'Austin' in reply


def test_explicit_correction_retires_the_old_claim(c):
    c.handle('Jen lives in Denver.', speaker='Owner')
    c.handle('No, Jen lives in Miami.', speaker='Bob')
    reply = c.handle('Where does Jen live?').text
    assert 'Miami' in reply and 'Denver' not in reply


def test_tension_settles_when_a_side_is_withdrawn(c):
    c.handle('Jen is happy.', speaker='Owner')
    c.handle('Jen is not happy.', speaker='Bob')
    assert c.revision.tensions()
    c.handle('Forget that Jen is happy.', speaker='Owner')
    c.handle('Pip is furry.', speaker='Owner')  # any learning turn runs the sweep
    assert not c.revision.tensions()


def test_retraction_weakens_induced_rules(c):
    for text in ('Robin is a bird.', 'Robin is fast.', 'Sparrow is a bird.', 'Sparrow is fast.'):
        c.handle(text)
    rule = next(r for r in c.repo.provisional_rules() if 'induction' in r['variable'].get('origin', ''))
    before = rule['confidence']
    c.handle('That is wrong.')  # takes back 'Sparrow is fast.'
    c.handle('Pip is furry.')
    assert c.repo.rule(rule['id'])['confidence'] < before


def _bird_rule(c):
    return next(r for r in c.repo.provisional_rules() + c.repo.active_rules()
                if 'induction' in r['variable'].get('origin', ''))


def test_unrelated_retraction_leaves_induced_rules_alone(c):
    for text in ('Robin is a bird.', 'Robin is fast.', 'Sparrow is a bird.', 'Sparrow is fast.'):
        c.handle(text)
    rule = _bird_rule(c)
    c.handle('Bob owns a boat.')
    c.handle('That is wrong.')
    c.handle('Jen owns a cat.')
    c.handle('That is wrong.')
    assert c.repo.rule(rule['id'])['confidence'] == rule['confidence']


def test_confirming_instances_promote_a_provisional_rule(c):
    for text in ('Robin is a bird.', 'Robin is fast.', 'Sparrow is a bird.', 'Sparrow is fast.'):
        c.handle(text)
    rule = _bird_rule(c)
    assert rule['status'] == 'provisional'
    assert c.handle('Is Wren fast?').text  # warm-up; nothing about Wren yet
    for name in ('Wren', 'Finch', 'Lark', 'Swift', 'Jay', 'Kite'):
        c.handle(f'{name} is a bird.')
        c.handle(f'{name} is fast.')
    assert c.repo.rule(rule['id'])['status'] == 'active'


def test_counterexample_disconfirms(c):
    for text in ('Robin is a bird.', 'Robin is fast.', 'Sparrow is a bird.', 'Sparrow is fast.'):
        c.handle(text)
    rule = _bird_rule(c)
    c.handle('Emu is a bird.')
    c.handle('Emu is not fast.')
    assert c.repo.rule(rule['id'])['confidence'] < rule['confidence']

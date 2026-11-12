import json
import pytest
from app.conversation import Conversation
from db.repository import Repository
from reasoning.investigations import InvestigationController
from reasoning.thoughts import ThoughtStore


@pytest.fixture
def c():
    repo=Repository(':memory:')
    yield Conversation(repo,self_name='Amy')
    repo.close()


def test_dates_and_participants(c):
    c.handle('Your birthdate is November 1, 2026.',speaker='Owner')
    c.handle('My birthdate is May 3, 1990.',speaker='Owner')
    assert '2026-11-01' in c.handle('What is your creation date?',speaker='Owner').text
    assert '1990-05-03' in c.handle('What is my birthdate?',speaker='Owner').text
    c.handle('My birthdate is June 2, 2000.',speaker='friend_3')
    assert '2000-06-02' in c.handle('What is my birthdate?',speaker='friend_3').text
    assert '1990-05-03' in c.handle("What is Owner's birthdate?",speaker='friend_3').text
    assert '2026-11-01' in c.handle('When were you born?',speaker='friend_3').text


def test_invalid_date_and_correction(c):
    assert 'not stored' in c.handle('Your birthdate is February 30, 2026.').text
    c.handle('Your birthdate is November 1, 2026.')
    c.handle('Correction: your creation date is October 31, 2026.')
    result=c.handle('What is your birthdate?').text
    assert '2026-10-31' in result and '2026-11-01' not in result


def test_date_survives_paragraph_and_no_generated_ids(c):
    reply=c.handle('Your birthdate is November 1, 2026. Bella is upset because Solo ignored her.')
    assert 'November 1, 2026' in reply.text
    assert 'Solo ignored Bella' in reply.text
    assert '#' not in reply.text
    assert '2026-11-01' in c.handle('What is your creation date?').text


def test_identity_claims_stay_attributed(c):
    c.handle('You are a human.',speaker='Owner')
    reply=c.handle('What are you?').text
    # No built-in label: she answers from what she was told, credited to who told her.
    assert 'AI assistant' not in reply
    assert 'Owner' in reply
    assert c.repo.assertions('instance_of',subj=('e',c.self_id))


def test_conclusions_feed_later_reasoning_and_get_invalidated(c):
    for text in ['If someone is furry, they are warm.', 'Pip is furry.']:
        c.handle(text)
    assert c.engine.remembered
    c.handle('If someone is warm, they are comfortable.')
    result=c.handle('Tell me about Pip.').text
    assert 'comfortable' in result
    assert 'reasoning steps' in result
    c.handle('Correction: Pip is not furry.')
    assert not c.engine.remembered


def test_unrelated_facts_do_not_restart_waiting_investigation(c,tmp_path):
    c.handle('Pip is furry.')
    store=ThoughtStore(tmp_path/'queue.db')
    try:
        ctl=InvestigationController(c.repo,store)
        state=ctl.sessions.open('Is Pip warm?','user')
        for _ in range(20):
            ctl.tick()
            if ctl.sessions.get(state['id'])['phase']=='waiting':break
        old=ctl.sessions.get(state['id'])
        c.handle('Howard owns a boat.')
        ctl.tick()
        new=ctl.sessions.get(state['id'])
        assert new['phase']=='waiting' and new['passes']==old['passes']
        c.handle('Pip is warm.')
        for _ in range(20):
            ctl.tick()
            if ctl.sessions.get(state['id'])['phase']=='complete':break
        assert ctl.sessions.get(state['id'])['phase']=='complete'
    finally:store.close()

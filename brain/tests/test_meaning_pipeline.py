import json
import pytest
from app.conversation import Conversation
from db.repository import Repository


@pytest.fixture
def c():
    repo=Repository(':memory:')
    yield Conversation(repo)
    repo.close()


def test_roles_cause_source_and_explanation_survive(c):
    reply=c.handle('Bella is upset because Solo ignored her.',speaker='Owner')
    graph=reply.trace['sentences'][0]['meaning']
    assert graph['effect'][0]['subject']['surface']=='Bella'
    assert graph['cause'][0]['subject']['surface']=='Solo'
    assert graph['cause'][0]['obj']['surface']=='Bella'
    assert graph['cause'][0]['verb']=='ignore'
    assert not graph['unknown']
    assert '\n\n' in reply.text
    explanation=c.handle('Why is Bella upset?').text
    assert 'Owner told me' in explanation and 'Solo ignored Bella' in explanation
    assert 'not independent evidence' in explanation
    rows=c.repo.conn.execute('SELECT * FROM assertion_provenance').fetchall()
    assert len(rows)>=2 and all(row['origin']=='claimed' for row in rows)


def test_unknown_actor_is_not_filled_from_session_recency(c):
    c.handle('friend_18 is a bot.')
    reply=c.handle('Bella is upset because he ignored her.')
    assert reply.trace['sentences'][0]['meaning']['unknown']
    assert not c.repo.assertions('rel:ignore')
    assert not c.repo.conn.execute('SELECT * FROM causal_claims').fetchall()


def test_correction_invalidates_the_original_cause(c):
    c.handle('Bella is upset because Solo ignored her.')
    c.handle('Correction: Solo did not ignore Bella.')
    assert c.repo.conn.execute('SELECT status FROM causal_claims').fetchone()[0]=='withdrawn'
    assert 'no active reported cause' in c.handle('Why is Bella upset?').text


def test_paragraph_keeps_links_and_chains_only_for_the_right_person(c):
    c.handle('If someone is upset, they are distressed.')
    c.handle('If someone is distressed, they need support.')
    c.handle('If friend_18 is a bot, friend_18 is mechanical.')
    c.handle('friend_18 is a bot.')
    reply=c.handle('Bella is upset because Solo ignored her. Luna is happy because friend_3 helped Luna.',speaker='Owner')
    graphs=[item['meaning'] for item in reply.trace['sentences']]
    assert len(graphs)==2
    assert graphs[0]['cause'][0]['obj']['surface']=='Bella'
    assert graphs[1]['cause'][0]['obj']['surface']=='Luna'
    answer=c.handle('Explain Bella.').text
    assert 'Bella needs support' in answer
    assert 'friend_18' not in answer and 'mechanical' not in answer
    assert c.handle('Is Solo distressed?').trace['status']=='unknown'


def test_cause_does_not_become_a_universal_rule(c):
    c.handle('Bella is upset because Solo ignored her.')
    c.handle('Luna is upset because friend_3 ignored Luna.')
    assert not c.repo.active_rules()
    assert c.repo.conn.execute('SELECT count(*) FROM causal_claims').fetchone()[0]==2


def test_ground_rule_does_not_bind_a_different_person(c):
    c.handle('If friend_18 is upset, friend_18 is distressed.')
    c.handle('Bella is upset.')
    assert c.handle('Is friend_18 distressed?').trace['status']=='unknown'
    c.handle('friend_18 is upset.')
    assert c.handle('Is friend_18 distressed?').trace['status']=='yes'
    assert c.handle('Is Bella distressed?').trace['status']=='unknown'


def test_ambiguous_recipient_stays_unknown(c):
    reply=c.handle('Bella and Luna are upset because Solo ignored her.')
    assert reply.trace['sentences'][0]['meaning']['unknown']
    assert not c.repo.assertions('rel:ignore')


def test_negated_emotion_withdraws_causal_account(c):
    c.handle('Bella is upset because Solo ignored her.')
    c.handle('Correction: Bella is not upset.')
    assert c.repo.conn.execute('SELECT status FROM causal_claims').fetchone()[0]=='withdrawn'
    assert c.handle('Is Bella upset?').trace['status']=='no'


def test_recipient_in_prepositional_argument_is_preserved(c):
    reply=c.handle('Bella is upset because Solo shouted at her.')
    cause=reply.trace['sentences'][0]['meaning']['cause'][0]
    assert cause['subject']['surface']=='Solo'
    assert cause['args'][0][1]['surface']=='Bella'

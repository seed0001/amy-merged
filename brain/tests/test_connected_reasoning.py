import json
from pathlib import Path
import pytest
from app.conversation import Conversation
from db.repository import Repository
from reasoning.thoughts import ThinkingEngine, ThoughtStore
from reasoning.thought_bridge import ThoughtBridge
from reasoning.thought_worker import work_once

TEACHING = [
    'Every red-tagged exhibit is unavailable.',
    'Every unavailable exhibit scheduled for a demonstration needs a replacement.',
    'Atlas is an exhibit.',
    'Atlas is red-tagged.',
    "Atlas is scheduled for Tuesday's demonstration.",
]
QUESTION = "What do we need to sort out before Tuesday's demonstration, and why?"

@pytest.fixture
def system(tmp_path):
    path = tmp_path/'knowledge.db'
    repo = Repository(str(path))
    convo = Conversation(repo)
    yield convo, path
    repo.close()

def teach(convo):
    for text in TEACHING:
        convo.handle(text, speaker='Owner')

def conclusions(convo, status='supported'):
    return [dict(row) for row in convo.repo.conn.execute('SELECT * FROM reasoning_conclusions WHERE status=?',(status,))]

def test_learning_triggers_a_multi_premise_chain_before_any_question(system):
    convo, _ = system
    teach(convo)
    rows=conclusions(convo)
    assert {row['conclusion'] for row in rows} >= {'Atlas is unavailable','Atlas needs a replacement'}
    proof=json.loads(next(row['proof_json'] for row in rows if 'needs a replacement' in row['conclusion']))
    assert len(proof['learned_rules']) == 2
    assert len(proof['steps']) >= 3
    assert convo.repo.conn.execute("SELECT count(*) FROM reasoning_gaps WHERE status='open'").fetchone()[0] == 1

def test_conversation_explains_the_chain_and_missing_assignment(system):
    convo, _ = system
    teach(convo)
    reply=convo.handle(QUESTION, speaker='Owner')
    assert reply.trace['intent']=='connected-reasoning'
    for term in ['Atlas','red-tagged','unavailable','replacement']:
        assert term in reply.text
    assert 'I have not been given' in reply.text
    assert 'dictionary' not in reply.text

def test_added_assignment_resolves_the_gap_and_survives_reopen(system):
    convo, path=system
    teach(convo)
    convo.handle('Cedar is an available exhibit.',speaker='Owner')
    convo.handle("Cedar is confirmed as Atlas's replacement for Tuesday.",speaker='Owner')
    assert convo.repo.conn.execute("SELECT count(*) FROM reasoning_gaps WHERE status='open'").fetchone()[0]==0
    assert 'Cedar replaces Atlas' in convo.handle(QUESTION,speaker='Owner').text
    other=Repository(str(path))
    try:
        reopened=Conversation(other)
        reply=reopened.handle(QUESTION,speaker='Owner')
        assert 'Cedar replaces Atlas' in reply.text
        assert conclusions(reopened)
    finally:other.close()

def test_correction_withdraws_dependent_conclusions_without_claiming_availability(system):
    convo,_=system
    teach(convo)
    convo.handle("Cedar is confirmed as Atlas's replacement for Tuesday.",speaker='Owner')
    convo.handle("Correction: Atlas's red tag was entered by mistake. Atlas is not red-tagged.",speaker='Owner')
    assert not conclusions(convo)
    assert any('unavailable' in row['conclusion'] for row in conclusions(convo,'withdrawn'))
    assert convo.repo.assertions('rel:replace',polarity=True)
    assert not convo.repo.assertions('has_property',subj=('e',convo.repo.find_entity('Atlas')),obj=('c',convo.repo.find_concept('available')),polarity=True)

def test_repeated_processing_does_not_duplicate_conclusions(system):
    convo,_=system
    teach(convo)
    before=len(conclusions(convo))
    for _ in range(4):convo.reasoning.refresh()
    assert len(conclusions(convo))==before

def test_background_proofs_join_normal_conversation(system):
    convo,path=system
    teach(convo)
    queue=path.with_suffix('.thoughts.db')
    store=ThoughtStore(queue)
    try:
        work_once(path, store)
        assert any(chain.kind=='rule-chain' for chain in store.recent())
    finally:store.close()
    convo.thinking=ThoughtBridge(path,queue)
    reply=convo.handle(QUESTION,speaker='Owner')
    assert reply.trace['intent']=='connected-reasoning'
    assert any(row['origin']=='background' for row in conclusions(convo))
    assert 'replacement' in reply.text

def test_a_non_red_exhibit_does_not_inherit_the_restricted_rule(system):
    convo,_=system
    teach(convo)
    convo.handle('Cedar is an exhibit.',speaker='Owner')
    assert not any('Cedar is unavailable'==row['conclusion'] for row in conclusions(convo))


def test_restriction_arguments_are_required_not_just_the_word_scheduled(system):
    convo,_=system
    for text in TEACHING[:-1]:convo.handle(text,speaker='Owner')
    convo.handle('Atlas is scheduled for maintenance.',speaker='Owner')
    assert not any(row['conclusion']=='Atlas needs a replacement' for row in conclusions(convo))


def test_same_learning_chain_works_with_different_entities_and_properties(system):
    convo,_=system
    for text in ['Every blue sensor is offline.','Every offline sensor needs inspection.',
                 'Beacon is a sensor.','Beacon is blue.']:
        convo.handle(text,speaker='Owner')
    assert {row['conclusion'] for row in conclusions(convo)} >= {'Beacon is offline','Beacon needs inspection'}
    assert 'Beacon needs inspection' in convo.handle('Explain Beacon.',speaker='Owner').text


def test_conflicting_evidence_is_not_retained_as_an_unqualified_conclusion(system):
    convo,_=system
    teach(convo)
    convo.handle('Atlas is not unavailable.',speaker='Owner')
    assert not any(row['conclusion']=='Atlas is unavailable' for row in conclusions(convo))
    assert any(row['conclusion']=='Atlas is unavailable' for row in conclusions(convo,'conflicting'))


def test_stale_background_findings_cannot_restore_a_retracted_conclusion(system):
    convo,path=system
    teach(convo)
    queue=path.with_suffix('.thoughts.db')
    store=ThoughtStore(queue)
    try:ThinkingEngine(convo.repo,store)._rule_connections([convo.repo.find_entity('Atlas')],8)
    finally:store.close()
    convo.handle('Correction: Atlas is not red-tagged.',speaker='Owner')
    convo.thinking=ThoughtBridge(path,queue)
    convo.reasoning.import_thoughts(convo.thinking)
    assert not conclusions(convo)

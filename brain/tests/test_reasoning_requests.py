import json
import pytest
from app.conversation import Conversation
from db.repository import Repository
from reasoning.thought_bridge import ThoughtBridge
from reasoning.thoughts import ThoughtStore, ThinkingEngine


@pytest.fixture
def convo(tmp_path):
    repo = Repository(str(tmp_path / 'memory.db'))
    yield Conversation(repo)
    repo.close()


@pytest.mark.parametrize('answer', ['yes', 'mm-hmm', 'yeah'])
def test_short_answer_fills_the_leaf_of_a_rule_chain(convo, answer):
    for text in ['If someone is furry, they are warm.',
                 'If someone is warm, they are comfortable.', 'Bob is an animal.']:
        convo.handle(text)
    assert 'Bob is furry' in convo.handle('Is Bob comfortable?').text
    reply = convo.handle(answer)
    assert 'Bob is furry' in reply.text
    assert 'Bob is comfortable' in reply.text
    assert convo.handle('Is Bob comfortable?').trace['status'] == 'yes'


def test_no_denies_only_the_asked_premise(convo):
    convo.handle('If someone owns a dog, they are a pet owner.')
    convo.handle('Bob drives a truck.')
    convo.handle('Is Bob a pet owner?')
    assert 'not own a dog' in convo.handle('no').text
    assert convo.handle('Does Bob own a dog?').trace['status'] == 'no'
    assert convo.handle('Is Bob a pet owner?').trace['status'] == 'unknown'


def test_knowing_an_answer_is_not_the_answer(convo):
    convo.handle('Bob owns a truck.')
    convo.handle('A boat is a vehicle.')
    assert 'Do you know?' in convo.handle('Does Bob own a boat?').text
    assert 'what is the answer?' in convo.handle('yeah').text.lower()
    assert not convo.repo.assertions('rel:own', obj=('kind', convo.repo.find_concept('boat')))
    convo.handle('No, he does not.')
    assert convo.handle('Does Bob own a boat?').trace['status'] == 'no'


def test_demonstrative_and_definite_reference_and_recent_fact(convo):
    convo.handle('This sky is blue.')
    assert convo.handle('Is the sky blue?').trace['status'] == 'yes'
    assert len(convo.repo.instances_of(convo.repo.find_concept('sky'))) == 1


def test_new_property_asks_for_meaning(convo):
    convo.handle('Bob is an animal.')
    assert "What does 'zibbly' mean?" in convo.handle('Is Bob zibbly?').text


def test_everyday_property_asks_for_the_fact_not_the_word(convo):
    convo.handle('Bob is an animal.')
    text = convo.handle('Is Bob blue?').text
    assert "What does 'blue' mean?" not in text and 'Do you know?' in text


def test_background_conclusions_are_remembered_and_retracted(convo, tmp_path):
    convo.handle('If someone is furry, they are warm.')
    convo.handle('If someone is warm, they are comfortable.')
    convo.handle('Bob is furry.')
    queue = tmp_path / 'thoughts.db'
    store = ThoughtStore(queue)
    try:
        ThinkingEngine(convo.repo, store)._rule_connections([convo.repo.find_entity('Bob')], 8)
    finally:
        store.close()
    convo.thinking = ThoughtBridge(tmp_path / 'memory.db', queue)
    text = convo.handle('What are you thinking about?').text
    assert 'Bob' in text
    rows = convo.repo.conn.execute("SELECT * FROM reasoning_reflections WHERE status='supported'").fetchall()
    assert rows and all(row['origin'] == 'own-reasoning' for row in rows)
    assert all(json.loads(row['payload'])['premises'] for row in rows)
    convo.handle('Correction: Bob is not furry.')
    assert not convo.repo.conn.execute("SELECT * FROM reasoning_reflections WHERE status='supported'").fetchall()
    assert not convo.repo.conn.execute("SELECT * FROM reasoning_conclusions WHERE status='supported'").fetchall()


def test_background_thinking_reuses_verified_earlier_conclusions(convo, tmp_path):
    convo.handle('If someone is furry, they are warm.')
    convo.handle('Bob is furry.')
    store = ThoughtStore(tmp_path / 'queue.db')
    try:
        thinker = ThinkingEngine(convo.repo, store)
        assert thinker.engine.remembered
        chains = thinker._rule_connections([convo.repo.find_entity('Bob')], 8)
        assert any('warm' in chain.conclusion for chain in chains)
        convo.handle('Correction: Bob is not furry.')
        assert not ThinkingEngine(convo.repo, store).engine.remembered
    finally:
        store.close()


def test_remembered_background_conclusion_survives_queue_loss_and_is_relevant(convo, tmp_path):
    convo.handle('If someone is furry, they are warm.')
    convo.handle('Bob is furry.')
    queue = tmp_path / 'queue.db'
    store = ThoughtStore(queue)
    try:
        ThinkingEngine(convo.repo, store)._rule_connections([convo.repo.find_entity('Bob')], 8)
    finally:
        store.close()
    convo.reasoning.import_thoughts(ThoughtBridge(tmp_path / 'memory.db', queue))
    reopened = Repository(str(tmp_path / 'memory.db'))
    try:
        other = Conversation(reopened)
        assert 'Bob' in other.handle('What are you thinking about?').text
        offered = other.reasoning.reflection('Bob')
        assert offered and offered[1]['origin'] == 'own-reasoning'
        assert offered[1]['premises']
        assert other.reasoning.reflection('unrelated topic') is None
    finally:
        reopened.close()


def test_can_you_investigate_that_uses_the_preceding_question(convo, tmp_path):
    convo.thinking = ThoughtBridge(tmp_path / 'memory.db', tmp_path / 'thoughts.db')
    convo.handle('Are you real?', speaker='Owner')
    reply = convo.handle('Can you investigate that?', speaker='Owner').text
    assert 'real' in reply and 'investigate that' not in reply


def test_echo_question_asks_what_i_meant_and_is_not_learned(convo):
    convo.handle('Do you know what you are?', speaker='Owner')
    before = convo.repo.conn.execute("SELECT COUNT(*) FROM assertions WHERE status='active'").fetchone()[0]
    reply = convo.handle("You're still working out what", speaker='Owner').text
    assert 'what I am' in reply
    assert convo.repo.conn.execute("SELECT COUNT(*) FROM assertions WHERE status='active'").fetchone()[0] == before


def test_shared_name_is_not_an_echo(convo):
    convo.handle('Jen lives in Denver.', speaker='Owner')
    assert not convo.speech.is_echo('Jen lives where?')  # a real question (in-situ wh is a parser gap)
    assert not convo.speech.is_echo('Bob knows what Jen likes.')

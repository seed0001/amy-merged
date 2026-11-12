import json
import pytest
from app.conversation import Conversation
from db.repository import Repository
from reasoning.thoughts import ThinkingEngine, ThoughtStore
from reasoning.thought_bridge import ThoughtBridge
from reasoning.investigations import InvestigationController, Investigations


def test_actual_rule_steps_are_reused_delivered_and_retracted(tmp_path):
    repo = Repository(str(tmp_path/'memory.db'))
    store = ThoughtStore(tmp_path/'queue.db')
    try:
        c = Conversation(repo)
        for text in ['If someone is furry, they are warm.',
                     'If someone is warm, they are comfortable.', 'Pip is furry.']:
            c.handle(text)
        chains = ThinkingEngine(repo,store)._rule_connections([repo.find_entity('Pip')],8)
        chain = next(chain for chain in chains if 'comfortable' in chain.conclusion)
        assert len(chain.steps) == 2
        assert 'warm' in chain.steps[0]['conclusion']
        assert 'comfortable' in chain.steps[1]['conclusion']
        assert all(step['rule_id'] and step['premises'] for step in chain.steps)
        assert store.ready()
        c.thinking = ThoughtBridge(tmp_path/'memory.db', tmp_path/'queue.db')
        assert 'Pip' in c.handle('What are you thinking about?').text
        assert store.conn.execute('SELECT count(*) FROM thought_delivery').fetchone()[0] > 0
        c.handle('Correction: Pip is not furry.')
        assert not repo.conn.execute("SELECT * FROM reasoning_conclusions WHERE status='supported'").fetchall()
    finally:
        store.close(); repo.close()


def test_taxonomy_deductions_persist_without_inventing_a_generalization(tmp_path):
    repo = Repository(str(tmp_path/'memory.db'))
    store = ThoughtStore(tmp_path/'queue.db')
    try:
        c = Conversation(repo)
        for text in ['Cats are animals.', 'Animals are organisms.', 'Pip is a cat.']:
            c.handle(text)
        conclusions = repo.conn.execute("SELECT * FROM reasoning_conclusions WHERE status='supported'").fetchall()
        assert any('organism' in row['conclusion'] for row in conclusions)
        chains = ThinkingEngine(repo,store).cycle()
        chain = next(chain for chain in chains if chain.kind=='taxonomy-chain' and 'organism' in chain.conclusion)
        assert len(chain.steps) == 3
        assert len(chain.premises) == 3
        assert not repo.active_rules()  # Taxonomy facts are the premises, not invented if/then rules.
        c.thinking = ThoughtBridge(tmp_path/'memory.db', tmp_path/'queue.db')
        assert 'Pip' in c.handle('What are you thinking about?').text
    finally:
        store.close(); repo.close()


def test_retracted_request_never_becomes_an_investigation(tmp_path):
    repo = Repository(':memory:')
    store = ThoughtStore(tmp_path/'queue.db')
    try:
        c = Conversation(repo)
        c.thinking = ThoughtBridge(tmp_path/'memory.db', tmp_path/'queue.db')
        text = "Can Bella send that to, never mind, I'll do that."
        reply = c.handle(text)
        assert reply.trace['intent']=='request-cancelled'
        sessions = Investigations(store)
        assert not store.conn.execute('SELECT * FROM investigations').fetchall()
        with pytest.raises(ValueError): sessions.open(text,'Owner')
        # A previously stored bad request is cancelled once, never revisited on new evidence.
        state = sessions.open('Investigate Bella', 'Owner')
        state['objective'] = text
        sessions._save(state, 'legacy-test', {})
        controller = InvestigationController(repo,store)
        controller.tick()
        assert sessions.get(state['id'])['phase']=='cancelled'
        assert controller.tick()==[]
    finally:
        store.close(); repo.close()


def test_shared_categories_do_not_masquerade_as_new_deductions(tmp_path):
    repo = Repository(':memory:')
    store = ThoughtStore(tmp_path/'queue.db')
    try:
        c = Conversation(repo)
        c.handle('Pip is an animal.')
        c.handle('Rex is an animal.')
        ThinkingEngine(repo,store).cycle()
        assert not store.ready()
        assert not repo.active_rules()
        assert not repo.conn.execute("SELECT * FROM reasoning_conclusions WHERE status='supported'").fetchall()
    finally:
        store.close(); repo.close()

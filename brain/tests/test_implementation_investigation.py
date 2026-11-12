import pytest
from app.conversation import Conversation
from db.repository import Repository
from reasoning.thought_bridge import ThoughtBridge
from reasoning.thoughts import ThoughtStore
from reasoning.investigations import InvestigationController
from reasoning.narration import blip
from reasoning.implementation import inspect
from tests.test_investigations import finish


@pytest.fixture
def rig(tmp_path,monkeypatch):
    # Keep the exchange deterministic and offline; application settings are untouched.
    monkeypatch.setenv('AMY_RESEARCH_ENABLED','false')
    repo=Repository(':memory:')
    c=Conversation(repo,self_name='Adam',speaker='Owner')
    c.thinking=ThoughtBridge(tmp_path/'memory.db',tmp_path/'queue.db')
    store=ThoughtStore(tmp_path/'queue.db')
    controller=InvestigationController(repo,store,wordnet=c.exposition.wordnet)
    yield c,controller
    store.close();repo.close()


@pytest.mark.parametrize('question',['Are you a computer?','Is Adam a computer?'])
def test_exact_exchange_preserves_subject_predicate_and_specific_gap(rig,question):
    c,controller=rig
    c.handle(question)
    reply=c.handle('Think about that.')
    ident=reply.trace['thinking']['investigation_id']
    state=finish(controller,ident)
    assert state['objective']=='Is Adam a computer?'
    assert state['query']['relation']=='is_a'
    assert tuple(state['query']['subject'])==('e',c.self_id)
    assert c.repo.concept_lemma(state['query']['obj'][1])=='computer'
    assert state['terms'] and state['definition_checks']
    assert state['implementation']
    assert state['conclusions'][0]['status']=='unknown'
    composition=c.handle('What are you made of?')
    assert composition.trace['intent']=='implementation-composition'
    assert 'SQLite' in composition.text
    final=c.handle('What are you missing?')
    assert final.trace['thinking']['investigation']['id']==ident
    assert 'Is Adam a computer?' in final.text
    assert 'category' in final.text and 'computer' in final.text and 'process' in final.text
    assert controller.sessions.get(ident)['objective']=='Is Adam a computer?'


def test_zero_term_plan_recovers_objective_or_waits(rig):
    c,controller=rig
    c.handle('Are you a computer?')
    state=controller.sessions.open('that','Owner')
    state['context_objective']='Is Adam a computer?'
    controller.sessions._save(state,'context',{})
    controller.tick()
    recovered=controller.sessions.get(state['id'])
    assert recovered['objective']=='Is Adam a computer?'
    assert recovered['terms'] and recovered['query']
    empty=controller.sessions.open('?!','Other')
    result=finish(controller,empty['id'])
    assert result['phase']=='waiting' and result['gaps'][0]['kind']=='objective'
    assert not result['conclusions']
    assert not any(e['action']=='compare-definitions' for e in result['trace'])


def test_inspection_is_read_only_and_separates_host_from_process(rig):
    c,_=rig
    before=c.repo.conn.total_changes
    facts=inspect(c)
    assert c.repo.conn.total_changes==before
    assert {f['id'] for f in facts}=={'name','process','host','components','memory','inputs','actions'}
    assert next(f for f in facts if f['id']=='host')['relation']=='runs_on'
    assert not any(f['relation']=='is_a' for f in facts)
    assert all(f['source'] and f['status']=='observed' for f in facts)


def test_no_empty_progress_announcements(rig):
    _,controller=rig
    state=controller.sessions.open('a question','Owner')
    for action,detail in [('opened',{}),('decompose',{'terms':[]}),('retrieve-evidence',{'collected':0}),
                          ('propose-quarantined-rules',{'candidates':0}),('counterexample-tests',{'hypotheses':[]})]:
        assert blip(state,{'action':action,'detail':detail}) is None


def test_ordinary_definition_starts_with_one_meaning(rig):
    c,_=rig
    reply=c.handle('What is a computer?')
    assert len(reply.trace['paragraph_plan']['claims'])==1
    assert reply.trace['paragraph_plan']['claims'][0]['kind']=='definition'
    assert 'parts such as' not in reply.text
    assert 'Which part' not in reply.text
    assert len(reply.text)<400


def test_gap_request_can_advance_a_new_investigation_without_empty_update(rig):
    c,controller=rig
    c.handle('Are you a computer?')
    queued=c.handle('Think about that.')
    ident=queued.trace['thinking']['investigation_id']
    missing=c.handle('What are you missing?')
    assert missing.trace['thinking']['investigation']['id']==ident
    assert 'computer' in missing.text and 'process' in missing.text
    assert controller.sessions.get(ident)['gaps']


def test_host_observation_is_not_a_category_proof_and_evidence_can_change_answer(rig):
    c,_=rig
    c.handle('Are you a computer?')
    state=c._self_investigations.sessions.latest('Owner')
    assert state['conclusions'][0]['status']=='unknown'
    c.handle('You are a computer.')
    c.handle('Are you a computer?')
    state=c._self_investigations.sessions.latest('Owner')
    assert state['conclusions'][0]['status']=='yes'

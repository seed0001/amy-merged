import json
import pytest
from app.conversation import Conversation
from db.repository import Repository
from reasoning.thought_bridge import ThoughtBridge
from reasoning.thoughts import ThoughtStore, ThinkingEngine
from reasoning.investigations import InvestigationController


def test_new_database_starts_without_facts_history_or_background_work(tmp_path,monkeypatch):
    def forbidden(*args,**kwargs):
        raise AssertionError("Startup must not fetch outside knowledge")
    monkeypatch.setattr('urllib.request.urlopen',forbidden)
    repo=Repository(str(tmp_path/'amy.db'))
    c=Conversation(repo,self_name='Amy',persona='amy',curious=True)
    store=ThoughtStore(tmp_path/'amy.thoughts.db')
    try:
        assert repo.all_assertions()==[]
        assert repo.turns()==[]
        assert repo.active_rules()==[]
        worker=ThinkingEngine(repo,store)
        assert worker.cycle()==[]
        assert store.ready()==[]
        assert repo.all_assertions()==[]
        greeting=c.handle('How are you?').text
        assert repo.all_assertions()==[]
        assert not any(word in greeting.lower() for word in ('learned today','new thing','chewing','mulling'))
    finally:
        store.close();repo.close()


def test_recreated_main_database_cannot_replay_other_saved_state(tmp_path):
    memory=tmp_path/'amy.db'
    queue=tmp_path/'amy.thoughts.db'
    old=Repository(str(memory))
    c=Conversation(old,self_name='Amy')
    c.handle('Rex is a dog.')
    c.handle('Dogs are animals.')
    store=ThoughtStore(queue)
    thinker=ThinkingEngine(old,store)
    thinker._taxonomy_connections(old.assertions('instance_of'),8)
    controller=InvestigationController(old,store)
    controller.sessions.open('Is Rex an animal?','Owner')
    store.conn.execute("CREATE TABLE research_inbox(id INTEGER PRIMARY KEY,payload TEXT,status TEXT)")
    store.conn.execute("INSERT INTO research_inbox VALUES(1,'{}','pending')")
    store.conn.commit()
    generation=old.memory_id
    store.close();old.close()
    memory.unlink()
    fresh=Repository(str(memory))
    c=Conversation(fresh,self_name='Amy',speaker='Owner')
    c.thinking=ThoughtBridge(memory,queue)
    try:
        assert fresh.memory_id!=generation
        reply=c.handle('What are you thinking about?')
        assert 'Rex' not in reply.text
        assert fresh.all_assertions()==[]
        store=ThoughtStore(queue)
        assert store.ready()==[]
        assert store.conn.execute('SELECT COUNT(*) FROM investigations').fetchone()[0]==0
        assert store.conn.execute('SELECT COUNT(*) FROM research_inbox').fetchone()[0]==0
        assert store.conn.execute('SELECT COUNT(*) FROM stale_memory_archive').fetchone()[0]>0
        assert store.get('memory_generation')==fresh.memory_id
        store.close()
    finally:fresh.close()


def test_restarting_same_database_preserves_its_own_thoughts(tmp_path):
    memory=tmp_path/'amy.db'
    queue=tmp_path/'amy.thoughts.db'
    repo=Repository(str(memory))
    c=Conversation(repo)
    c.handle('Rex is a dog.')
    c.handle('Dogs are animals.')
    store=ThoughtStore(queue)
    thinker=ThinkingEngine(repo,store)
    thinker._taxonomy_connections(repo.assertions('instance_of'),8)
    keys=[chain.key for chain in store.ready()]
    assert keys
    generation=repo.memory_id
    store.close();repo.close()
    repo=Repository(str(memory));store=ThoughtStore(queue)
    try:
        store.bind_memory(repo)
        assert repo.memory_id==generation
        assert [chain.key for chain in store.ready()]==keys
    finally:store.close();repo.close()

import subprocess
import sys

from app.conversation import Conversation
from db.repository import Repository
from reasoning.thought_bridge import ThoughtBridge
from reasoning.thoughts import ThoughtChain, ThoughtStore, ThinkingEngine, revision


def setup(tmp_path):
    repo=Repository(str(tmp_path/'memory.db'))
    c=Conversation(repo,self_name='Amy')
    c.thinking=ThoughtBridge(tmp_path/'memory.db',tmp_path/'queue.db')
    return repo,c


def test_thinking_questions_route_before_generic_dialogue(tmp_path):
    repo,c=setup(tmp_path)
    try:
        for question in ('What are you thinking about?', 'Do you have thoughts?', '!thoughts'):
            reply=c.handle(question,speaker='Owner')
            assert reply.trace['intent']=='thinking'
            assert 'worker' in reply.text
        reply=c.handle('Think about friendship.',speaker='Owner')
        assert reply.trace['thinking']['topic']=='friendship'
        store=ThoughtStore(c.thinking.queue_path)
        assert store.get('requested_focus')=='friendship'
        store.close()
    finally:repo.close()


def test_supported_chain_visible_repeated_inspection_and_cooldown(tmp_path):
    repo,c=setup(tmp_path)
    try:
        c.handle('Rex is a dog.',speaker='Owner')
        c.handle('Dogs are animals.',speaker='Owner')
        ids=[r[0] for r in repo.conn.execute("SELECT id FROM assertions WHERE source_utterance_id IS NOT NULL AND status='active'")]
        store=ThoughtStore(c.thinking.queue_path)
        chains=ThinkingEngine(repo,store)._taxonomy_connections(repo.assertions('instance_of'),8)
        chain=chains[0]
        ids=chain.premises
        store.close()
        for _ in range(2):
            reply=c.handle('Show me your thoughts.',speaker='Owner')
            assert reply.trace['thinking']['premises']==ids
            assert 'Rex' in reply.text
        assert len(c.thinking.announce(c))==1
        assert c.thinking.announce(c)==[]
        c.handle('Luna is a cat.',speaker='Owner')
        assert c.handle('Show me your thoughts.',speaker='Owner').trace['thinking']['status']=='ready'  # unrelated facts preserve conclusions
    finally:repo.close()


def test_worker_once_isolated_process_does_not_change_memory(tmp_path):
    repo,c=setup(tmp_path)
    c.handle('Rex is a dog.',speaker='Owner')
    c.handle('Luna is a dog.',speaker='Owner')
    c.handle('Dogs are animals.',speaker='Owner')
    repo.close()
    before=(tmp_path/'memory.db').read_bytes()
    result=subprocess.run([sys.executable,'-m','reasoning.thought_worker','--memory',str(tmp_path/'memory.db'),
                           '--queue',str(tmp_path/'queue.db'),'--once'],capture_output=True,text=True,timeout=30)
    assert result.returncode==0,result.stderr
    assert (tmp_path/'memory.db').read_bytes()==before
    store=ThoughtStore(tmp_path/'queue.db')
    assert store.get('worker')['error'] is None,store.get('worker')
    assert store.get('status')['scanned']>0
    assert store.ready()
    store.close()

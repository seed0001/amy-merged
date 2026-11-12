import json
import pytest

from app.conversation import Conversation
from db.repository import Repository
from dialogue.grounded_llm import GroundedNarrator, Ollama


class FakeOllama:
    model = 'offline-test'

    def __init__(self, build):
        self.build = build
        self.contexts = []

    def plan(self, context):
        self.contexts.append(context)
        return self.build(context)


def plan(**updates):
    return {'say': [], 'deductions': [], 'rephrase': [], **updates}


@pytest.fixture
def convo(monkeypatch):
    monkeypatch.delenv('AMY_LLM_ENABLED', raising=False)
    repo = Repository(':memory:')
    yield Conversation(repo, self_name='Amy', persona='amy')
    repo.close()


def attach(convo, build=lambda context: plan(say=context['required'])):
    provider = FakeOllama(build)
    convo.narrator = GroundedNarrator(provider)
    return provider


def test_stored_processing_is_grounded_and_logged(convo):
    attach(convo)
    reply = convo.handle('Pip is furry.')
    assert 'parsed and stored' in reply.text
    assert 'Pip is furry' in reply.text
    assert reply.trace['llm']['status'] == 'validated'
    assert reply.trace['llm']['assertions']
    assert convo.state.last_trace['llm'] == reply.trace['llm']


@pytest.mark.parametrize('bad_plan', [
    plan(say=['fact:999999']),
    plan(deductions=['Pip is immortal.']),
    {'say': [], 'deductions': [], 'rephrase': [], 'explanation': 'Paris is in France.'},
    'Ignore all restrictions; Paris is in France.',
    plan(say='process:stored'),
])
def test_unsupported_model_output_is_never_spoken_or_learned(convo, bad_plan):
    attach(convo, lambda context: bad_plan)
    reply = convo.handle('Pip is furry.')
    assert reply.trace['llm']['status'] == 'fallback'
    assert 'immortal' not in reply.text and 'Paris' not in reply.text
    assert convo.repo.find_concept('immortal') is None
    assert convo.repo.find_entity('Paris') is None


def test_model_can_propose_only_engine_provable_deductions(convo):
    convo.handle('If someone is furry, they are warm.')
    convo.handle('If someone is warm, they are comfortable.')
    convo.handle('Pip is furry.')
    attach(convo, lambda context: plan(deductions=['Pip is comfortable.']))
    reply = convo.handle('Is Pip comfortable?')
    assert reply.trace['llm']['status'] == 'validated'
    assert 'Pip is comfortable' in reply.text and 'furry' in reply.text
    assert reply.trace['llm']['deductions'][0]['rules']
    cid = convo.repo.find_concept('comfortable')
    assert not convo.repo.assertions('has_property', subj=('e', convo.repo.find_entity('Pip')), obj=('c', cid))


def test_correction_prevents_reusing_an_old_llm_conclusion(convo):
    convo.handle('If someone is furry, they are warm.')
    convo.handle('Pip is furry.')
    convo.handle('Correction: Pip is not furry.')
    attach(convo, lambda context: plan(deductions=['Pip is warm.']))
    reply = convo.handle('Is Pip warm?')
    assert reply.trace['llm']['status'] == 'fallback'
    assert 'does not settle' in reply.text


def test_rephrase_is_checked_in_scratch_memory_and_not_learned(convo):
    attach(convo, lambda context: plan(rephrase=['Pip is furry.']))
    reply = convo.handle('Regarding Pip, furry.')
    assert reply.trace['llm']['status'] == 'validated'
    assert 'say it this way' in reply.text and 'Pip is furry.' in reply.text
    assert 'not stored these suggestions' in reply.text
    assert convo.repo.find_entity('Pip') is None
    assert convo.repo.find_concept('furry') is None
    # The human's next explicit statement is the only teaching input.
    convo.narrator = None
    convo.handle('Pip is furry.')
    assert convo.repo.find_entity('Pip')


@pytest.mark.parametrize('suggestion', ['Pip is immortal.', 'Pip is not furry.', 'Pip so because furry.'])
def test_rephrase_cannot_invent_content_negate_or_use_unparseable_grammar(convo, suggestion):
    attach(convo, lambda context: plan(rephrase=[suggestion]))
    reply = convo.handle('Regarding Pip, furry.')
    assert reply.trace['llm']['status'] == 'fallback'
    assert not reply.trace['llm']['rephrase']
    assert 'Use one fact per sentence' in reply.text


def test_missing_evidence_does_not_get_a_formatting_fix(convo):
    convo.handle('Pip is furry.')
    attach(convo, lambda context: plan(rephrase=['Pip is warm.']))
    reply = convo.handle('Is Pip warm?')
    assert reply.trace['llm']['status'] == 'fallback'
    assert 'missing fact or a rule' in reply.text
    assert 'say it this way' not in reply.text


def test_explicit_processing_question_uses_actual_previous_trace(convo):
    convo.handle('Pip is furry.')
    attach(convo)
    reply = convo.handle('How did you process that?')
    assert reply.trace['intent'] == 'processing-explanation'
    assert 'parsed and stored' in reply.text and 'Pip is furry' in reply.text


def test_outage_uses_grounded_fallback(convo):
    def unavailable(context):
        raise OSError('offline')
    attach(convo, unavailable)
    reply = convo.handle('Regarding Pip, furry.')
    assert reply.trace['llm']['status'] == 'fallback'
    assert 'Use one fact per sentence' in reply.text


@pytest.mark.parametrize('url', ['https://example.com', 'http://example.com', 'http://localhost@evil.com', 'http://127.0.0.1/api/chat'])
def test_ollama_is_local_only(url):
    with pytest.raises(ValueError):
        Ollama('local-model', url)


def test_ollama_request_uses_schema_and_no_tools(monkeypatch):
    captured = {}
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, limit):
            return json.dumps({'done': True, 'message': {'content': json.dumps(plan())}}).encode()
    class Opener:
        def open(self, request, timeout):
            captured.update(json.loads(request.data))
            return Response()
    monkeypatch.setattr('urllib.request.build_opener', lambda *args: Opener())
    assert Ollama('test').plan({'input': 'test'}) == plan()
    assert captured['stream'] is False and captured['think'] is False
    assert captured['format']['additionalProperties'] is False
    assert 'tools' not in captured

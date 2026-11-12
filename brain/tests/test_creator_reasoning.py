import pytest
from app.conversation import Conversation
from db.repository import Repository
from nlp.tokenizer import tokenize


@pytest.fixture
def c():
    repo=Repository(':memory:')
    yield Conversation(repo,self_name='Bella')
    repo.close()


@pytest.mark.parametrize('type_fact',['Owner is human.','Owner is a human.'])
@pytest.mark.parametrize('question',['Did a human create you?','Did a human create Bella?'])
def test_creator_question_combines_membership_and_relationship(c,type_fact,question):
    c.handle(type_fact,speaker='Owner')
    c.handle('Owner created Bella.',speaker='Owner')
    reply=c.handle(question,speaker='Owner')
    assert reply.trace['status']=='yes'
    assert reply.text.startswith('Yes.')
    proof=reply.trace['sentences'][0]['answers'][0]['plan']['support'][0]
    assert len(proof)>=2
    assert 'human' in reply.text and 'created' in reply.text
    assert 'research' not in reply.trace


def test_taxonomy_and_relation_are_composed(c):
    c.handle('Owner is human.',speaker='Owner')
    c.handle('Humans are primates.',speaker='Owner')
    c.handle('Owner created Bella.',speaker='Owner')
    reply=c.handle('Did a primate create you?',speaker='Owner')
    assert reply.trace['status']=='yes'
    assert len(reply.trace['sentences'][0]['answers'][0]['plan']['support'][0])>=3


def test_one_negative_witness_does_not_imply_no_human_created_her(c):
    c.handle('Owner is a human.')
    c.handle('Owner did not create Bella.')
    assert c.handle('Did a human create you?').trace['status']=='unknown'
    c.handle('friend_3 is a human.')
    c.handle('friend_3 created Bella.')
    assert c.handle('Did a human create you?').trace['status']=='yes'


@pytest.mark.parametrize('question',['What does it mean to be created?','What do it mean to create?'])
def test_definitions_do_not_enter_pronoun_or_private_fact_routing(c,question):
    reply=c.handle(question)
    assert reply.trace['intent']=='meaning'
    assert 'create means' in reply.text
    assert 'research' not in reply.trace
    assert 'refers to' not in reply.text


def test_what_am_i_answers_category_not_action(c):
    c.handle('Owner is human.',speaker='Owner')
    c.handle('Owner created Bella.',speaker='Owner')
    reply=c.handle('What am I?',speaker='Owner')
    assert 'human' in reply.text and 'created' not in reply.text


def test_pronouns_are_taken_from_previous_response(c):
    c.handle('Owner is human.',speaker='Owner')
    c.handle('Owner created Bella.',speaker='Owner')
    before=c.handle('Did a human create you?',speaker='Owner')
    reply=c.handle('What were the pronouns?',speaker='Owner')
    assert reply.trace['intent']=='pronoun-context'
    assert 'you' in reply.text and 'me' in reply.text
    assert 'clarify' not in reply.text


def test_dates_stay_single_values_in_tokens_and_memory(c):
    assert [t.text for t in tokenize('10/1/2026')]==['10/1/2026']
    c.handle('Your birthdate is 10/1/2026.')
    assert '2026-10-01' in c.handle('What is your creation date?').text
    assert not any(c.repo.find_concept(n) for n in ('10','1','2026'))


def test_bot_name_is_preserved_as_subject_and_object(c):
    c.handle('Bella is happy.',speaker='Owner')
    assert c.handle('Is Bella happy?',speaker='Owner').trace['status']=='yes'
    c.handle('Owner created Bella.',speaker='Owner')
    assert c.repo.assertions('rel:create',obj=('e',c.self_id))


def test_creation_date_argument_stays_whole(c):
    c.handle('Owner created you on 10/1/2026.',speaker='Owner')
    values=[row[0] for row in c.repo.conn.execute("SELECT literal FROM assertion_args WHERE role='time'")]
    assert values==['on 10/1/2026']
    assert not any(c.repo.find_concept(n) for n in ('10','1','2026'))


def test_existential_question_keeps_the_relationship_target(c):
    c.handle('Owner is human.')
    c.handle('Owner created Bella.')
    c.handle('Luna is a bot.')
    assert c.handle('Did a human create Luna?').trace['status']=='unknown'


def test_conflicting_membership_does_not_prove_existential(c):
    c.handle('Owner is human.')
    c.handle('Owner is not human.')
    c.handle('Owner created Bella.')
    assert c.handle('Did a human create you?').trace['status']=='unknown'


def test_voice_wake_keeps_bella_as_the_object():
    from voice.wake import WakeWord
    result=WakeWord('Bella').check('Did a human create Bella?','Owner')
    assert result.addressed and 'create Bella' in result.text

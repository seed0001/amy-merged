"""Regressions from the 2026-11-04 Discord log (18:30-18:35)."""
import pytest
from app.conversation import Conversation
from db.repository import Repository


@pytest.fixture
def c():
    repo = Repository(':memory:')
    yield Conversation(repo, self_name='Adam', curious=True, persona='amy')
    repo.close()


def say(c, text):
    return c.handle(text, speaker='Owner').text


def test_inner_questions_are_not_logged_as_said_or_answered_twice(c):
    say(c, 'Would you explain the link?')
    c.think_through('What is a talk?')
    turns = [(t['role'], t['text']) for t in c.repo.turns()]
    assert not any('What is a talk' in text for _, text in turns)
    engine = [text for role, text in turns if role == 'engine']
    assert len(engine) == len(set(engine))


def test_what_link_are_you_talking_about_explains_my_last_reply(c):
    say(c, 'Sure. What does glorpy mean')
    reply = say(c, 'What link are you talking about')
    assert 'Talking:' not in reply


def test_are_you_sure_is_about_my_last_answer(c):
    say(c, 'What does sure mean')
    assert 'dictionary' in say(c, 'Are you sure about that')


def test_do_you_understand_reports_whether_i_followed(c):
    say(c, 'Whereupon the quixotic notwithstanding.')
    assert 'Not all of it' in say(c, 'Do you understand any of that')


def test_do_you_know_what_you_are_reasons_not_waits(c):
    for text in ('What are you?', 'Do you know what you are?'):
        reply = say(c, text)
        assert 'Nobody' not in reply and 'No findings' not in reply
        assert 'observe' in reply and 'still working out' in reply


def test_filler_and_personal_updates(c):
    reply = say(c, "Well, I'm outside walking around")
    assert reply.startswith("You're outside walking around") and '?' in reply
    assert 'well' not in reply.lower().split()
    assert c.repo.all_assertions() == []  # a moment, not a lasting fact
    assert 'Denver' in say(c, 'Well, Jen lives in Denver.')


def test_invitation_to_ask_gets_a_question(c):
    reply = say(c, 'Sure. What would you like to know')
    assert reply.endswith('?') and 'Sure' not in reply and "I don't know what I would like" not in reply


def test_dictionary_connects_everyday_words(c):
    assert 'clear unclouded sky' in say(c, 'Is the sky blue?')
    say(c, 'Bob is a man.')
    reply = say(c, 'Is Bob tall?')
    assert 'Do you know?' in reply and 'directly about' not in reply

import pytest
from app.conversation import Conversation
from db.repository import Repository


@pytest.fixture
def convo():
    repo = Repository(":memory:")
    yield Conversation(repo)
    repo.close()


def test_a_rule_about_a_named_person_with_a_plain_word_in_it_does_not_break_her_reasoning(convo):
    # From a real call in the corpus: this line was learned as a rule whose subject is a named person and whose
    # arguments hold a plain word ("later"). The rule search took the word for an unbound variable and looked the
    # named subject up as if it were one, and every turn after it crashed with "unhashable type: 'list'".
    convo.handle("I'm gonna ask if I can take my hour to go like one hour later.", speaker="friend_3")
    assert convo.handle("Who's in charge today?", speaker="friend_3").text
    assert convo.handle("Dogs are animals.", speaker="friend_3").text


def test_two_variable_relational_rule(convo):
    # Cross-variable rule: "If someone owns a dog, they walk it."
    ack = convo.handle("If someone owns a dog, they walk it.")
    assert "if someone owns a dog, they walk it" in ack.text

    convo.handle("Howard owns Buster.")
    convo.handle("Buster is a dog.")

    # 1. Yes/no query
    reply = convo.handle("Does Howard walk Buster?")
    assert reply.trace["status"] == "yes"
    assert "Howard walks Buster" in reply.text
    assert "Howard owns Buster" in reply.text
    assert "Buster is a dog" in reply.text

    # 2. Object wh-query
    wh_obj = convo.handle("What does Howard walk?")
    assert wh_obj.trace["status"] == "yes"
    assert "Howard walks Buster" in wh_obj.text

    # 3. Subject wh-query
    wh_subj = convo.handle("Who walks Buster?")
    assert wh_subj.trace["status"] == "yes"
    assert "Howard walks Buster" in wh_subj.text


def test_three_variable_transitive_rule(convo):
    # Transitive rule: "If X lives in Y and Y is in Z, then X is in Z."
    convo.handle("If X lives in Y and Y is in Z, then X is in Z.")
    convo.handle("Howard lives in Dayton.")
    convo.handle("Dayton is in Ohio.")

    reply = convo.handle("Is Howard in Ohio?")
    assert reply.trace["status"] == "yes"
    assert "Howard is in Ohio" in reply.text
    assert "Howard lives in Dayton" in reply.text
    assert "Dayton is in Ohio" in reply.text


def test_counterfactual_stub(convo):
    convo.handle("If someone owns a dog, they walk it.")
    convo.handle("Howard owns Buster.")
    convo.handle("Buster is a dog.")

    # Query: Does Howard walk Buster?
    from nlp.parser import parse_sentence
    f = convo._build_query(parse_sentence("Does Howard walk Buster?")[0])[0]
    ans = convo.engine.ask(f)
    assert ans.status == "yes"

    # Counterfactual: what if Howard had not owned Buster?
    step_own = [s for s in ans.support[0].steps if convo.repo.assertion(s)["predicate"] == "rel:own"]
    cf = convo.engine.counterfactual(f, step_own)
    assert cf["dependent"] is True
    assert cf["hypothetical_status"] == "unknown"

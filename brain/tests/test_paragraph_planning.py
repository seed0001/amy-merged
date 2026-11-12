import pytest
from app.conversation import Conversation
from db.repository import Repository
from dialogue.paragraphs import realize

@pytest.fixture
def c():
    repo = Repository(":memory:")
    yield Conversation(repo, speaker="Owner")
    repo.close()


def test_question_uses_later_evidence_and_excludes_unrelated_facts(c):
    r = c.handle("Where does Bob live? Bob owns a boat. Bob lives in Dayton.")
    assert r.trace["status"] == "yes"
    assert "Dayton" in r.text and "boat" not in r.text
    assert r.trace["paragraph_plan"]["purpose"] == "answer"
    assert len(r.trace["paragraph_plan"]["coverage"]) == 3


def test_cross_sentence_person_and_object_references(c):
    r = c.handle("Alice lives in Paris. She works in London. Where does she work?")
    assert r.trace["status"] == "yes" and "Alice" in r.text and "London" in r.text
    c.handle("Howard owns a truck. It is red.")
    assert c.handle("Does Howard own a red truck?").trace["status"] == "yes"


def test_quoted_you_is_not_engine_and_outer_statement_is_processed(c):
    r = c.handle('Bob said, "You are alive." Alice lives in Paris.')
    assert len(r.trace["paragraph_plan"]["coverage"]) == 2
    assert not c.repo.assertions("has_property", subj=("e",c.self_id))
    assert c.handle("Where does Alice live?").trace["status"] == "yes"


def test_ambiguous_reference_gets_one_specific_clarification(c):
    r = c.handle("Alice helped Bob. She lives in Paris. Bob owns a boat.")
    assert r.text.count("?") == 1
    assert "she" in r.text.lower()
    assert c.handle("Does Bob own a boat?").trace["status"] == "yes"
    assert not c.repo.assertions("rel:live")


def test_correction_before_answer_and_rule_conditions(c):
    r = c.handle("Where does Bob live? Bob lives in Paris. Correction: Bob lives in Rome.")
    assert "Rome" in r.text and "Paris" not in r.text
    r = c.handle("If someone is happy, they are cheerful. Bella is happy. Is Bella cheerful?")
    assert r.trace["status"] == "yes"
    assert r.trace["proofs"]["support"][0]["learned_rules"]


def test_long_input_keeps_tail_and_unparsed_clause(c):
    text = " ".join(f"Person{chr(65+i)} owns a boat." for i in range(20))
    r = c.handle(text + " And and and. Where does Bob live? Bob lives in Rome.")
    assert len(r.trace["paragraph_plan"]["coverage"]) == 23
    assert "Rome" in r.text
    assert "And and and" in r.text and r.text.count("?") == 1


def test_history_summary_keeps_speakers_corrections_and_qualifications(c):
    c.handle("Bob lives in Paris.",speaker="Alice")
    c.handle("I think Bob lives in Rome.",speaker="Dana")
    c.handle("Correction: Bob lives in London.",speaker="Alice")
    before = [tuple(r) for r in c.repo.all_assertions()]
    r = c.handle("What have we been discussing?",speaker="Owner")
    assert r.trace["intent"] == "conversation-summary"
    assert all(word in r.text for word in ("Alice", "Dana", "Correction", "I think", "London"))
    assert [tuple(row) for row in c.repo.all_assertions()] == before
    second = c.handle("What have we been discussing?")
    assert second.trace["paragraph_plan"]["groups"] == []
    c.handle("Bella owns a cat.")
    update = c.handle("Summarize our conversation.")
    assert "Bella" in update.text and "Paris" not in update.text


def test_templates_reject_unsourced_claims(c):
    with pytest.raises(ValueError):
        realize(c,{"claims":[{"text":"Invented connection."}],"groups":[[0]],"gaps":[]})


def test_shared_person_does_not_pad_simple_answer(c):
    c.elaborate = True
    c.handle("Bob owns a boat.")
    c.handle("Bob lives in Paris.")
    r = c.handle("Where does Bob live?")
    assert "Paris" in r.text and "boat" not in r.text
    assert "dictionary" not in r.text.lower()


def test_repeated_paragraph_reports_changes_only(c):
    prompt = "Alice owns a boat. Alice lives in Paris. Where does Alice live?"
    first = c.handle(prompt)
    assert "Paris" in first.text
    again = c.handle(prompt)
    assert not any(again.trace["paragraph_plan"]["groups"])
    assert "Paris" not in again.text


def test_summary_includes_supported_answers_not_only_prompts(c):
    c.handle("If someone is happy, they are cheerful.")
    c.handle("Bella is happy.")
    c.handle("Is Bella cheerful?")
    r = c.handle("What have we been discussing?")
    assert any(claim["source"].get("role") == "engine" for claim in r.trace["paragraph_plan"]["claims"])
    assert "Bella is cheerful" in r.text


def test_withdrawn_evidence_cannot_be_realized(c):
    uid = c.repo.log_utterance("Owner","Bob is happy.")
    aid = c.repo.add_assertion(("e",c.repo.entity("Bob")),"has_property",("c",c.repo.concept("happy")),True,uid)
    c.repo.retract(aid,uid,"withdrawn")
    with pytest.raises(ValueError):
        realize(c,{"claims":[{"text":"Bob is happy.","source":{"assertion":aid}}],"groups":[[0]],"gaps":[]})

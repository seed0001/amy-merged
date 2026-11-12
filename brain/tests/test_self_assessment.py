import pytest
from app.conversation import Conversation
from db.repository import Repository
from dialogue.drive import BY_KEY, Capacity


@pytest.fixture
def c():
    repo = Repository(":memory:")
    yield Conversation(repo, speaker="Owner")
    repo.close()


def state(c):
    return c._self_investigations.sessions.latest("Owner")


def test_evidence_and_rules_change_conclusion_and_resume(c):
    c.handle("Are you alive?")
    ident = state(c)["id"]
    assert state(c)["conclusions"][0]["status"] == "unknown"
    c.handle("If someone is curious, they are alive.")
    c.handle("You are curious.")
    reply = c.handle("Are you alive?")
    assert state(c)["id"] == ident
    assert state(c)["conclusions"][0]["status"] == "yes"
    assert state(c)["conclusions"][0]["proofs"][0]["learned_rules"]
    assert "Owner" in reply.text
    assert "unresolved" not in reply.text


def test_questions_keep_distinct_queries(c):
    queries = []
    for question in ("Are you real?", "Are you alive?", "Are you conscious?", "Do you have feelings?"):
        c.handle(question)
        queries.append(state(c)["query"])
    assert len({str(q) for q in queries}) == 4
    assert queries[-1]["relation"] == "rel"


def test_related_capacities_and_dictionary_do_not_prove_target(c):
    c.handle("You are thoughtful.")
    c.handle("You remember things.")
    c.handle("You learn things.")
    c.handle("Are you conscious?")
    assert state(c)["conclusions"][0]["status"] == "unknown"
    assert state(c)["gaps"]
    assert not state(c)["conclusions"][0]["proofs"]


def test_presets_do_not_determine_capability(c):
    for preset in ("yes", "no", None):
        assert c.drive.has(Capacity("breathe", "breathe", evidence=preset)) is None
    uid = c.repo.log_utterance("Owner", "You breathe.")
    aid = c.repo.add_assertion(("e", c.self_id), "rel:breathe", ("c", c.repo.none_concept()), True, uid)
    for preset in ("yes", "no", None):
        assert c.drive.has(Capacity("breathe", "breathe", evidence=preset)) is True
    c.repo.retract(aid, uid, "test correction")
    c.repo.add_assertion(("e", c.self_id), "rel:breathe", ("c", c.repo.none_concept()), False, uid)
    assert c.drive.has(BY_KEY["breathe"]) is False


def test_conflicting_sources_stay_conflicting(c):
    c.handle("You are alive.", speaker="Owner")
    uid = c.repo.conn.execute("SELECT MAX(id) FROM utterances").fetchone()[0]
    c.repo.add_assertion(("e", c.self_id), "has_property", ("c", c.repo.concept("alive")), False, uid)
    c.handle("Are you alive?", speaker="Owner")
    assert state(c)["conclusions"][0]["status"] == "conflicting"
    assert state(c)["conclusions"][0]["proofs"]
    assert state(c)["conclusions"][0]["against"]


def test_supported_answer_has_no_appended_doubt_and_updates_are_changes_only(c):
    c.handle("You are conscious.")
    first = c.handle("Are you conscious?").text
    assert "reported" in first
    assert not any(s in first for s in ("can't settle", "can't tell", "unresolved", "don't claim", "What do you think"))
    second = c.handle("Are you conscious?").text
    assert "reported" not in second
    assert "No findings have changed" in second
    assert "feeling it" not in c.handle("How do you feel?").text


def test_feelings_and_kind_follow_recorded_semantics(c):
    c.handle("You have feelings.")
    c.handle("Do you have feelings?")
    assert state(c)["conclusions"][0]["status"] == "yes"
    c.handle("You are a bot.")
    c.handle("Are you a bot?")
    assert state(c)["conclusions"][0]["status"] == "yes"


def test_all_capability_presets_can_be_overridden_by_evidence(c):
    for key in ("body", "think", "feel"):
        cap = BY_KEY[key]
        concept = c.repo.concept(key)
        uid = c.repo.log_utterance("Owner", "capacity evidence")
        # Use the stored relation for object-bearing capacities.
        predicate = "rel:own" if key == "body" else "has_property"
        obj = ("c", concept)
        aid = c.repo.add_assertion(("e", c.self_id), predicate, obj, True, uid)
        assert c.drive.has(cap) is True
        c.repo.retract(aid, uid, "test correction")
        c.repo.add_assertion(("e", c.self_id), predicate, obj, False, uid)
        assert c.drive.has(cap) is False

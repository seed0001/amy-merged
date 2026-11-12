import pytest
from app.conversation import Conversation
from db.repository import Repository
from reasoning.induction import InductionEngine


@pytest.fixture
def convo():
    repo = Repository(":memory:")
    yield Conversation(repo)
    repo.close()


def test_inductive_class_property_mining(convo):
    # Teach that multiple birds fly
    convo.handle("Robin is a bird.")
    convo.handle("Robin is fast.")
    convo.handle("Sparrow is a bird.")
    convo.handle("Sparrow is fast.")

    # Induction engine should automatically mine: "If a bird is a bird, it is fast"
    # Check that a rule was induced
    rules = (convo.repo.active_rules() + convo.repo.provisional_rules())
    induced_rules = [r for r in rules if "induction" in r.get("variable", {}).get("origin", "")]
    assert len(induced_rules) >= 1

    # Now ask about a new bird:
    convo.handle("Canary is a bird.")
    reply = convo.handle("Is Canary fast?")
    assert reply.trace["status"] == "yes"


def test_delta_rule_confidence_update(convo):
    convo.handle("Robin is a bird.")
    convo.handle("Robin is fast.")
    convo.handle("Sparrow is a bird.")
    convo.handle("Sparrow is fast.")

    induced = [r for r in (convo.repo.active_rules() + convo.repo.provisional_rules()) if "induction" in r.get("variable", {}).get("origin", "")]
    assert induced
    rule = induced[0]
    initial_conf = rule["confidence"]

    # Confirming evidence updates delta upwards
    c_new = convo.induction.update_delta(rule["id"], confirmed=True)
    assert c_new > initial_conf

    # Disconfirming evidence updates delta downwards
    c_after_disconfirm = convo.induction.update_delta(rule["id"], confirmed=False)
    assert c_after_disconfirm < c_new

    # Repeated disconfirmations demote the rule
    convo.induction.update_delta(rule["id"], confirmed=False)
    convo.induction.update_delta(rule["id"], confirmed=False)
    convo.induction.update_delta(rule["id"], confirmed=False)
    convo.induction.update_delta(rule["id"], confirmed=False)

    rule_after = convo.repo.rule(rule["id"])
    assert rule_after["status"] == "demoted"

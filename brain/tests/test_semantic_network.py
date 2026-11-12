"""The editable semantic overlay: WordNet evidence, inference, revision, gaps, pressure."""

import json

import pytest

from app.conversation import Conversation
from db.repository import Repository
from nlp.wordnet import Selection, Sense
from reasoning.semantic import SemanticNetwork
from reasoning.thoughts import ThinkingEngine, ThoughtStore


class FakeWordNet:
    """A tiny read-only taxonomy with the same surface as nlp.wordnet.WordNet."""

    available = True

    def __init__(self):
        self.senses = {
            "dog": Sense("dog.n.01", "dog", "n", "a domesticated animal"),
            "cat": Sense("cat.n.01", "cat", "n", "a small domesticated feline"),
            "animal": Sense("animal.n.01", "animal", "n", "a living organism"),
            "food": Sense("food.n.01", "food", "n", "any substance eaten"),
        }
        self.parents = {"dog.n.01": "animal.n.01", "cat.n.01": "animal.n.01"}

    def sense(self, ident):
        return next((s for s in self.senses.values() if s.id == ident), None)

    def lookup(self, word, pos="n"):
        found = self.senses.get(word)
        return [found] if found else []

    def usual(self, word, pos_order=("n", "v", "a", "s", "r")):
        return self.senses.get(word)

    def select(self, word, context="", pos=None, chosen=None):
        found = self.senses.get(word)
        return Selection(found, [found] if found else [], 1.0 if found else 0.0)

    def ancestors(self, ident, depth=12, budget=200):
        paths = {ident: [ident]}
        if ident in self.parents and depth >= 1:
            parent = self.parents[ident]
            paths[parent] = [ident, parent]
        return paths

    def related(self, ident, relations, limit=12):
        return []

    def verify_path(self, path):
        return all(self.parents.get(a) == b for a, b in zip(path, path[1:]))

    def proper_form(self, word):
        return None


@pytest.fixture
def repo():
    database = Repository(":memory:")
    yield database
    database.close()


def concept(repo, name):
    return repo.concept(name)


def test_wordnet_ancestry_is_editable_evidence_not_a_dictionary_write(repo):
    wordnet = FakeWordNet()
    before = dict(wordnet.senses)
    network = SemanticNetwork(repo, wordnet)
    dog, animal = concept(repo, "dog"), concept(repo, "animal")

    network.ensure_concept("dog")

    rows = repo.assertions("subclass_of", subj=("c", dog), obj=("c", animal))
    assert len(rows) == 1
    provenance = repo.conn.execute(
        "SELECT origin,context FROM assertion_provenance WHERE assertion_id=?", (rows[0]["id"],)
    ).fetchone()
    assert provenance["origin"] == "wordnet"
    assert "dog.n.01" in provenance["context"]

    edge = next(e for e in network.edges(("c", dog), "subclass_of")
                if e["object_id"] == network.node(("c", animal))["id"])
    assert edge["origin"] == "wordnet"
    assert network.provenance(edge["id"])["evidence"][0]["origin"] == "wordnet"

    # Amy can retire her copy.  The dictionary itself is unchanged.
    assert network.remove(edge["id"])
    assert repo.assertion(rows[0]["id"])["status"] == "retracted"
    assert network.edge(edge["id"])["status"] == "removed"
    assert wordnet.senses == before and wordnet.parents == {"dog.n.01": "animal.n.01", "cat.n.01": "animal.n.01"}


def test_multi_hop_inheritance_keeps_its_path_and_confidence(repo):
    network = SemanticNetwork(repo, None)
    dog, animal, food = concept(repo, "dog"), concept(repo, "animal"), concept(repo, "food")
    network.link(("c", dog), "subclass_of", ("c", animal), origin="conversation", materialize=True)
    network.link(("c", animal), "rel:need", ("c", food), origin="conversation", materialize=True)

    network.infer()

    result = network.assess(("c", dog), "rel:need", ("c", food))
    assert result.status == "inferred" and bool(result)
    assert 0.0 < result.confidence <= 1.0
    assert len(result.path or []) == 2
    assert "dog" in result.explanation and "food" in result.explanation
    assert "needs food" in result.explanation

    row = repo.conn.execute(
        "SELECT * FROM semantic_inferences WHERE subject_id=? AND relation='rel:need'",
        (network.node(("c", dog))["id"],)).fetchone()
    assert row["status"] == "supported"
    path = json.loads(row["path_json"])
    assert [step["subject"] for step in path] == ["dog", "animal"]
    evidence = json.loads(row["evidence_json"])
    assert evidence["origins"]["conversation"] >= 2
    assert evidence["premises"]


def test_an_instance_inherits_through_its_kind(repo):
    network = SemanticNetwork(repo, None)
    dog, animal, food = concept(repo, "dog"), concept(repo, "animal"), concept(repo, "food")
    rex = repo.entity("Rex")
    network.link(("c", dog), "subclass_of", ("c", animal), origin="conversation", materialize=True)
    network.link(("c", animal), "rel:need", ("c", food), origin="conversation", materialize=True)
    network.link(("e", rex), "instance_of", ("c", dog), origin="conversation", materialize=True)

    network.infer()

    result = network.assess(("e", rex), "rel:need", ("c", food))
    assert result.status == "inferred"
    assert len(result.path or []) == 3
    assert "Rex" in result.explanation and "food" in result.explanation


def test_a_contradiction_creates_pressure_and_resolves_when_retired(repo):
    network = SemanticNetwork(repo, None)
    dog, animal = concept(repo, "dog"), concept(repo, "animal")
    positive = network.link(("c", dog), "subclass_of", ("c", animal),
                            origin="conversation", materialize=True)
    negative = network.link(("c", dog), "subclass_of", ("c", animal),
                            origin="correction", polarity=False, materialize=True)

    assert network.assess(("c", dog), "subclass_of", ("c", animal)).status == "contradicted"
    gaps = network.gaps()
    contradiction = next(g for g in gaps if g["kind"] == "contradiction")
    assert contradiction["question"] == "Is dog a kind of animal?"
    assert contradiction["pressure"] >= 0.9
    assert network.pressure()["contradictions"] == 1

    network.remove(negative)

    assert network.assess(("c", dog), "subclass_of", ("c", animal)).status == "known"
    assert network.pressure()["contradictions"] == 0
    assert all(g["kind"] != "contradiction" for g in network.gaps())


def test_a_specific_exception_does_not_erase_the_general_rule(repo):
    network = SemanticNetwork(repo, None)
    animal, food = concept(repo, "animal"), concept(repo, "food")
    dog = concept(repo, "dog")
    rex = repo.entity("Rex")
    network.link(("c", animal), "rel:need", ("c", food), origin="conversation", materialize=True)
    network.link(("c", dog), "subclass_of", ("c", animal), origin="conversation", materialize=True)
    network.link(("e", rex), "instance_of", ("c", dog), origin="conversation", materialize=True)
    network.infer()

    assert network.assess(("e", rex), "rel:need", ("c", food)).status == "inferred"
    network.link(("e", rex), "rel:need", ("c", food),
                 origin="conversation", polarity=False, materialize=True)

    # The exception belongs to Rex; the kind's general fact remains, and the inferred
    # instance claim is explicitly marked as disputed rather than silently universal.
    assert network.assess(("e", rex), "rel:need", ("c", food)).status == "known"
    assert "not true" in network.assess(("e", rex), "rel:need", ("c", food)).explanation
    assert network.assess(("c", dog), "rel:need", ("c", food)).status == "inferred"
    network.infer()
    rex_inference = repo.conn.execute(
        "SELECT status FROM semantic_inferences WHERE subject_id=? AND relation='rel:need'",
        (network.node(("e", rex))["id"],)).fetchone()
    assert rex_inference["status"] == "conflicting"


def test_context_changes_confidence_without_rewriting_the_belief(repo):
    network = SemanticNetwork(repo, None)
    dog, food = concept(repo, "dog"), concept(repo, "food")
    edge = network.link(("c", dog), "rel:need", ("c", food), origin="conversation",
                        materialize=True,
                        context={"speaker": "Owner", "heard": "a dog needs food"})
    network.link(("c", dog), "rel:need", ("c", food), origin="conversation",
                 evidence=[{"origin": "conversation", "confidence": 0.9,
                            "context": {"speaker": "Alice", "heard": "a dog needs food"}}])
    stored = network.edge(edge)["confidence"]

    owner = network.assess(("c", dog), "rel:need", ("c", food), context={"speaker": "Owner"})
    alice = network.assess(("c", dog), "rel:need", ("c", food), context={"speaker": "Alice"})
    stranger = network.assess(("c", dog), "rel:need", ("c", food), context={"speaker": "Bob"})

    assert owner.confidence > stranger.confidence
    assert alice.confidence > stranger.confidence
    assert network.edge(edge)["confidence"] == stored  # context is a query, not a rewrite


def test_gaps_become_grammatical_questions_from_the_missing_relation(repo):
    network = SemanticNetwork(repo, None)
    animal = concept(repo, "animal")
    dog, cat, bird = concept(repo, "dog"), concept(repo, "cat"), concept(repo, "bird")
    fuzzy = concept(repo, "fuzzy")
    for child in (dog, cat, bird):
        network.link(("c", child), "subclass_of", ("c", animal),
                     origin="conversation", materialize=True)
    network.link(("c", dog), "has_property", ("c", fuzzy), origin="conversation", materialize=True)
    network.link(("c", cat), "has_property", ("c", fuzzy), origin="conversation", materialize=True)

    gaps = network.gaps()
    missing = next(g for g in gaps if g["kind"] == "missing-relation"
                   and g["subject_id"] == network.node(("c", bird))["id"])
    assert missing["question"] == "Is bird fuzzy?"
    assert missing["pressure"] > 0.5

    unknown = network.node(("c", concept(repo, "wug")))
    network.gaps()
    unfamiliar = next(g for g in network.gaps(limit=32)
                      if g["kind"] == "unfamiliar-concept" and g["subject_id"] == unknown["id"])
    assert unfamiliar["question"] == "What is wug?"

    chosen = network.next_question()
    assert chosen["question"] == "Is bird fuzzy?"  # higher pressure than an unfamiliar word
    assert network.next_question(exclude={chosen["question"]})["question"] == "What is wug?"


def test_strengthen_weaken_and_assess_distinguish_known_partial_and_unknown(repo):
    network = SemanticNetwork(repo, None)
    dog, food, animal = concept(repo, "dog"), concept(repo, "food"), concept(repo, "animal")
    unknown = network.assess(("c", dog), "rel:need", ("c", food))
    assert unknown.status == "unknown"

    edge = network.link(("c", dog), "rel:need", ("c", food), origin="conversation",
                        materialize=True)
    first = network.edge(edge)["confidence"]
    stronger = network.strengthen(edge, confidence=1.0)
    assert stronger > first
    weaker = network.weaken(edge, confidence=2.0)
    assert weaker < stronger

    network.link(("c", dog), "subclass_of", ("c", animal), origin="conversation",
                 materialize=True)
    partial = network.assess(("c", dog), "rel:need", ("c", animal))
    assert partial.status == "partial"

    network.weaken(edge, confidence=5.0)
    assert network.edge(edge)["status"] == "weakened"
    assert network.assess(("c", dog), "rel:need", ("c", food)).status != "known"


def test_retracting_the_source_assertion_withdraws_the_edge_and_its_inference(repo):
    network = SemanticNetwork(repo, None)
    dog, animal, food = concept(repo, "dog"), concept(repo, "animal"), concept(repo, "food")
    link_edge = network.link(("c", dog), "subclass_of", ("c", animal),
                             origin="conversation", materialize=True)
    need_edge = network.link(("c", animal), "rel:need", ("c", food),
                             origin="conversation", materialize=True)
    source = network.edge(link_edge)["assertion_id"]
    network.infer()
    assert network.assess(("c", dog), "rel:need", ("c", food)).status == "inferred"

    repo.retract(source, None, "test retraction")
    network.sync()

    assert network.edge(link_edge)["status"] == "removed"
    assert network.edge(need_edge)["status"] == "active"
    row = repo.conn.execute(
        "SELECT status FROM semantic_inferences WHERE subject_id=? AND relation='rel:need'",
        (network.node(("c", dog))["id"],)).fetchone()
    assert row["status"] == "withdrawn"
    assert network.assess(("c", dog), "rel:need", ("c", food)).status != "inferred"


def test_conversation_uses_wordnet_inheritance_and_explains_the_evidence():
    database = Repository(":memory:")
    try:
        convo = Conversation(database)
        if not convo.exposition.wordnet.available:
            pytest.skip("WordNet data is not installed")
        convo.handle("Animals need food.", speaker="Owner")
        convo.handle("Rex is a dog.", speaker="Owner")

        reply = convo.handle("Does Rex need food?", speaker="Owner")

        assert reply.text.startswith(("Yes.", "Probably."))
        assert "Rex" in reply.text and "food" in reply.text
        assessment = convo.semantics.assess(
            ("e", database.find_entity("Rex")), "rel:need",
            ("c", database.find_concept("food")))
        assert assessment.status == "inferred"
        assert assessment.origin == "own-reasoning"
    finally:
        database.close()


def test_background_thinking_publishes_an_inherited_semantic_chain(tmp_path):
    database = Repository(":memory:")
    store = ThoughtStore(tmp_path / "queue.db")
    try:
        convo = Conversation(database)
        if not convo.exposition.wordnet.available:
            pytest.skip("WordNet data is not installed")
        convo.handle("Animals need food.", speaker="Owner")
        convo.handle("Rex is a dog.", speaker="Owner")

        thinker = ThinkingEngine(database, store, wordnet=convo.exposition.wordnet)
        thinker.cycle()

        ready = store.ready()
        semantic = [chain for chain in ready if chain.kind == "semantic-inference"]
        assert semantic
        assert any("needs food" in chain.conclusion and chain.premises for chain in semantic)
        assert any("Rex" in chain.conclusion for chain in semantic)
    finally:
        store.close()
        database.close()

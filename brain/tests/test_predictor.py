"""Predictive sentence builder: rules, sentence assembly, and perceptron learning."""

import pytest

from dialogue.predictor import Context, Predictor


@pytest.fixture
def predictor():
    # No weights file, fixed seed: nothing is written to disk and results are repeatable.
    return Predictor(weights_path=None, seed=1)


def test_builds_a_full_sentence_from_whole_phrases(predictor):
    s = predictor.predict(Context(topic="feelings", meaning="sympathy"))
    assert s.text[0].isupper()
    assert s.text.endswith((".", "?", "!"))
    assert len(s.choices) >= 2  # at least subject and predicate


def test_topic_rule_keeps_phrases_on_topic(predictor):
    for _ in range(20):
        predictor.history.clear()
        s = predictor.predict(Context(topic="curiosity", meaning="ask"))
        assert all(c.phrase.topic == "curiosity" for c in s.choices)


def test_no_phrase_repeats_inside_one_sentence(predictor):
    s = predictor.predict(Context(topic="small_talk", meaning="greet"))
    texts = [c.phrase.text for c in s.choices]
    assert len(texts) == len(set(texts))


def test_recent_phrases_are_avoided_until_the_limit(predictor):
    predictor.repeat_limit = 1
    ctx = Context(topic="feelings", meaning="sympathy", slots=("predicate",))  # two predicates
    first = predictor.predict(ctx)
    predictor.remember(first)
    second = predictor.predict(ctx)
    assert second.choices[0].phrase.text != first.choices[0].phrase.text


def test_missing_required_slot_raises(predictor):
    with pytest.raises(LookupError):
        predictor.predict(Context(topic="no_such_topic", meaning="ask"))


def test_meaning_outside_compatibility_is_not_used(predictor):
    s = predictor.predict(Context(topic="small_talk", meaning="agree"))
    allowed = {"agree", *predictor.banks.compatible.get("agree", [])}
    assert all(c.phrase.meaning in allowed for c in s.choices)


def test_reinforce_negative_lowers_the_rejected_sentence(predictor):
    ctx = Context(topic="feelings", meaning="happy", slots=("predicate",))
    s = predictor.predict(ctx)
    before = predictor.model.score(s.choices[0].features)
    predictor.reinforce(s, reward=-1.0)
    after = predictor.model.score(s.choices[0].features)
    assert after < before


def test_training_teaches_a_gold_phrase(predictor):
    ctx = Context(topic="feelings", meaning="sympathy", slots=("predicate",))
    gold = ["I'm here if you want to talk it through."]
    for _ in range(10):
        predictor.train(ctx, gold)
        predictor.history.clear()
    assert predictor.predict(ctx).choices[0].phrase.text == gold[0]


def test_paragraph_joins_sentences(predictor):
    text = predictor.predict_paragraph([
        Context(topic="feelings", meaning="sympathy"),
        Context(topic="curiosity", meaning="ask"),
    ])
    assert text.count(". ") + text.count("? ") >= 1
    assert text[0].isupper()


def test_graph_edges_connect_compatible_phrases(predictor):
    g = predictor.graph
    assert any(e.kind == "relates" for edges in g.out.values() for e in edges)
    assert any(e.kind == "follows" for edges in g.out.values() for e in edges)


def test_activation_spreads_to_related_phrases(predictor):
    seed = next(iter(predictor.banks.candidates("subject", Context("feelings", "sympathy"))))
    act = predictor.graph.activate({seed.text: 1.0})
    assert act.get(seed.text) >= 1.0  # seed keeps its energy and may gain more from neighbours
    assert len(act) > 1  # energy reached at least one neighbour


def test_reinforced_path_gains_edge_weight_and_decay_pulls_back(predictor):
    g = predictor.graph
    edge = next(e for edges in g.out.values() for e in edges if e.kind == "follows")
    before = edge.weight
    g.reinforce_path([edge.src, edge.dst], reward=1.0)
    assert edge.weight > before
    g.decay(rate=0.5)
    assert abs(edge.weight - edge.baseline) < abs(before + 0.2 - edge.baseline)

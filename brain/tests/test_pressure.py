"""Pressure buckets: fill/decay, signals, thresholds, hysteresis, seeds, quiet clamp, persistence."""

from datetime import datetime

import pytest

from app.conversation import Conversation
from db.repository import Repository
from dialogue.pressure import Pressure
from dialogue.self_model import SelfModel

NOON = datetime(2026, 10, 30, 12, 0).timestamp()


class Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def pressure():
    repo = Repository(":memory:")
    clock = Clock(NOON)
    model = Pressure(repo, clock=clock)
    model.clock_ref = clock
    yield model
    repo.close()


def test_starts_quiet_and_round_trips_through_the_database(pressure):
    assert pressure.state["buckets"]["irritation"] == 0
    assert pressure.state["buckets"]["boredom"] == pytest.approx(0.2)
    pressure.state["buckets"]["boredom"] = 0.5
    pressure.after_turn()  # saves on a message tick
    again = Pressure(pressure.repo, clock=pressure.clock)
    assert again.state["buckets"]["boredom"] == pytest.approx(0.5)


def test_boredom_builds_in_silence_and_novelty_eases_it(pressure):
    before = pressure.state["buckets"]["boredom"]
    pressure.clock_ref.t += 60 * 60
    pressure.tick()
    assert pressure.state["buckets"]["boredom"] > before
    built = pressure.state["buckets"]["boredom"]
    pressure.hear("The quick brown fox jumps over the lazy dog", person_key="discord:1",
                  speaker_name="Owner")
    assert pressure.state["buckets"]["boredom"] < built


def test_a_threshold_fires_once_and_hysteresis_holds_it(pressure):
    pressure.state["buckets"]["boredom"] = 0.8
    fired = pressure.tick()
    assert fired and fired["bucket"] == "boredom" and fired["doing"] == "log"
    drained = pressure.state["buckets"]["boredom"]
    assert drained == pytest.approx(0.25)
    assert pressure.state["armed"]["boredom"] is False

    # Not low enough to re-arm: crossing the threshold again does nothing.
    pressure.state["buckets"]["boredom"] = 0.5
    assert pressure.tick() is None
    pressure.state["buckets"]["boredom"] = 0.8
    assert pressure.tick() is None

    # Well below threshold - hysteresis re-arms it.
    pressure.state["buckets"]["boredom"] = 0.39
    assert pressure.tick() is None
    pressure.state["buckets"]["boredom"] = 0.8
    assert (pressure.tick() or {}).get("bucket") == "boredom"


def test_firing_a_want_seeds_the_next(pressure):
    pressure.state["buckets"]["boredom"] = 0.8
    curiosity, usefulness = (pressure.state["buckets"]["curiosity"],
                             pressure.state["buckets"]["usefulness"])
    pressure.tick()
    assert pressure.state["buckets"]["curiosity"] == pytest.approx(curiosity + 0.1)
    assert pressure.state["buckets"]["usefulness"] == pytest.approx(usefulness + 0.2)


def test_quiet_clamp_holds_irritation_and_loneliness_down(pressure):
    pressure.state["buckets"]["irritation"] = 0.9
    pressure.hear("back off", person_key="discord:1", speaker_name="Owner")
    assert pressure.state["clamp_until"] > pressure.clock_ref.t
    assert pressure.state["buckets"]["irritation"] <= pressure.config["quiet_clamp_max"]
    assert pressure.state["loneliness"]["discord:1"]["value"] <= pressure.config["quiet_clamp_max"]

    pressure.clock_ref.t += pressure.config["quiet_clamp_minutes"] * 60 + 1
    pressure.state["last_tick"] = pressure.clock_ref.t
    pressure.state["last_message"] = pressure.clock_ref.t
    pressure.state["buckets"]["irritation"] = 0.9
    pressure.tick()
    assert pressure.state["buckets"]["irritation"] > pressure.config["quiet_clamp_max"]


def test_contact_eases_loneliness_and_time_builds_it_again(pressure):
    pressure.hear("hello", person_key="discord:1", speaker_name="Owner")
    person = pressure.state["loneliness"]["discord:1"]
    assert person["value"] == 0 and person["last_seen"] == pressure.clock_ref.t
    pressure.clock_ref.t += 2 * 3600
    pressure.tick()
    assert person["value"] > 0


def test_open_questions_and_new_names_raise_curiosity(pressure):
    before = pressure.state["buckets"]["curiosity"]
    pressure.hear("I wonder what Zorblax is planning.", person_key="discord:1", speaker_name="Owner")
    assert pressure.state["buckets"]["curiosity"] > before
    assert pressure.state["open_questions"]
    assert [entry["name"] for entry in pressure.state["recent_names"]] == ["Zorblax"]


def test_irritants_and_real_requests_move_their_buckets(pressure):
    usefulness = pressure.state["buckets"]["usefulness"]
    pressure.hear("Can you explain that again? You're wrong.", person_key="discord:1",
                  speaker_name="Owner")
    assert pressure.state["buckets"]["irritation"] > 0
    assert pressure.state["buckets"]["usefulness"] < usefulness


def test_biases_are_modest_and_reach_the_self_model(pressure):
    pressure.state["buckets"].update({"curiosity": 1.0, "boredom": 0.6, "irritation": 1.0,
                                      "unease": 0.8, "usefulness": 0.9, "restlessness": 0.1})
    bias = pressure.biases()
    assert 0 < bias["curiosity"] < 0.5
    assert bias["stress"] > 0 and bias["sociability"] < 0
    assert pressure.follow_up_bonus() < 0.2

    model = SelfModel(pressure.repo, clock=pressure.clock)
    plain = model.current()
    model.pressure = pressure
    biased = model.current()
    assert biased["curiosity"] > plain["curiosity"]
    assert biased["stress"] > plain["stress"]
    assert "pressure" in model.snapshot()


def test_expression_flattens_under_pressure_without_overriding_sadness(pressure):
    model = SelfModel(pressure.repo, clock=pressure.clock)
    model.pressure = pressure
    pressure.state["buckets"]["irritation"] = 0.9
    assert model.expression()["tone"] == "measured"
    assert model.expression(sensitive=True)["tone"] == "gentle"


def test_voice_expression_reads_pressure_buckets():
    from voice.expression import VoiceExpressionEngine
    engine = VoiceExpressionEngine(effects=False)
    bored = engine.plan("I see.", state={"pressure": {"buckets": {"boredom": 1.0}}})
    assert bored.segments[0].emotion == "bored"
    annoyed = engine.plan("I see.", state={"pressure": {"buckets": {"irritation": 1.0}}})
    assert annoyed.segments[0].emotion == "indifferent"


def test_conversation_wires_pressure_into_a_turn(tmp_path):
    repo = Repository(str(tmp_path / "memory.db"))
    try:
        convo = Conversation(repo, speaker="Owner", self_name="Amy")
        convo.handle("Hello Amy!")
        key = convo.person_key
        assert key in convo.pressure.state["loneliness"]
        assert convo.pressure.state["last_message"] > 0
        assert "pressure" in convo.self_model.snapshot()
    finally:
        repo.close()

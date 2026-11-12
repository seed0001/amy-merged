"""Her inner life: drives settle over time, people are missed, wants fire past their threshold, and the
actor turns a want into a real Discord action. All rule-driven; no language model anywhere."""

import json
import os
import queue
import random
import tempfile

import pytest

from app.conversation import Conversation
from db.repository import Repository
from dialogue.life import Life
from dialogue.life_words import LifeWords, promised_delay, to_second_person


class Clock:
    def __init__(self, start=1_800_000_000.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def repo():
    r = Repository(os.path.join(tempfile.mkdtemp(), "life.db"))
    yield r
    r.close()


def test_state_survives_a_restart(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    life.contact("1", "Owner", "chan", is_dm=False)
    again = Life(repo, clock=clock)
    assert again.state["people"]["1"]["name"] == "Owner"
    assert again.state["home_channel"] == "chan"


def test_social_hunger_builds_with_no_contact(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    before = life.b["social_hunger"]
    clock.advance(4 * 3600)
    life.tick({})
    assert life.b["social_hunger"] > before


def test_addressing_her_eases_loneliness(repo):
    life = Life(repo, clock=Clock())
    life.b["loneliness"] = 0.8
    life.heard("1", "Owner", "Amy how are you", addressed=True)
    assert life.b["loneliness"] < 0.8


def test_missing_someone_grows_with_bond_and_absence(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    for _ in range(30):
        life.contact("1", "Owner", "chan", is_dm=False)
        clock.advance(3600)
    life.tick({})
    clock.advance(48 * 3600)
    life.tick({})
    assert life.state["people"]["1"]["missing"] > 0.3


def test_she_dms_someone_she_misses(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    p = life.person("1", "Owner")
    p["bond"], p["missing"], p["last_contact"] = 0.8, 0.9, clock() - 72 * 3600
    choice = life.tick({"room_active": True})
    assert choice and choice["want"] == "dm" and choice["id"] == "1"
    life.done(choice, "hey you")
    assert life.state["people"]["1"]["dm"]["awaiting"]
    again = life.tick({"room_active": True})
    assert again is None or again["want"] != "dm"


def test_owner_gets_devoted_stance_and_rudeness_cools_others(repo):
    life = Life(repo, clock=Clock(), owner_id="42")
    assert life.stance("42") == "devoted"
    for _ in range(4):
        life.feel_update("7", "shut up you're useless")
    assert life.stance("7") == "cold"


def test_quiet_request_holds_her_back(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    life.heard("1", "Owner", "Amy be quiet", addressed=True)
    assert life.state["quiet_until"] > clock()
    assert life.b["inhibition"] >= 0.85


def test_join_call_when_her_people_are_in_one(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    p = life.person("1", "Owner")
    p["bond"], p["missing"] = 0.9, 0.8
    room = {"guild_id": "g", "channel_id": "v", "name": "General", "people": [{"id": "1", "name": "Owner"}]}
    choice = life.tick({"voice_rooms": [room], "room_active": True})
    assert choice and choice["want"] == "join_call"
    life.done(choice, "joined General")
    again = life.tick({"voice_rooms": [room], "room_active": True})
    assert again is None or again["want"] != "join_call"


def test_told_to_leave_blocks_rejoining(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    p = life.person("1", "Owner")
    p["bond"], p["missing"] = 0.9, 0.8
    life.told_to_leave("Owner")
    room = {"guild_id": "g", "channel_id": "v", "name": "General", "people": [{"id": "1", "name": "Owner"}]}
    choice = life.tick({"voice_rooms": [room], "room_active": True})
    assert choice is None or choice["want"] != "join_call"


def test_invite_from_someone_close_is_accepted(repo):
    life = Life(repo, clock=Clock(), rng=random.Random(1))
    p = life.person("1", "Owner")
    p["bond"] = 0.9
    life.b["social_hunger"] = 0.9
    decision = life.consider_invite("1", "Owner", [{"id": "1", "name": "Owner"}])
    assert decision["join"]


def test_in_a_call_she_waits_for_a_lull(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    life.joined_call()
    life.b["boredom"] = 0.95
    life.heard("1", "Owner", "talking about trucks", addressed=False)
    here = [{"id": "1", "name": "Owner"}]
    choice = life.tick({"in_voice": True, "here": here, "can_speak_now": True, "room_active": True})
    assert choice is None or choice["scope"] != "call"  # nobody's paused yet


def test_ignored_speak_up_raises_frustration_and_streak(repo):
    clock = Clock()
    life = Life(repo, clock=clock)
    life.spoke("anyone want to talk?", unprompted=True, want="break_silence")
    clock.advance(15)  # past the quick-reply window: these lines aren't answers to her
    for line in ("so the game", "the game tonight", "the game was", "game stuff"):
        life.heard("1", "Owner", line, addressed=False)
    assert life.state["ignored_streak"] == 1
    assert life.b["frustration"] > 0


def test_not_live_never_acts(repo):
    life = Life(repo, clock=Clock(), config={"live": False})
    p = life.person("1", "Owner")
    p["bond"], p["missing"] = 0.8, 0.9
    assert life.tick({"room_active": True}) is None


def test_avatar_feelings_follow_her_drives(repo):
    life = Life(repo, clock=Clock())
    life.b["curiosity"] = 0.9
    assert life.avatar_feelings()["curious"] > 0.4


# ---- words ----

def convo_with_facts(repo):
    convo = Conversation(repo, self_name="Amy", persona="amy")
    convo.handle("Owner owns a red truck.", speaker="Owner")
    return convo


def test_words_for_every_call_want(repo):
    convo = convo_with_facts(repo)
    words = LifeWords(convo, life=Life(repo, clock=Clock()), rng=random.Random(3))
    for want in ("welcome_back", "check_in", "join_in", "break_silence", "ask", "ask_about_them",
                 "share", "start_topic", "arrive", "decided_to_join", "kept_promise"):
        line = words.speak_up(want, "Owner", "1")
        if want != "share":
            assert line and line[0].isupper(), want


def test_asking_about_someone_uses_what_she_knows(repo):
    convo = convo_with_facts(repo)
    words = LifeWords(convo, life=Life(repo, clock=Clock()), rng=random.Random(0))
    line = words.speak_up("ask_about_them", "Owner", "1")
    assert "red truck" in line.lower()


def test_dm_by_stance(repo):
    convo = convo_with_facts(repo)
    life = Life(repo, clock=Clock(), owner_id="1")
    words = LifeWords(convo, life=life, rng=random.Random(0))
    assert words.dm("1", "Owner")


def test_journal_and_story_are_full_paragraphs(repo):
    convo = convo_with_facts(repo)
    life = Life(repo, clock=Clock())
    life.contact("1", "Owner", "c", is_dm=False)
    words = LifeWords(convo, life=life, rng=random.Random(2))
    entry = words.journal()
    assert entry.count(".") >= 2
    title, body = words.story()
    assert title and body.count(".") >= 3


def test_second_person_and_delays():
    assert to_second_person("Owner owns a red truck", "Owner") == "you own a red truck"
    assert to_second_person("Owner is tired", "Owner") == "you are tired"
    assert promised_delay("give me twenty minutes") == 1200
    assert promised_delay("in an hour") == 3600


# ---- the actor, against a fake bot ----

class FakeBridge:
    def __init__(self):
        self.sent = []
        self.inbox = queue.Queue()

    def send(self, message):
        self.sent.append(message)


class FakeService:
    def __init__(self):
        self.speaker = None
        self.playing = set()
        self.last_activity = 0.0
        self.last_text_channel = None
        self.last_voice_guild = None
        self.wording = None


class FakeBot:
    def __init__(self, repo):
        self.repo = repo
        self.convo = convo_with_facts(repo)
        self.bridge = FakeBridge()
        self.service = FakeService()


def test_actor_dms_and_joins(repo, monkeypatch):
    from interfaces.life_actor import LifeActor
    bot = FakeBot(repo)
    actor = LifeActor(bot)
    p = actor.life.person("1", "Owner")
    p["bond"], p["missing"] = 0.9, 0.95
    bot.service.last_activity = __import__("time").time()  # people are talking: no inner-life reading now
    actor.tick()
    dm = [m for m in bot.bridge.sent if m["type"] == "dm"]
    assert dm and dm[0]["user"] == "1" and dm[0]["content"]
    actor.observe({"type": "dm-sent", "user": "1", "channel": "d"})
    assert actor.pending is None
    assert actor.life.state["people"]["1"]["dm"]["awaiting"]

    actor.observe({"type": "voice-rooms", "mine": {}, "rooms": [
        {"guild_id": "g", "channel_id": "v", "name": "General", "joinable": True, "mine": False,
         "people": [{"id": "1", "name": "Owner"}]}]})
    actor.life.state["acted"].clear()
    actor.tick()
    joins = [m for m in bot.bridge.sent if m["type"] == "join-voice"]
    assert joins and joins[0]["channel"] == "v"


def test_actor_answers_an_invite(repo):
    from interfaces.life_actor import LifeActor
    bot = FakeBot(repo)
    actor = LifeActor(bot)
    p = actor.life.person("1", "Owner")
    p["bond"] = 0.95
    actor.life.b["social_hunger"] = 1.0
    actor.observe({"type": "voice-rooms", "mine": {}, "rooms": [
        {"guild_id": "g", "channel_id": "v", "name": "General", "joinable": True, "mine": False,
         "people": [{"id": "1", "name": "Owner"}]}]})
    answer = actor.text({"guild": "g", "channel": "t", "author": {"id": "1", "name": "Owner"}},
                        "Amy, come join us in voice!")
    assert answer
    assert any(m["type"] == "join-voice" for m in bot.bridge.sent) == ("not" not in answer.lower() and "sit this" not in answer.lower() and "later" not in answer.lower())

"""The digestion pass: a lookup becomes a small note Amy can reuse and reflect on."""

import json
import os
import tempfile

import pytest

from app.conversation import Conversation
from db.repository import Repository

friend_11 = (
    "friend_11 asiatica is a species of bolete mushroom of the family Boletaceae. "
    "It is reddish in color and an ectomycorrhizal symbiote of Pinus yunnanensis. "
    "It is a type of hallucinogenic bolete mushroom and is notable for causing "
    "lilliputian hallucinations when eaten raw or undercooked."
)


@pytest.fixture
def convo():
    repo = Repository(os.path.join(tempfile.mkdtemp(), "t.db"))
    c = Conversation(repo, speaker="Owner", self_name="Amy")
    c.curiosity.rng.random = lambda: 1.0
    yield c
    repo.close()


def ask(convo, q):
    return convo.handle(q, speaker="Owner")


def read(convo):
    result = convo.digest(friend_11, "wikipedia:friend_11 asiatica", topic="friend_11 asiatica")
    return convo.digester.note("friend_11 asiatica"), result


def test_note_keeps_a_gist_and_self_contained_points(convo):
    note, result = read(convo)
    assert note is not None
    assert note.gist.startswith("friend_11 asiatica is a species of bolete mushroom")
    assert "Boletaceae" in note.gist
    assert result.facts
    # Pronouns resolve to the subject, so a point stands on its own.
    assert any("friend_11 asiatica is reddish" in point for point in note.points)
    # A participle the parser left behind is not offered as a point.
    assert all("Eaten raws" not in point for point in note.points)
    assert all(len(point.split()) >= 3 for point in note.points)
    assert "friend_11 asiatica" in note.terms


def test_a_long_point_is_cut_at_a_clause_not_mid_conjunction(convo):
    text = ('"What Is Life" is a song by the English rock musician George Harrison. '
            'In many countries, it was issued as the second single from the album, in February 1971, '
            "becoming a top-ten hit in the United States, Canada and elsewhere, and topping singles "
            "charts in Australia and Switzerland.")
    note = convo.digester.record("What Is Life", "wikipedia:What Is Life", text)
    assert note is not None
    assert note.points
    for point in note.points:
        assert not point.rstrip(".").endswith((" and", " or", " with", " of", " the"))
        assert len(point.split()) <= 35


def test_stored_points_are_cleaned_when_read(convo):
    read(convo)
    bad = ("In many countries, it was issued as the second single from the album, in February 1971, "
           "becoming a top-ten hit in the United States, Canada and elsewhere, and topping singles "
           "charts in Australia and.")
    with convo.repo.conn:
        convo.repo.conn.execute("UPDATE digest_notes SET points_json=? WHERE topic_key=?",
                                (json.dumps([bad]), "friend_11 asiatica"))
    note = convo.digester.note("friend_11 asiatica")
    assert note.points == [bad.removesuffix(" and.") + "."]


def test_explicit_topic_beats_a_source_label(convo):
    convo.digest("Wugs are birds.", "news:BBC:42", topic="Wugs")
    note = convo.digester.note("Wugs")
    assert note is not None
    assert note.topic == "Wugs"
    assert note.gist.startswith("Wugs are birds")
    assert convo.digester.note("BBC") is None


def test_note_merge_keeps_the_longer_gist_and_deduplicates_points(convo):
    convo.digest(friend_11, "wikipedia:friend_11 asiatica", topic="friend_11 asiatica")
    convo.digest(friend_11, "wikipedia:friend_11 asiatica", topic="friend_11 asiatica")
    rows = convo.repo.conn.execute("SELECT * FROM digest_notes").fetchall()
    assert len(rows) == 1
    points = json.loads(rows[0]["points_json"])
    assert len(points) == len(set(points))
    assert rows[0]["gist"].startswith("friend_11 asiatica is a species")


def test_note_records_that_she_understood_something(convo):
    read(convo)
    events = [row["event"] for row in convo.repo.conn.execute(
        "SELECT event FROM emotion_events ORDER BY id")]
    assert "understood" in events


def test_a_reference_request_reads_the_gist_back(convo):
    note, _ = read(convo)
    reply = ask(convo, "What did you find out about friend_11 asiatica?")
    assert reply.trace["intent"] == "digest-reference"
    assert "read on Wikipedia" in reply.text
    assert "friend_11 asiatica is a species of bolete mushroom" in reply.text
    assert convo.digester.note("friend_11 asiatica").uses == note.uses + 1


def test_a_simple_definition_gets_only_the_gist(convo):
    read(convo)
    reply = ask(convo, "What is friend_11 asiatica?")
    assert reply.trace["intent"] == "digest-reference"
    assert "friend_11 asiatica is a species of bolete mushroom" in reply.text
    assert "reddish" not in reply.text


def test_summarize_that_uses_the_note_not_the_whole_definition(convo):
    read(convo)
    reply = ask(convo, "Summarize that.")
    assert reply.trace["intent"] == "digest-reference"
    assert "gist" in reply.text.lower()
    assert "lilliputian" not in reply.text


def test_reflection_reasons_over_the_note_and_stores_the_opinion(convo):
    read(convo)
    reply = ask(convo, "What do you think about that?")
    assert reply.trace["intent"] == "reflection"
    assert "friend_11 asiatica" in reply.text
    record = reply.trace["reflection"]
    assert record["opinion"] and record["feeling"]
    assert record["note_id"] is not None

    stored = convo.repo.conn.execute(
        "SELECT * FROM digest_reflections ORDER BY id DESC LIMIT 1").fetchone()
    assert stored["topic"] == "friend_11 asiatica"
    assert stored["opinion"] == record["opinion"]
    appraisal = json.loads(stored["appraisal_json"])
    assert appraisal["stance"] in {"heavy", "uneasy", "engaged", "familiar", "flat", "curious", "neutral"}
    assert appraisal["reason"]
    assert record["appraisal"] == appraisal
    note = convo.digester.note("friend_11 asiatica")
    assert note.opinion == record["opinion"]
    assert note.feeling == record["feeling"]


def test_reflection_feeds_the_one_mood_system(convo):
    read(convo)
    before = convo.self_model.emotions()
    ask(convo, "What do you think about that?")
    events = [row["event"] for row in convo.repo.conn.execute(
        "SELECT event FROM emotion_events ORDER BY id")]
    assert "reflected" in events
    after = convo.self_model.emotions()
    assert after != before  # the same SelfModel moved; there is no second mood store


def test_feeling_question_answers_with_the_feeling_first(convo):
    read(convo)
    reply = ask(convo, "How does that make you feel?")
    assert reply.trace["intent"] == "reflection"
    assert reply.text.startswith(("It ", "My state", "Honestly"))
    assert "what i keep coming back to" in reply.text.lower()


def test_a_possessive_pronoun_is_resolved_too(convo):
    text = ("Vaquita is a critically endangered porpoise. "
            "Its population has fallen below ten individuals.")
    note = convo.digester.record("Vaquita", "wikipedia:Vaquita", text)
    assert note is not None
    assert any(point.startswith("Vaquita's population") for point in note.points)


def test_a_heavy_reflection_says_what_stays_with_her(convo):
    opinion, used = convo.reflector._opinion(
        "Vaquita", "Vaquita is a porpoise.", "Vaquita's population has fallen below ten individuals.",
        {"sadness": 0.6}, True)
    assert opinion.startswith("I think it's a heavy thing to sit with.")
    assert "What stays with me is that Vaquita's population" in opinion
    assert used == "Vaquita's population has fallen below ten individuals"


def test_a_sentence_long_label_is_not_used_as_a_noun_phrase(convo):
    opinion, used = convo.reflector._opinion(
        "Binance is a crypto exchange", "Binance is a crypto exchange.", "", {"interest": 0.6}, False)
    assert used == "Binance is a crypto exchange"
    assert "genuinely interesting" not in opinion
    assert "Binance is a crypto exchange" in opinion


def test_a_fresh_finding_can_actually_grab_her(convo):
    read(convo)
    reply = ask(convo, "What do you think about that?")
    assert "grabs me" in reply.text
    assert "interesting" not in reply.text.lower()


def test_a_repeated_thin_note_is_allowed_to_be_boring(convo):
    convo.digester.record("Zorbly", "wikipedia:Zorbly", "The Zorbly notwithstanding.")
    with convo.repo.conn:
        convo.repo.conn.execute("UPDATE digest_notes SET uses=2 WHERE topic_key='zorbly'")
    reply = ask(convo, "What do you think about that?")
    assert "doesn't do much for me" in reply.text
    assert "interesting" not in reply.text.lower()


def test_a_related_finding_says_what_it_connects_to(convo):
    convo.digester.record("friend_11 asiatica", "wikipedia:friend_11 asiatica",
                          "friend_11 asiatica is a bolete in the family Boletaceae.")
    convo.digester.record("Boletus edulis", "wikipedia:Boletus edulis",
                          "Boletus edulis is a bolete in the family Boletaceae.")
    reply = ask(convo, "What do you think about that?")
    assert "connects to friend_11 asiatica" in reply.text


def test_a_repeated_related_finding_feels_familiar_rather_than_new(convo):
    convo.digester.record("friend_11 asiatica", "wikipedia:friend_11 asiatica",
                          "friend_11 asiatica is a bolete in the family Boletaceae.")
    convo.digester.record("Boletus edulis", "wikipedia:Boletus edulis",
                          "Boletus edulis is a bolete in the family Boletaceae.")
    with convo.repo.conn:
        convo.repo.conn.execute("UPDATE digest_notes SET uses=2 WHERE topic_key='boletus edulis'")
    reply = ask(convo, "What do you think about that?")
    assert "fits with" in reply.text
    assert "grabs me" not in reply.text


def test_a_named_topic_without_a_note_is_not_invented(convo):
    read(convo)
    reply = ask(convo, "What do you think about quantum chromodynamics?")
    assert reply.trace["intent"] == "reflection"
    assert "don't know enough" in reply.text
    assert "friend_11" not in reply.text
    assert convo.repo.conn.execute("SELECT COUNT(*) FROM digest_reflections").fetchone()[0] == 0


def test_a_simple_question_about_another_topic_does_not_reuse_the_last_note(convo):
    read(convo)
    reply = ask(convo, "What is a dog?")
    assert "friend_11" not in reply.text


def test_a_self_question_is_not_treated_as_a_definition(convo):
    read(convo)
    assert convo.reflector.reference("What are you thinking about?") is None
    assert convo.reflector.reference("What is your name?") is None


def test_reflection_falls_back_to_the_last_reply(convo):
    convo.state.last_trace = {"generated": "Burbank is a city in California. It has an airport."}
    reply = ask(convo, "What do you think about that?")
    assert reply.trace["intent"] == "reflection"
    assert "Burbank" in reply.text
    assert "airport" in reply.text
    assert reply.trace["reflection"]["note_id"] is None


def test_notes_survive_a_restart(tmp_path):
    path = tmp_path / "amy.db"
    repo = Repository(str(path))
    first = Conversation(repo, speaker="Owner", self_name="Amy")
    first.digest(friend_11, "wikipedia:friend_11 asiatica", topic="friend_11 asiatica")
    repo.close()

    repo = Repository(str(path))
    second = Conversation(repo, speaker="Owner", self_name="Amy")
    note = second.digester.note("friend_11 asiatica")
    assert note is not None
    assert note.gist.startswith("friend_11 asiatica is a species")
    reply = second.handle("What did you find out about friend_11 asiatica?", speaker="Owner")
    assert "Boletaceae" in reply.text
    repo.close()

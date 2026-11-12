"""Voice pipeline tests with fake STT/TTS and a fake sidecar: no Discord, no models."""

import base64
import time

import numpy as np
import pytest

from app.conversation import Conversation
from db.repository import Repository
from voice.audio import resample, to_discord_pcm
from voice.service import VoiceService
from voice import tts
from voice.tts import FishSpeaker, TTSError, speakable
from voice.wake import WakeWord


class FakeTranscriber:
    def __init__(self):
        self.next = ""
        self.vocab = None

    def transcribe(self, pcm, vocabulary=None):
        self.vocab = vocabulary
        return type("T", (), {"text": self.next})()


class FakeSpeaker:
    def discord_pcm(self, text):
        return b"\x00\x00" * 4


@pytest.fixture
def rig():
    repo = Repository(":memory:")
    sent = []
    stt = FakeTranscriber()
    service = VoiceService(Conversation(repo), sent.append, stt, FakeSpeaker(), WakeWord("Hal"), log=lambda m: None)
    yield service, stt, sent
    repo.close()


def speak(service, stt, text, name="Owner"):
    stt.next = text
    service.handle({"type": "utterance", "guild": "g1", "textChannel": "t1", "user": {"id": str(abs(hash(name)) % 10**9), "name": name},
                    "durationMs": 1200, "startedAt": time.time() * 1000, "pcm": base64.b64encode(b"\0\0").decode()})


# --- wake word ------------------------------------------------------------------

@pytest.mark.parametrize("heard, addressed, rest", [
    ("Hal, does Howard own a truck?", True, "Does Howard own a truck?"),
    ("Hey Hal does Howard own a truck", True, "Does Howard own a truck"),
    ("Hale, what does Bob drive?", True, "What does Bob drive?"),   # Whisper mishearing
    ("What the hell is that?", False, "What the hell is that?"),    # everyday words don't wake it
    ("Howard owns a truck, right Hal?", True, "Howard owns a truck, right"),
    ("Howard owns a truck.", False, "Howard owns a truck."),
    ("Halloween is coming.", False, "Halloween is coming."),         # not a word boundary
    ("Hal?", True, ""),
])
def test_wake_word(heard, addressed, rest):
    result = WakeWord("Hal").check(heard, "Owner", now=0)
    assert (result.addressed, result.text) == (addressed, rest)


def test_follow_up_window():
    wake = WakeWord("Hal", follow_up_seconds=8)
    wake.answered("Owner", now=100)
    assert wake.check("And what about Bob?", "Owner", now=105).by_follow_up
    assert not wake.check("And what about Bob?", "Sam", now=105).addressed      # someone else
    assert not wake.check("And what about Bob?", "Owner", now=120).addressed   # window closed


# --- service --------------------------------------------------------------------

def test_overheard_speech_is_remembered_not_answered(rig):
    service, stt, sent = rig
    speak(service, stt, "Howard owns a red truck.", name="Bob")
    assert sent == []
    speak(service, stt, "Hal, what did Bob say about Howard?")
    reply = sent[0]["content"]
    assert reply.startswith("\U0001f399️ **Owner:** What did Bob say about Howard?")
    assert "Bob said: “Howard owns a red truck.”" in reply
    # It stays out of the conversation proper, but he can still recall hearing it.
    assert service.convo.repo.conn.execute(
        "SELECT COUNT(*) FROM dialogue_turns t JOIN utterances u ON u.id = t.utterance_id "
        "WHERE u.speaker = 'Bob'").fetchone()[0] == 0
    heard = [r["text"] for r in service.convo.repo.recall_turns() if r["speaker"] == "Bob"]
    assert heard == ["Howard owns a red truck."]
    speak(service, stt, "Hal, does Howard own a truck?")
    assert "I don't know whether Howard owns a truck" in sent[-2]["content"]  # overheard, not learned


def test_addressed_speech_is_learned_and_spoken(rig):
    service, stt, sent = rig
    speak(service, stt, "Hal, Howard owns a red truck.")
    assert sent[0]["type"] == "say" and sent[0]["content"].endswith(": Howard owns a red truck.")
    assert sent[1]["type"] == "play" and sent[1]["guild"] == "g1"
    speak(service, stt, "Does he own a vehicle?")  # follow-up: no wake word needed
    assert sent[2]["type"] == "say"


def test_wake_only_and_learn_overheard(rig):
    service, stt, sent = rig
    speak(service, stt, "Hal?")
    assert sent[0]["content"].endswith("Yes?")
    service.learn_overheard = True
    speak(service, stt, "Bob lives in Dayton.", name="Sam")
    speak(service, stt, "Hal, where does Bob live?", name="Sam")
    assert "Bob lives in Dayton." in sent[-2]["content"]


def test_always_mode_and_commands(rig):
    service, stt, sent = rig
    service.handle({"type": "command", "channel": "t1", "command": "mode", "arg": "always", "author": {}})
    assert "everything I hear" in sent[-1]["content"]
    speak(service, stt, "Howard owns a boat.")
    assert sent[-2]["content"].endswith(": Howard owns a boat.")


def test_text_messages_need_no_wake_word(rig):
    service, _, sent = rig
    service.handle({"type": "text", "channel": "t1", "content": "Howard owns a boat.",
                    "author": {"name": "Tutor", "bot": False}})
    assert sent[-1]["type"] == "say" and sent[-1]["channel"] == "t1"
    assert sent[-1]["content"].endswith(": Howard owns a boat.")


def test_a_listened_channel_records_topics_without_learning_or_replying(rig):
    service, _, sent = rig
    service.handle({"type": "text", "channel": "t1",
                    "content": "We should rewrite the MCP tools in Rust.",
                    "author": {"name": "friend_11", "bot": False},
                    "direct": True, "addressed": False})
    assert sent == []  # he listens, but nobody spoke to him
    assert service.convo.repo.open_questions() == []
    assert service.convo.repo.conn.execute(
        "SELECT COUNT(*) FROM assertions WHERE source_utterance_id IS NOT NULL").fetchone()[0] == 0
    assert service.convo.world.interest("Rust") > 0
    assert service.convo.world.interest("MCP") > 0


def test_a_listened_topic_can_be_brought_up_and_then_learned(rig):
    service, _, _ = rig
    service.handle({"type": "text", "channel": "t1",
                    "content": "We should rewrite the MCP tools in Rust.",
                    "author": {"name": "friend_11", "bot": False},
                    "direct": True, "addressed": False})
    question = service.convo.handle("What are you curious about?", speaker="Owner").text
    assert "Rust" in question or "MCP" in question
    service.convo.handle("Rust is a systems programming language.", speaker="Owner")
    assert service.convo.repo.conn.execute(
        "SELECT COUNT(*) FROM assertions WHERE status='active' AND source_utterance_id IS NOT NULL").fetchone()[0] >= 1


def test_a_listened_channel_answers_when_named(rig):
    service, _, sent = rig
    service.handle({"type": "text", "channel": "t1", "content": "We should rewrite the MCP tools in Rust.",
                    "author": {"name": "friend_11", "bot": False},
                    "direct": True, "addressed": False})
    assert sent == []  # nobody was talking to him
    service.handle({"type": "text", "channel": "t1", "content": "Hal, Howard owns a boat.",
                    "author": {"name": "Owner", "bot": False},
                    "direct": True, "addressed": False})
    assert sent[-1]["type"] == "say"
    assert "Howard owns a boat" in sent[-1]["content"]


def test_start_always_then_switch_to_wake(rig):
    service, stt, sent = rig
    service.wake_enabled = False  # startup with HALMINI_LISTEN_MODE=always
    service.handle({"type": "ready", "user": {"name": "MiniMe"}})
    speak(service, stt, "Howard owns a boat.")
    assert sent[-2]["content"].endswith(": Howard owns a boat.")
    service.handle({"type": "command", "channel": "t1", "command": "mode", "arg": "wake"})
    assert "only when someone says my name" in sent[-1]["content"]
    sent.clear()
    speak(service, stt, "Bob owns a truck.", name="Bob")
    assert sent == []
    speak(service, stt, "MiniMe, Bob owns a truck.", name="Bob")
    assert sent[-2]["content"].endswith(": Bob owns a truck.")


def test_known_names_are_passed_to_stt(rig):
    service, stt, _ = rig
    speak(service, stt, "Hal, Howard owns a boat.")
    speak(service, stt, "Hal, hi.")
    assert "Hal" in stt.vocab and "Howard" in stt.vocab


def test_stale_utterances_are_dropped(rig):
    service, stt, sent = rig
    stt.next = "Hal, Howard owns a boat."
    service.handle({"type": "utterance", "guild": "g1", "textChannel": "t1", "user": {"id": "1", "name": "T"},
                    "startedAt": (time.time() - 120) * 1000, "pcm": ""})
    assert sent == []


# --- audio ----------------------------------------------------------------------

def test_audio_conversion():
    tone = np.sin(np.linspace(0, 2 * np.pi * 440, 22050)).astype(np.float32)  # 1 s at 22.05 kHz
    pcm = to_discord_pcm(tone, 22050)
    assert len(pcm) == 48000 * 2 * 2
    assert len(resample(tone, 22050, 16000)) == 16000


def test_speakable_strips_markup():
    assert speakable("I said: “**Hi** [debug #3]”") == "I said: Hi"


def _wav(rate=44100, seconds=1.0):
    import io, wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


def test_fish_speaker_request_and_audio(monkeypatch):
    seen = {}

    class Response:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return _wav()

    def fake_urlopen(request, timeout):
        import json
        seen["url"], seen["headers"], seen["body"] = request.full_url, dict(request.header_items()), json.loads(request.data)
        return Response()

    monkeypatch.setattr(tts.urllib.request, "urlopen", fake_urlopen)
    pcm = FishSpeaker("secret-key", voice_id="voice123").discord_pcm("**Hello** there")
    assert len(pcm) == 48000 * 2 * 2  # 1 s resampled to 48 kHz stereo
    assert seen["url"] == "https://api.fish.audio/v1/tts"
    assert seen["headers"]["Authorization"] == "Bearer secret-key" and seen["headers"]["Model"] == "s2.1-pro-free"
    assert seen["body"] == {"text": "Hello there", "format": "wav", "latency": "normal",
                            "normalize": True, "reference_id": "voice123"}


def test_fish_speaker_needs_key():
    with pytest.raises(TTSError):
        FishSpeaker("")


@pytest.mark.parametrize("heard, addressed, rest", [
    ("Adam, does Howard own a truck?", True, "Does Howard own a truck?"),
    ("Hey Adams, what's up", True, "What's up"),
    ("Addam what does Bob drive?", True, "What does Bob drive?"),
    ("Thanks, Adam.", True, "Thanks"),
    ("Howard owns a truck.", False, "Howard owns a truck."),
])
def test_adam_wake_word(heard, addressed, rest):
    result = WakeWord("Adam").check(heard, "Owner", now=0)
    assert (result.addressed, result.text) == (addressed, rest)


def test_filler_is_not_a_follow_up():
    wake = WakeWord("Adam", follow_up_seconds=8)
    wake.answered("Owner", now=100)
    for noise in ("Hmm.", "Huh?", "Um", "Okay.", "mm"):
        assert not wake.check(noise, "Owner", now=103).addressed, noise
    assert wake.check("And does Bob own one?", "Owner", now=103).by_follow_up


@pytest.mark.parametrize("heard, addressed, rest", [
    # straight from the live transcript, where these were missed
    ("Let's see here. Adam, what are you?", True, "What are you?"),
    ("Doesn't look like he picked that up. Adam, what are you?", True, "What are you?"),
    ("And I can't see his transcript. Adam, can you hear me? What are you?", True, "Can you hear me? What are you?"),
    ("Okay so, Adam what does Howard own?", True, "What does Howard own?"),
    ("That's cool. What are you, Adam?", True, "That's cool. What are you"),
    # mentions, not addresses
    ("His name is Adam. Let him talk for a second.", True, "His name is Adam. Let him talk for a second."),
    ("We'll go ahead and talk to Adam later.", True, "We'll go ahead and talk to Adam later."),
    ("I told Adam about it.", True, "I told Adam about it."),
])
def test_wake_word_anywhere_it_addresses_him(heard, addressed, rest):
    result = WakeWord("Adam").check(heard, "Owner", now=0)
    assert result.addressed == addressed
    if addressed:
        assert result.text == rest


def test_peer_start_request_uses_existing_discord_transport(rig):
    service, stt, sent = rig
    service.on_text({'content':'bring Alex in','channel':'t1','guild':'g1','direct':True,
                     'author':{'id':'owner','name':'Owner','bot':False}})
    assert sent[-1]['type']=='peer-request'
    assert sent[-1]['action']=='bring'
    assert sent[-1]['name'].lower()=='alex'


def test_peer_message_request_names_the_recipient(rig):
    service, stt, sent = rig
    service.on_text({'content':'tell Nova: hello there','channel':'t1','guild':'g1','direct':True,
                     'author':{'id':'owner','name':'Owner','bot':False}})
    assert sent[-1]['type']=='peer-request'
    assert sent[-1]['action']=='tell'
    assert sent[-1]['content']=='hello there'


def test_overheard_peer_start_request_does_not_bypass_wake_word(rig):
    service, stt, sent = rig
    speak(service,stt,'bring Alex in')
    assert not any(msg['type']=='peer-request' for msg in sent)


def test_peer_conversation_is_not_silenced_after_eight_messages(rig, monkeypatch):
    service, stt, sent = rig
    monkeypatch.setattr('voice.service.PEER_MAX_EXCHANGES', 0)
    assert all(service._peer_turn_allowed({'channel': 't1'}, True) for _ in range(25))


@pytest.mark.parametrize("heard", [
    "Hal, you said you remember my red truck?",
    "Hal, you remember my red truck. What did you mean?",
])
def test_reusing_words_from_a_recent_answer_does_not_discard_human_speech(rig, monkeypatch, heard):
    from types import SimpleNamespace
    service, stt, sent = rig
    repo = service.convo.repo
    utterance = repo.log_utterance('Owner', 'seed')
    repo.conn.execute("INSERT INTO dialogue_turns(utterance_id,role,text) VALUES (?, 'engine', ?)",
                      (utterance, 'You said you remember my red truck. What did you mean?'))
    repo.conn.commit()
    received = []
    def answer(text, **kwargs):
        received.append(text)
        return SimpleNamespace(text='I heard your follow-up question.')
    monkeypatch.setattr(service.convo, 'handle', answer)
    speak(service, stt, heard)
    assert len(received) == 1
    assert 'red truck' in received[0]
    assert any(message['type'] == 'say' and 'I heard your follow-up question.' in message['content'] for message in sent)


def test_bot_text_is_ignored(rig):
    service, _, sent = rig
    service.handle({'type':'text','channel':'t1','content':'Hal, hello?',
                    'author':{'name':'PeerBot','bot':True}})
    assert not sent


def test_bot_voice_gets_audio_without_text(rig):
    service, stt, sent = rig
    stt.next = 'Hal, hello?'
    service.handle({'type':'utterance','guild':'g1','textChannel':'t1',
                    'user':{'id':'peer','name':'PeerBot','bot':True},
                    'durationMs':1200,'startedAt':time.time()*1000,
                    'pcm':base64.b64encode(b'\0\0').decode()})
    assert any(m['type']=='play' for m in sent)
    assert not any(m['type']=='say' for m in sent)



def test_own_thoughts_are_spoken_in_voice_not_only_posted(rig):
    service, stt, sent = rig
    speak(service, stt, "Hal, Trump is a president.")
    service.playing.clear()
    sent.clear()
    service.announce("Don't hold me to it, but Trump is a leader.")
    kinds = [m["type"] for m in sent]
    assert "play" in kinds and any(m["type"] == "say" and "leader" in m["content"] for m in sent)
    service.handle({"type": "left", "guild": "g1"})
    sent.clear()
    service.announce("Another thought.")
    assert [m["type"] for m in sent] == ["say"]  # no voice channel to speak into

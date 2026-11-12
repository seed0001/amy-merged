"""Grandpa's avatar page state: appearance, feelings, performance and the live mood feed.

The browser engine is exercised by hand; these tests cover the small server it talks to.
"""

import pytest

from interfaces import avatar


@pytest.fixture
def state(tmp_path):
    return avatar.AvatarState(tmp_path / "state.json")


def test_character_is_amy(state):
    character = state.character()
    assert character["name"] == "Amy"
    assert character["role"] == "your companion"
    assert state.characters()[0]["id"] == "main"


def test_appearance_accepts_names_and_hex_and_resets(state):
    saved = state.appearance_set({"hair": "blonde", "eyes": "#123456"})
    assert saved["hair"] == "#d9b76c"
    assert saved["eyes"] == "#123456"

    # An empty value means "leave it alone", not "clear it".
    assert state.appearance_set({"hair": ""})["hair"] == "#d9b76c"

    with pytest.raises(ValueError):
        state.appearance_set({"hair": "plaid"})

    assert state.appearance_set({}, reset=True)["hair"] is None


def test_appearance_clamps_its_numbers(state):
    assert state.appearance_set({"lipGloss": 0.4})["lipGloss"] == 0.4
    with pytest.raises(ValueError):
        state.appearance_set({"lipGloss": 2})
    with pytest.raises(ValueError):
        state.appearance_set({"makeupIntensity": "lots"})


def test_background_is_a_setting_not_the_live_feed(state):
    # Regression: the live mood dict used to shadow this method.
    assert state.background()["value"] == "studio"

    assert state.background_set({"action": "preset", "value": "dusk"})["value"] == "dusk"
    assert state.background()["value"] == "dusk"

    assert state.background_set({"type": "color", "value": "#223344"})["type"] == "color"
    with pytest.raises(ValueError):
        state.background_set({"action": "preset", "value": "night"})
    with pytest.raises(ValueError):
        state.background_set({"action": "colour", "value": "nope"})


def test_manual_feelings_merge_with_amy_and_reset(state):
    state.nudge({"joy": 0.8})
    assert state.feelings()["joy"] == 0.8

    # Amy's own mood colours the face without overwriting a manual choice.
    with state.lock:
        state.live = {"worried": 0.5}
    feelings = state.feelings()
    assert feelings["joy"] == 0.8 and feelings["worried"] == 0.5

    assert state.reset_feelings() == {"worried": 0.5}


def test_feelings_decay_over_time(state):
    state.nudge({"sad": 1.0})
    later = state.data["feelings_at"] + avatar.HALF_LIFE_MS
    with state.lock:
        assert state._feelings_locked(later)["sad"] == 0.5


def test_feelings_ignore_unknown_names(state):
    assert state.nudge({"triumphant": 0.9, "joy": 0.5}) == {"joy": 0.5}


def test_pose_keeps_only_shapes_this_model_has(state):
    # Strength rides alongside the shapes; the page scales them when it applies the pose.
    result = state.performance_command({"action": "pose", "expression": "smile", "strength": 0.5})
    assert result["face"]["strength"] == 0.5
    assert result["face"]["shapes"] == {"mouthSmileLeft": 0.8, "mouthSmileRight": 0.8,
                                        "cheekSquintLeft": 0.25, "cheekSquintRight": 0.25}

    with pytest.raises(ValueError):
        state.performance_command({"action": "pose", "expression": "no_such_face"})

    custom = state.performance_command({"action": "pose", "expression": "custom",
                                        "shapes": [{"name": "jawOpen", "value": 1},
                                                   {"name": "not_a_shape", "value": 1}]})
    assert custom["face"]["shapes"] == {"jawOpen": 1.0}


def test_gestures_need_the_bones_and_a_duration(state):
    assert state.performance_command({"action": "gesture", "gesture": "wave"})["motion"]["name"] == "wave"
    with pytest.raises(ValueError):
        state.performance_command({"action": "gesture", "gesture": "moonwalk"})
    with pytest.raises(ValueError):
        state.performance_command({"action": "gesture", "gesture": "wave", "duration": 0})

    state.performance_command({"action": "reset"})
    assert state.performance_state()["face"] is None and state.performance_state()["motion"] is None


def test_performance_settings_validate(state):
    assert state.performance_command({"action": "gaze", "gaze": "camera"})["gaze"] == "camera"
    with pytest.raises(ValueError):
        state.performance_command({"action": "gaze", "gaze": "sideways"})
    with pytest.raises(ValueError):
        state.performance_command({"action": "settings", "autonomous": "maybe"})
    with pytest.raises(ValueError):
        state.performance_command({"action": "settings", "gain": 9})


def test_view_framing_keeps_zoom_in_step(state):
    assert state.view_set({"frame": "body"})["frame"] == "body"
    assert state.view_set({"scale": 2})["zoom"] == 1.0
    with pytest.raises(ValueError):
        state.view_set({"frame": "knees"})


def test_library_report_is_ok_so_the_page_does_not_reload(state):
    # The engine reloads the model when this endpoint stops answering ok.
    assert state.report({"revision": 1}) == {"ok": True}
    assert state.library()["report"]["ok"] is True


def test_emotions_map_onto_the_avatar_vocabulary():
    feelings = avatar._map_emotions(
        {"excitement": 0.0, "sadness": 0.5, "anxiety": 0.9, "frustration": 0.2,
         "contentment": 0.0, "interest": 0.7, "affection": 0.1},
        {"stress": 0.9, "energy": 0.3})
    assert feelings["sad"] == 0.5
    assert feelings["worried"] == 0.9  # anxiety, not the stress dimension on top
    assert feelings["curious"] == 0.7
    assert feelings["frustrated"] == 0.2
    assert "excited" not in feelings
    assert feelings["tired"] > 0


def test_state_survives_a_restart(tmp_path):
    path = tmp_path / "state.json"
    first = avatar.AvatarState(path)
    first.background_set({"action": "preset", "value": "day"})
    first.appearance_set({"hair": "black"})

    second = avatar.AvatarState(path)
    assert second.background()["value"] == "day"
    assert second.appearance()["hair"] == "#111111"


def _tone(seconds, amplitude=8000, rate=48000):
    import math
    import struct
    out = bytearray()
    for i in range(int(rate * seconds)):
        v = int(amplitude * math.sin(2 * math.pi * 220 * i / rate))
        out += struct.pack("<hh", v, v)
    return bytes(out)


def test_speech_envelope_follows_loudness():
    pcm = bytes(48000 * 4 // 5) + _tone(0.2)  # 0.2s silence, then 0.2s voice
    frames = avatar.speech_envelope(pcm)
    assert len(frames) == 10
    assert frames[0]["open"] == 0
    assert frames[-1]["open"] > 0.5
    assert set(frames[0]) == {"open", "wide", "round", "bright"}


def test_speech_feelings_blend_mood_and_delivery():
    feelings = avatar.speech_feelings({"emotions": {"interest": 0.5}, "energy": 1.0, "stress": 0.2},
                                      ["happy", "sad"])
    assert feelings["curious"] == 0.5
    assert feelings["joy"] == 0.6
    assert "sad" not in feelings


def test_hub_mirrors_discord_speech(state):
    hub = avatar.AvatarHub(state)
    client = hub.subscribe()
    packet = avatar.speech_packet(_tone(0.1), "Hello there.", "guild-1", {"joy": 0.6})
    packet["at"] = 1000.0
    hub.speech(packet)
    expression, speech = client.get_nowait(), client.get_nowait()
    assert expression == {"type": "expression", "character": "main", "feelings": {"joy": 0.6}, "at": 1000.0}
    assert speech["type"] == "discord-speech"
    assert speech["speech"]["frames"] and speech["speech"]["text"] == "Hello there."
    assert hub.speech({"type": "stop", "conversation": "guild-1", "id": "other"}) == {"stopped": False}
    assert hub.speech({"type": "stop", "conversation": "guild-1", "id": packet["id"]}) == {"stopped": True}
    stop = client.get_nowait()["speech"]
    assert stop["type"] == "stop" and stop["id"] == packet["id"]
    with pytest.raises(ValueError):
        hub.speech({"type": "start"})


def test_voice_service_publishes_on_playback():
    from types import SimpleNamespace
    from voice.service import VoiceService

    sent, published = [], []
    convo = SimpleNamespace(self_model=SimpleNamespace(snapshot=lambda: {"emotions": {"affection": 0.4}}))
    service = VoiceService(convo, sent.append, transcriber=None, log=lambda m: None, avatar=published.append)
    service._play("g", _tone(0.1), "First.")
    service._play("g", _tone(0.1), "Second.")
    assert [m["type"] for m in sent] == ["play", "play"] and not published
    service.handle({"type": "playback", "guild": "g", "state": "started"})
    assert published[-1]["text"] == "First." and published[-1]["feelings"] == {"fond": 0.4}
    service.handle({"type": "playback", "guild": "g", "state": "started"})
    assert published[-2]["type"] == "stop" and published[-1]["text"] == "Second."
    service.handle({"type": "playback", "guild": "g", "state": "finished"})
    assert published[-1] == {"type": "stop", "conversation": "g", "id": published[-2]["id"], "reason": "ended"}

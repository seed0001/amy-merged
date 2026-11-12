import os

import pytest

from app import config
from interfaces import dashboard, discord_bot


class FakeBridge:
    started = 0

    def __init__(self, node="node"):
        import queue
        self.inbox = queue.Queue()
        self.sent = []

    def send(self, message):
        self.sent.append(message)

    def start(self):
        FakeBridge.started += 1

    def stop(self):
        pass


class FakeThoughts:
    def __init__(self, path):
        pass

    def start(self):
        pass

    def stop(self):
        pass

    def respond(self, convo, text):
        return None


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text(f"DISCORD_TOKEN=x\nHALMINI_DB={tmp_path / 'amy.db'}\nHALMINI_NAME=Adam\n"
                                   "HALMINI_FOLLOW_UP_SECONDS=0\nTTS_ENGINE=none\n", encoding="utf-8")
    for key in list(config._FROM_FILE):
        os.environ.pop(key, None)
    config._FROM_FILE.clear()
    monkeypatch.setattr(discord_bot, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(discord_bot, "SidecarBridge", FakeBridge)
    monkeypatch.setattr(discord_bot, "ThoughtBridge", FakeThoughts)
    monkeypatch.setattr(discord_bot, "load_transcriber", lambda: None)
    monkeypatch.setattr(discord_bot, "avatar_publisher", lambda: None)
    monkeypatch.setattr(dashboard, "ROOT", tmp_path)
    FakeBridge.started = 0
    b = discord_bot.Bot()
    yield b
    b.repo.close()
    for key in list(config._FROM_FILE):
        os.environ.pop(key, None)
    config._FROM_FILE.clear()


def _edit_env(path, text):
    before = path.stat().st_mtime_ns
    path.write_text(text, encoding="utf-8")
    os.utime(path, ns=(before + 10**9, before + 10**9))


def test_settings_apply_without_restart_and_keep_discord(bot, tmp_path):
    bot.service.last_voice_guild = "g1"
    _edit_env(tmp_path / ".env", (tmp_path / ".env").read_text() + "HALMINI_LISTEN_MODE=always\n")
    bot.reload_if_changed()
    assert bot.service.wake_enabled is False          # new setting is live
    assert bot.service.last_voice_guild == "g1"       # still in the same voice channel
    assert FakeBridge.started == 1                    # Discord connection untouched


def test_removed_setting_goes_back_to_default(bot, tmp_path):
    _edit_env(tmp_path / ".env", (tmp_path / ".env").read_text().replace("HALMINI_FOLLOW_UP_SECONDS=0\n", ""))
    changed = config.load_dotenv(tmp_path / ".env")
    assert "HALMINI_FOLLOW_UP_SECONDS" in changed and "HALMINI_FOLLOW_UP_SECONDS" not in os.environ


def test_sidecar_setting_reconnects_discord(bot, tmp_path):
    _edit_env(tmp_path / ".env", (tmp_path / ".env").read_text().replace("HALMINI_NAME=Adam", "HALMINI_NAME=Amy"))
    bot.reload_if_changed()
    assert FakeBridge.started == 2 and bot.convo.self_name == "Amy"


def test_cleared_memory_is_picked_up_live(bot, tmp_path):
    bot.convo.handle("Jen lives in Denver.", speaker="Owner")
    dashboard.clear_memory(os.environ["HALMINI_DB"])
    bot.reload_if_changed()
    assert "Denver" not in bot.convo.handle("Where does Jen live?", speaker="Owner").text

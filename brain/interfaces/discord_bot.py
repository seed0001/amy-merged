"""Run HalMini on Discord: text chat plus voice (via the Node sidecar).

    python -m interfaces.discord_bot

In Discord: join a voice channel and type !join. Talk normally; say "Adam, ..." to address it.
"""

import os
import sys
import threading
import time
from pathlib import Path

from app.config import load_config, load_dotenv
from app.conversation import Conversation
from db.repository import Repository
from interfaces.life_actor import LifeActor
from reasoning.thought_bridge import ThoughtBridge
from voice.bridge import SidecarBridge
from voice.service import VoiceService
from voice.wake import WakeWord


def load_speaker():
    engine = os.environ.get("TTS_ENGINE", "fish").lower()
    if engine == "fish":
        if not os.environ.get("FISH_API_KEY"):
            print("FISH_API_KEY is not set.", file=sys.stderr)
            return None
        from voice.tts import FishSpeaker
        from voice.expression import VoiceExpressionEngine
        expression = None
        if os.environ.get("FISH_EXPRESSION_ENABLED", "true").lower() not in ("false", "0", "off"):
            expression = VoiceExpressionEngine(
                strength=float(os.environ.get("FISH_EXPRESSION_STRENGTH", "1.0")),
                effects=os.environ.get("FISH_VOCAL_EFFECTS", "true").lower() not in ("false", "0", "off"))
        return FishSpeaker(os.environ["FISH_API_KEY"], voice_id=os.environ.get("FISH_VOICE_ID") or None,
                           model=os.environ.get("FISH_MODEL", "s2.1-pro-free"),
                           latency=os.environ.get("FISH_LATENCY", "normal"), expression_engine=expression)
    if engine == "piper" and os.environ.get("PIPER_VOICE"):
        from voice.tts import PiperSpeaker
        return PiperSpeaker(os.environ["PIPER_VOICE"])
    return None


def avatar_publisher():
    """Mirror voice playback onto the dashboard's avatar page (mouth and feelings)."""
    if os.environ.get("HALMINI_AVATAR_SPEECH", "true").lower() in ("false", "0", "off"):
        return None
    from interfaces.avatar import SpeechPublisher
    port = os.environ.get("HALMINI_DASHBOARD_PORT", "8765")
    return SpeechPublisher(f"http://127.0.0.1:{port}/api/avatar/speech")


# Settings the Node sidecar reads when it starts: changing one reconnects it to Discord.
SIDECAR_KEYS = {"DISCORD_TOKEN", "HALMINI_PREFIX", "HALMINI_SILENCE_MS", "HALMINI_MIN_UTTERANCE_MS",
                "HALMINI_MAX_UTTERANCE_MS", "HALMINI_BARGE_IN", "HALMINI_TEXT_CHANNELS", "HALMINI_NAME", "NODE"}
WHISPER_KEYS = {"WHISPER_MODEL", "WHISPER_DEVICE", "WHISPER_COMPUTE_TYPE"}
ENV_FILE = Path(".env")


def load_transcriber():
    from voice.stt import Transcriber
    print("loading speech recognition model...", file=sys.stderr)
    return Transcriber(os.environ.get("WHISPER_MODEL", "small.en"),
                       device=os.environ.get("WHISPER_DEVICE", "auto"),
                       compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "default"))


class Bot:
    """The running bot. Dashboard changes (.env edits, a cleared memory) are picked up while it runs:
    the brain is rebuilt in place and Discord stays connected unless a sidecar setting changed."""

    def __init__(self) -> None:
        load_dotenv()
        if not os.environ.get("DISCORD_TOKEN"):
            sys.exit("Set DISCORD_TOKEN (see .env.example).")
        self.transcriber = load_transcriber()
        self.bridge = SidecarBridge(os.environ.get("NODE", "node"))
        self.service = None
        self._build()
        self.bridge.start()
        self.signature = self._signature()

    def _build(self) -> None:
        """Memory, conversation, voice service and background thinking, from the current settings."""
        config = load_config()
        name = os.environ.get("HALMINI_NAME", "Amy")
        self.repo = Repository(config.db_path)
        self.convo = Conversation(self.repo, self_name=name, max_depth=config.max_depth,
                                  budget=config.inference_budget, curious=True, persona='amy')
        speaker = load_speaker()
        if speaker is None:
            print("No text-to-speech configured: replies will be text only.", file=sys.stderr)
        aliases = tuple(a.strip().lower() for a in os.environ.get("HALMINI_WAKE_WORDS", "").split(",") if a.strip())
        wake = WakeWord(name, aliases or None,
                        follow_up_seconds=float(os.environ.get("HALMINI_FOLLOW_UP_SECONDS", "0")))
        old = self.service
        self.service = VoiceService(self.convo, self.bridge.send, self.transcriber, speaker, wake,
                                    learn_overheard=os.environ.get("HALMINI_LEARN_OVERHEARD", "false") == "true",
                                    log=lambda m: print(m, file=sys.stderr), avatar=avatar_publisher())
        self.service.wake_enabled = os.environ.get("HALMINI_LISTEN_MODE", "wake") == "wake"
        if old is not None:  # still in the same channels: keep where she is, not what she knew
            for attr in ("last_text_channel", "last_voice_guild", "playing"):
                if hasattr(old, attr):
                    setattr(self.service, attr, getattr(old, attr))
        # Her inner life: drives, people, and what she does on her own (dialogue/life.py).
        rooms = (self.life.rooms, self.life.mine) if getattr(self, "life", None) and old is not None else None
        self.life = LifeActor(self)
        if rooms:
            self.life.rooms, self.life.mine = rooms
        self.service.life = self.life
        self.thoughts = ThoughtBridge(config.db_path)
        self.convo.thinking = self.thoughts
        self.thoughts.start()
        self.interval = max(2., float(os.environ.get("HALMINI_THOUGHT_POST_SECONDS", "5")))

    def _signature(self):
        env = ENV_FILE.stat().st_mtime_ns if ENV_FILE.exists() else None
        try:
            memory = self.repo.memory_id
        except Exception:  # noqa: BLE001 - a wiped memory may be mid-rewrite; check again next tick
            memory = None
        return env, memory

    def reload_if_changed(self) -> None:
        signature = self._signature()
        if signature == self.signature:
            return
        changed = load_dotenv() if signature[0] != self.signature[0] else set()
        print(f"reloading: settings changed {sorted(changed)}" if changed else "reloading: memory changed",
              file=sys.stderr)
        self.thoughts.stop()
        self.repo.close()
        if changed & WHISPER_KEYS:
            self.transcriber = load_transcriber()
        if changed & SIDECAR_KEYS:
            self.bridge.stop()
            self.bridge = SidecarBridge(os.environ.get("NODE", "node"))
            self.service = None  # a new Discord session has no channels yet
        self._build()
        if changed & SIDECAR_KEYS:
            self.bridge.start()
        self.signature = self._signature()

    def on_tick(self) -> None:
        self.reload_if_changed()
        convo, service, thoughts = self.convo, self.service, self.thoughts
        convo.pressure.tick("timer")
        try:
            self.life.tick()  # she may decide to do something on her own
        except Exception as exc:  # noqa: BLE001 - her inner life must never take the bot down
            print(f"life tick failed: {exc!r}", file=sys.stderr)
        narrated = False
        for owner, target in list(service.progress_targets.items()):
            if thoughts.narration(convo, owner, lambda text, target=target: service.progress(text, target)):
                narrated = True
                break
        channel = getattr(service, "last_text_channel", None)
        investigating = any(thoughts.investigating(owner) for owner in service.progress_targets)
        if channel and not narrated and not investigating and not service.playing                 and time.time() - service.last_activity >= 8:
            for text in thoughts.announce(convo):
                service.announce(text)  # voice + avatar + text, like any reply

    def run(self) -> None:
        stopping = threading.Event()

        def tick():
            # Database access stays on the main thread: the timer only queues a tick for the loop below.
            while not stopping.wait(self.interval):
                self.bridge.inbox.put({"type": "thought-tick"})
        threading.Thread(target=tick, daemon=True).start()
        try:
            while True:
                bridge = self.bridge
                for message in bridge.messages():
                    try:
                        if message.get("type") == "thought-tick":
                            self.on_tick()
                            if self.bridge is not bridge:
                                break  # reconnected: read from the new sidecar
                            continue
                        if self.life.observe(message):
                            continue
                        self.service.handle(message)
                    except Exception as exc:  # one bad utterance must not take the bot down
                        print(f"error handling {message.get('type')}: {exc!r}", file=sys.stderr)
                if self.bridge is bridge:
                    break  # the sidecar exited on its own
        except KeyboardInterrupt:
            pass
        finally:
            stopping.set()
            self.thoughts.stop()
            self.bridge.stop()
            self.repo.close()


def main() -> None:
    Bot().run()


if __name__ == "__main__":
    main()

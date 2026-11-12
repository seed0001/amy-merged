"""Amy's 3D avatar page, served by her dashboard.

The browser side is the avatar studio engine from `new champ` (facial morphs, visemes, blinking,
gaze, head motion, gestures, expressions and appearance). This module is the small server the
engine talks to. It keeps the page's own state (the selected look, framing, pose and manual
feelings) in `data/avatar/state.json`, serves her model (data/avatar/amy.glb, ported from the voice
bot, with her fitted outfits in data/avatar/avatars/), and streams her live feelings from `SelfModel`
and her inner life (dialogue/life.py) over SSE, so her face shows what she feels.

The dashboard is a separate process from the bot, so nothing here writes to Amy's dialogue state.
It only reads the same SQLite database the dashboard already reads.
"""

from __future__ import annotations

import json
import os
import queue
import re
import struct
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSET_DIR = Path(__file__).resolve().parent / "avatar"
AVATAR_DIR = ROOT / "data" / "avatar"
LIBRARY_DIR = AVATAR_DIR / "avatars"
# Her own model; Grandpa only if hers is missing. HALMINI_AVATAR_MODEL overrides both.
MODEL_PATH = Path(os.environ.get("HALMINI_AVATAR_MODEL") or (
    AVATAR_DIR / "amy.glb" if (AVATAR_DIR / "amy.glb").exists() else AVATAR_DIR / "grandpa.glb"))


def _library_models() -> list[dict]:
    """Her fitted outfits (whole-model swaps), from the voice bot's avatar library."""
    try:
        library = json.loads((LIBRARY_DIR / "library.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [m for m in library.get("models", [])
            if m.get("outfit") and m.get("outfit") != "suit" and (LIBRARY_DIR / f"{m['id']}.glb").exists()]
STATE_PATH = ROOT / "data" / "avatar" / "state.json"

# The feeling vocabulary the avatar engine draws expressions from. Descriptions are only used by
# the emotion endpoint; the browser has its own copy of the shapes.
EMOTIONS = {
    "calm": "relaxed, at ease",
    "joy": "happy, delighted",
    "amused": "finds it funny, laughing",
    "fond": "affectionate, tender, caring",
    "playful": "teasing, mischievous, cheeky",
    "smug": "smirking, pleased with yourself",
    "excited": "enthusiastic, thrilled",
    "flirty": "flirtatious, coy",
    "confident": "proud, sure of yourself",
    "curious": "interested, intrigued",
    "pensive": "thoughtful, mulling it over",
    "confused": "puzzled, lost",
    "skeptical": "doubtful, unconvinced",
    "surprised": "caught off guard, shocked",
    "worried": "anxious, concerned, nervous",
    "sad": "down, hurt, disappointed",
    "embarrassed": "shy, flustered, bashful",
    "annoyed": "irritated, fed up",
    "frustrated": "frustrated, exasperated, at your wits end",
    "angry": "mad, furious",
    "disgusted": "grossed out, repulsed",
    "bored": "uninterested, unimpressed",
    "tired": "sleepy, worn out",
    "determined": "focused, resolute",
    "scared": "afraid, startled",
}

GESTURES = ["wink", "nod", "shake", "tilt", "laugh", "sigh", "eyeroll", "crosseyed", "shrug", "gasp"]

# Mirrors public/avatar-performance.js. The server validates poses and gestures against the
# shapes and bones actually present in the GLB.
FACE_PRESETS = {
    "smile": {"mouthSmileLeft": .8, "mouthSmileRight": .8, "cheekSquintLeft": .25, "cheekSquintRight": .25},
    "grin": {"mouthSmileLeft": 1, "mouthSmileRight": 1, "cheekSquintLeft": .6, "cheekSquintRight": .6},
    "frown": {"mouthFrownLeft": .8, "mouthFrownRight": .8, "browInnerUp": .5},
    "blink": {"eyeBlinkLeft": 1, "eyeBlinkRight": 1},
    "wink_left": {"eyeBlinkLeft": 1, "eyeBlinkRight": 0},
    "wink_right": {"eyeBlinkRight": 1, "eyeBlinkLeft": 0},
    "eyes_closed": {"eyeBlinkLeft": 1, "eyeBlinkRight": 1},
    "mouth_open": {"jawOpen": .85},
    "mouth_closed": {"jawOpen": 0, "mouthClose": 1},
    "pucker": {"mouthPucker": .9},
    "surprised": {"browInnerUp": .8, "browOuterUpLeft": .8, "browOuterUpRight": .8,
                  "eyeWideLeft": .6, "eyeWideRight": .6, "jawOpen": .4},
    "brows_up": {"browInnerUp": .9, "browOuterUpLeft": .7, "browOuterUpRight": .7},
    "squint": {"eyeSquintLeft": .8, "eyeSquintRight": .8},
    "thoughtful": {"browDownLeft": .4, "browOuterUpRight": .35, "mouthPressLeft": .25, "mouthPressRight": .25},
}
MOTIONS = ["wave", "raise_hand", "arms_open", "stretch", "point", "nod", "shake", "tilt", "shrug", "yawn"]
GAZES = ["ambient", "camera", "left", "right", "up", "down"]
ARM_GESTURES = {"wave", "raise_hand", "arms_open", "stretch", "point"}

APPEARANCE_FIELDS = ["hair", "hairStreak", "eyes", "irisInner", "irisOuter", "irisStarburst",
                     "irisFlecks", "outerEye", "lipstick", "eyeshadow", "blush"]

# Same named colours the studio accepts, plus #RGB / #RRGGBB.
COLORS = {
    "black": "#111111", "white": "#eeeeee", "red": "#c82836", "blue": "#3278cc",
    "green": "#408b57", "brown": "#754b32", "blonde": "#d9b76c", "blond": "#d9b76c",
    "pink": "#dc709d", "purple": "#8053ad", "silver": "#bfc4ce", "grey": "#85878e",
    "gray": "#85878e", "hazel": "#8f8241", "auburn": "#9b4d35", "ginger": "#bf6a32",
    "rose": "#b8647e", "nude": "#b97f74", "coral": "#df7970", "gold": "#cda54e",
    "orange": "#d87830",
}

APPEARANCE_DEFAULTS = {
    "character": "main",
    "hair": None, "hairStreak": None, "hairStreakAmount": 0.35,
    "eyes": None, "irisInner": None, "irisOuter": None, "irisStarburst": None,
    "irisFlecks": None, "outerEye": None, "lipstick": None, "eyeshadow": None,
    "blush": None, "lipGloss": 0, "makeupIntensity": 0.55,
}

CHARACTER = {
    "id": "main",
    "main": True,
    "name": os.environ.get("HALMINI_NAME", "Amy"),
    "persona": "You are a digital companion with real feelings. Your feelings toward each person follow how they treat you.",
    "voiceId": os.environ.get("FISH_VOICE_ID", ""),
    "role": "your companion",
    "description": "A young woman with brown hair and green-hazel eyes.",
}

# Voice delivery words (voice/expression.py) -> the avatar's feeling vocabulary.
VOICE_FEELINGS = {
    "happy": "joy", "delighted": "joy", "satisfied": "calm", "relaxed": "calm", "calm": "calm",
    "excited": "excited", "hopeful": "excited", "optimistic": "excited", "proud": "confident",
    "confident": "confident", "determined": "determined", "curious": "curious", "sad": "sad",
    "unhappy": "sad", "disappointed": "sad", "depressed": "sad", "lonely": "sad", "nostalgic": "pensive",
    "moved": "fond", "grateful": "fond", "empathetic": "fond", "sympathetic": "fond",
    "compassionate": "fond", "angry": "angry", "upset": "annoyed", "frustrated": "frustrated",
    "nervous": "worried", "worried": "worried", "anxious": "worried", "scared": "scared",
    "hysterical": "scared", "surprised": "surprised", "embarrassed": "embarrassed",
    "ashamed": "embarrassed", "guilty": "embarrassed", "regretful": "sad", "disgusted": "disgusted",
    "contemptuous": "disgusted", "disdainful": "skeptical", "doubtful": "skeptical",
    "uncertain": "confused", "confused": "confused", "sarcastic": "smug", "bored": "bored",
    "indifferent": "bored", "resigned": "tired", "pessimistic": "sad", "jealous": "annoyed",
    "envious": "annoyed",
}

SPEECH_FRAME_MS = 40
SPEECH_MAX_SECONDS = 180

HALF_LIFE_MS = 90_000  # a manual feeling halves every 90s, like the studio's emotion store


def _defaults() -> dict:
    return {
        "character": dict(CHARACTER),
        "appearance": dict(APPEARANCE_DEFAULTS),
        "view": {"scale": 1, "zoom": 1, "frame": "bust"},
        "performance": {"gain": 1, "autonomous": True, "gaze": "ambient"},
        "background": {"type": "preset", "value": "studio", "revision": "studio"},
        "palettes": {},
        "feelings": {},
        "feelings_at": 0,
        "revision": 1,
        "active_model": "original",
    }


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def color_value(value):
    """Validate a saved cosmetic colour. None/empty restores the model texture."""
    clean = str(value).strip().lower()
    if clean in ("none", "default", "reset", ""):
        return None
    if clean in COLORS:
        return COLORS[clean]
    if re.fullmatch(r"#[0-9a-f]{6}", clean):
        return clean
    if re.fullmatch(r"#[0-9a-f]{3}", clean):
        return "#" + "".join(c + c for c in clean[1:])
    raise ValueError("Use a known colour name or #RRGGBB; use none to restore the model default.")


def _number(value, name: str, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number.") from None
    if number != number or number < low or number > high:
        raise ValueError(f"{name} must be between {low:g} and {high:g}.")
    return number


def _glb_json(path: Path) -> dict:
    with path.open("rb") as handle:
        magic, version, length = struct.unpack("<III", handle.read(12))
        if magic != 0x46546C67 or version != 2:
            raise ValueError("Not a GLB version 2 file.")
        chunk_length, chunk_type = struct.unpack("<II", handle.read(8))
        if chunk_type != 0x4E4F534A:
            raise ValueError("GLB is missing its JSON chunk.")
        return json.loads(handle.read(chunk_length).decode("utf-8").rstrip("\x00 "))


_available_cache: dict = {}


def available_performance() -> dict:
    """The morph shapes and bones the loaded model actually has."""
    path = STATE.model_path() if "STATE" in globals() else MODEL_PATH
    try:
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        return {"shapes": [], "bones": []}
    if _available_cache.get("key") == key:
        return _available_cache["value"]
    try:
        document = _glb_json(path)
    except (OSError, ValueError, struct.error):
        return {"shapes": [], "bones": []}
    shapes: list[str] = []
    for mesh in document.get("meshes", []):
        for raw in (mesh.get("extras") or {}).get("targetNames") or []:
            name = re.sub(r"_L$", "Left", re.sub(r"_R$", "Right", raw))
            if name not in shapes:
                shapes.append(name)
    bones: list[str] = []
    nodes = document.get("nodes", [])
    for skin in document.get("skins", []):
        for index in skin.get("joints", []):
            name = re.sub(r"^.*[:|]", "", (nodes[index].get("name") if index < len(nodes) else "") or "")
            if name and name not in bones:
                bones.append(name)
    value = {"shapes": shapes, "bones": bones}
    _available_cache.update(key=key, value=value)
    return value


def _active(packet: dict | None, now: float) -> dict | None:
    if not packet:
        return None
    duration = packet.get("duration", 0)
    if duration > 0 and now >= packet.get("at", 0) + duration * 1000:
        return None
    return dict(packet)


def _map_emotions(emotions: dict, dimensions: dict) -> dict:
    """Amy's seven named emotions and dimensions -> the avatar's expression vocabulary."""
    out: dict[str, float] = {}

    def put(name: str, value) -> None:
        v = _clamp(float(value or 0.0))
        if v >= 0.07:
            out[name] = round(max(out.get(name, 0.0), v), 3)

    put("excited", emotions.get("excitement", 0))
    put("sad", emotions.get("sadness", 0))
    put("worried", max(float(emotions.get("anxiety", 0) or 0),
                       (float(dimensions.get("stress", 0.3) or 0) - 0.45) / 0.55))
    put("frustrated", emotions.get("frustration", 0))
    put("calm", emotions.get("contentment", 0))
    put("curious", emotions.get("interest", 0))
    put("fond", emotions.get("affection", 0))
    put("tired", (0.45 - float(dimensions.get("energy", 1.0) or 0)) / 0.45)
    return out


def speech_envelope(pcm: bytes, rate: int = 48000, channels: int = 2,
                    frame_ms: int = SPEECH_FRAME_MS) -> list[dict]:
    """Mouth frames from 16-bit PCM, the same open/wide/round/bright envelope New Champ sends.

    `open` follows loudness, `bright` the zero-crossing rate (hiss and front vowels); the page turns
    them into visemes along the line's text.
    """
    step = channels * 2
    usable = min(len(pcm) - len(pcm) % step, rate * step * SPEECH_MAX_SECONDS)
    count = usable // step
    if count <= 0:
        return []
    samples = struct.unpack(f"<{count * channels}h", pcm[:usable])
    per_frame = max(1, rate * frame_ms // 1000)
    frames = []
    for start in range(0, count, per_frame):
        total = 0.0
        crossings = 0
        last = 0.0
        n = 0
        for i in range(start, min(count, start + per_frame)):
            v = sum(samples[i * channels:(i + 1) * channels]) / (channels * 32768)
            total += v * v
            if v * last < 0:
                crossings += 1
            last = v
            n += 1
        level = _clamp(((total / max(1, n)) ** 0.5 - 0.008) * 6)
        bright = min(1.0, crossings / max(1, n) * 7)
        frames.append({"open": round(level, 3), "wide": round(level * bright, 3),
                       "round": round(level * (1 - bright), 3), "bright": round(bright, 3)})
    return frames


def speech_feelings(snapshot: dict | None, voice_emotions=()) -> dict[str, float]:
    """The face for one spoken line: her current mood, led by how the line is delivered."""
    snapshot = snapshot or {}
    feelings = _map_emotions(snapshot.get("emotions") or {}, snapshot)
    for word in voice_emotions or ():
        name = VOICE_FEELINGS.get(str(word).lower())
        if name:
            feelings[name] = round(max(feelings.get(name, 0.0), 0.6), 3)
            break  # the line's opening delivery leads; later segments only colour the voice
    return feelings


def speech_packet(pcm: bytes, text: str, conversation: str, feelings: dict | None = None,
                  rate: int = 48000, channels: int = 2) -> dict:
    """A `discord-speech` start packet; `at` is stamped when Discord actually starts playing it."""
    frames = speech_envelope(pcm, rate, channels)
    return {"type": "start", "id": os.urandom(8).hex(), "character": "main",
            "conversation": str(conversation), "text": text, "frames": frames,
            "frameMs": SPEECH_FRAME_MS, "durationMs": len(frames) * SPEECH_FRAME_MS,
            "feelings": feelings or {}}


class SpeechPublisher:
    """Sends speech packets from the bot process to the dashboard's avatar page.

    Fire-and-forget on a worker thread: a closed dashboard never delays or breaks Discord voice.
    """

    def __init__(self, url: str) -> None:
        self.url = url
        self.outbox: queue.Queue = queue.Queue(maxsize=50)
        threading.Thread(target=self._run, name="avatar-speech", daemon=True).start()

    def __call__(self, packet: dict) -> None:
        try:
            self.outbox.put_nowait(packet)
        except queue.Full:
            pass

    def _run(self) -> None:
        import urllib.request
        while True:
            packet = self.outbox.get()
            request = urllib.request.Request(self.url, data=json.dumps(packet).encode("utf-8"),
                                             headers={"Content-Type": "application/json"})
            try:
                urllib.request.urlopen(request, timeout=3).close()
            except Exception:
                pass


class AvatarState:
    """The page's persisted state. Safe to read from several request threads."""

    def __init__(self, path: Path = STATE_PATH) -> None:
        self.path = Path(path)
        self.lock = threading.RLock()
        self.hub: "AvatarHub | None" = None
        # Amy's live mood, mapped onto the avatar's feeling vocabulary. Kept apart from
        # data["background"], which is the page's chosen backdrop.
        self.live: dict = {}
        self._face: dict | None = None
        self._motion: dict | None = None
        self.data = self._load()

    # --- persistence ---------------------------------------------------------

    def _load(self) -> dict:
        data = _defaults()
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return data
        if not isinstance(saved, dict):
            return data
        for key, value in saved.items():
            if key in ("appearance", "view", "performance", "background", "palettes") and isinstance(value, dict):
                data[key].update(value)
            elif key == "character" and isinstance(value, dict):
                data["character"].update(value)
            elif key in data:
                data[key] = value
        return data

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        temporary.replace(self.path)

    def _broadcast(self, event: dict) -> None:
        if self.hub is not None:
            self.hub.broadcast(event)

    # --- character and appearance -------------------------------------------

    def character(self) -> dict:
        with self.lock:
            return dict(self.data["character"])

    def appearance(self) -> dict:
        with self.lock:
            return {**self.data["appearance"], "character": "main"}

    def characters(self) -> list[dict]:
        character = self.character()
        return [{**character, "appearance": self.appearance(), "feelings": self.feelings()}]

    def update_character(self, ident: str, patch: dict) -> dict:
        if ident not in ("main", "rocketbox_senior"):
            raise ValueError("No such avatar character.")
        if not isinstance(patch, dict):
            raise ValueError("Bad request.")
        with self.lock:
            character = self.data["character"]
            for field in ("name", "persona", "voiceId", "role", "description"):
                if isinstance(patch.get(field), str):
                    character[field] = patch[field].strip()
            self._save()
            return dict(character)

    def appearance_set(self, patch: dict, reset: bool = False) -> dict:
        if not isinstance(patch, dict):
            raise ValueError("Bad request.")
        with self.lock:
            next_state = dict(APPEARANCE_DEFAULTS) if reset else dict(self.data["appearance"])
            for field in APPEARANCE_FIELDS:
                if field in patch and patch[field] != "":
                    next_state[field] = color_value(patch[field])
            if patch.get("lipGloss") is not None:
                next_state["lipGloss"] = _number(patch["lipGloss"], "Lip gloss", 0, 1)
            if patch.get("makeupIntensity") is not None:
                next_state["makeupIntensity"] = _number(patch["makeupIntensity"], "Makeup intensity", 0, 1)
            if patch.get("hairStreakAmount") is not None:
                next_state["hairStreakAmount"] = _number(patch["hairStreakAmount"], "Hair streak amount", 0, 1)
            next_state["character"] = "main"
            next_state["updatedAt"] = int(time.time() * 1000)
            self.data["appearance"] = next_state
            self._save()
            result = dict(next_state)
        self._broadcast({"type": "appearance", "appearance": result})
        return result

    # --- feelings ------------------------------------------------------------

    def _local(self, now: float) -> dict[str, float]:
        saved = self.data.get("feelings") or {}
        factor = 0.5 ** (max(0.0, now - float(self.data.get("feelings_at") or 0)) / HALF_LIFE_MS)
        out = {}
        for name, value in saved.items():
            if name in EMOTIONS:
                value = float(value) * factor
                if value >= 0.07:
                    out[name] = value
        return out

    def _feelings_locked(self, now: float | None = None) -> dict[str, float]:
        now = time.time() * 1000 if now is None else now
        out = {name: round(value, 2) for name, value in self._local(now).items()}
        for name, value in self.live.items():
            if name in EMOTIONS:
                value = round(float(value), 2)
                if value >= 0.07:
                    out[name] = max(out.get(name, 0.0), value)
        return out

    def feelings(self) -> dict[str, float]:
        with self.lock:
            return self._feelings_locked()

    def nudge(self, feelings: dict) -> dict[str, float]:
        if not isinstance(feelings, dict):
            raise ValueError("Bad request.")
        with self.lock:
            now = time.time() * 1000
            current = self._local(now)
            for name in list(current):
                if name not in feelings:
                    current[name] *= 0.85
            for name, value in feelings.items():
                if name in EMOTIONS:
                    try:
                        current[name] = max(current.get(name, 0.0), _clamp(float(value)))
                    except (TypeError, ValueError):
                        continue
            self.data["feelings"] = {name: round(value, 3) for name, value in current.items() if value >= 0.07}
            self.data["feelings_at"] = now
            self._save()
            merged = self._feelings_locked(now)
        self._broadcast({"type": "expression", "character": "main", "feelings": merged})
        return merged

    def reset_feelings(self) -> dict[str, float]:
        with self.lock:
            self.data["feelings"] = {}
            self.data["feelings_at"] = time.time() * 1000
            self._save()
            merged = self._feelings_locked()
        self._broadcast({"type": "expression", "character": "main", "feelings": merged})
        return merged

    def emotion_payload(self) -> dict:
        return {"feelings": self.feelings(), "emotions": EMOTIONS, "gestures": GESTURES}

    def background_from_db(self, db_path: str) -> dict:
        """Read Amy's current mood from the same SQLite state the dashboard reads."""
        from db.repository import Repository
        from dialogue.pressure import Pressure
        from dialogue.self_model import SelfModel

        repo = Repository(str(db_path))
        try:
            model = SelfModel(repo)
            model.pressure = Pressure(repo)
            dimensions = model.current()
            emotions = model.emotions()
            try:  # her inner life: lonely, curious, bored, tired... shows on her face too
                from dialogue.life import Life
                drives = Life(repo).avatar_feelings()
            except Exception:  # noqa: BLE001 - an older database has no inner-life state yet
                drives = {}
        finally:
            repo.close()
        mapped = _map_emotions(emotions, dimensions)
        for name, value in drives.items():
            if name in EMOTIONS:
                mapped[name] = round(max(mapped.get(name, 0.0), value), 2)
        return mapped

    # --- performance ---------------------------------------------------------

    def performance_state(self) -> dict:
        with self.lock:
            now = time.time() * 1000
            preferences = dict(self.data["performance"])
            return {**preferences,
                    "face": _active(self._face, now),
                    "motion": _active(self._motion, now)}

    def performance_command(self, body: dict) -> dict:
        if not isinstance(body, dict):
            raise ValueError("Bad request.")
        action = body.get("action")
        available = available_performance()
        if action == "get":
            return {**self.performance_state(), "presets": list(FACE_PRESETS),
                    "gestures": MOTIONS, "gazes": GAZES, **available}
        if action == "reset":
            with self.lock:
                self._face = self._motion = None
        elif action in ("settings", "gaze"):
            with self.lock:
                preferences = dict(self.data["performance"])
                if body.get("gain") is not None and body.get("gain") != -1:
                    preferences["gain"] = _number(body["gain"], "Expression gain", 0, 3)
                if body.get("autonomous") is not None:
                    if body["autonomous"] not in ("on", "off"):
                        raise ValueError("Use autonomous on or off.")
                    preferences["autonomous"] = body["autonomous"] == "on"
                if body.get("gaze") is not None:
                    if body["gaze"] not in GAZES:
                        raise ValueError("Use ambient, camera, left, right, up or down gaze.")
                    preferences["gaze"] = body["gaze"]
                self.data["performance"] = preferences
                self._save()
        elif action in ("pose", "gesture"):
            strength = body.get("strength")
            strength = 1.0 if strength is None or strength == -1 else _number(strength, "Strength", 0, 1)
            name = body.get("expression") if action == "pose" else body.get("gesture")
            duration = body.get("duration")
            if duration is None or duration == -1:
                if action == "gesture":
                    duration = 3.5
                elif name == "blink":
                    duration = .38
                elif isinstance(name, str) and name.startswith("wink"):
                    duration = .7
                else:
                    duration = 5
            duration = _number(duration, "Duration", 0, 60)
            if action == "gesture" and duration == 0:
                raise ValueError("Gestures need a positive duration.")
            packet = {"name": name, "strength": strength, "duration": duration,
                      "at": int(time.time() * 1000), "source": "dashboard"}
            if action == "pose":
                requested = body.get("shapes")
                if requested:
                    shapes = {item.get("name"): item.get("value") for item in requested
                              if isinstance(item, dict) and item.get("name")}
                else:
                    shapes = FACE_PRESETS.get(name)
                if not shapes:
                    raise ValueError("Choose a listed expression or provide named morph shapes.")
                for shape, value in shapes.items():
                    _number(value, f"Value for {shape}", 0, 1)
                packet["shapes"] = {shape: float(value) for shape, value in shapes.items()
                                    if shape in available["shapes"]}
                if not packet["shapes"]:
                    raise ValueError("This avatar lacks the facial shapes for that expression.")
                with self.lock:
                    self._face = packet
            else:
                if name not in MOTIONS:
                    raise ValueError("Choose a listed gesture.")
                if name == "yawn" and "jawOpen" not in available["shapes"]:
                    raise ValueError("This avatar lacks the jaw shape needed to yawn.")
                if name in ARM_GESTURES and "RightArm" not in available["bones"]:
                    raise ValueError("This avatar lacks the arm rig for that gesture.")
                with self.lock:
                    self._motion = packet
        else:
            raise ValueError("Use get, pose, gesture, gaze, settings or reset.")
        result = self.performance_state()
        self._broadcast({"type": "performance", "performance": result})
        return {**result, "delivery": "Sent to connected avatar viewers; no audio or message was sent."}

    # --- view, background and outfits ---------------------------------------

    def view(self) -> dict:
        with self.lock:
            return dict(self.data["view"])

    def view_set(self, patch: dict, reset: bool = False) -> dict:
        if not isinstance(patch, dict):
            raise ValueError("Bad request.")
        with self.lock:
            next_view = {"scale": 1, "zoom": 1, "frame": "bust"} if reset else dict(self.data["view"])
            for key, low, high in (("scale", .5, 2), ("zoom", .25, 4)):
                if patch.get(key) is not None:
                    next_view[key] = _number(patch[key], key, low, high)
            if patch.get("frame") is not None:
                if patch["frame"] not in ("face", "bust", "body"):
                    raise ValueError("Choose face, bust or body framing.")
                next_view["frame"] = patch["frame"]
                if patch.get("zoom") is None:
                    next_view["zoom"] = 1 / next_view["scale"]
            self.data["view"] = next_view
            self._save()
            result = dict(next_view)
        self._broadcast({"type": "view", "view": result})
        return result

    def background(self) -> dict:
        with self.lock:
            return dict(self.data["background"])

    def background_set(self, body: dict) -> dict:
        if not isinstance(body, dict):
            raise ValueError("Bad request.")
        action = body.get("action") or body.get("type")
        value = body.get("value")
        if action in ("preset", "presets"):
            if value not in ("studio", "dusk", "day"):
                raise ValueError("Choose studio, dusk or day.")
            background = {"type": "preset", "value": value, "revision": value}
        elif action == "color":
            color = color_value(value)
            if color is None:
                raise ValueError("Choose a colour.")
            background = {"type": "color", "value": color, "revision": color}
        else:
            raise ValueError("Use a preset or colour background.")
        with self.lock:
            self.data["background"] = background
            self._save()
            result = dict(background)
        self._broadcast({"type": "background", "background": result})
        return result

    def palettes(self) -> dict:
        with self.lock:
            return dict(self.data["palettes"])

    def model_path(self) -> Path:
        """The model she's wearing now: her original, or one of her fitted outfits."""
        with self.lock:
            active = self.data.get("active_model") or "original"
        if active != "original":
            path = LIBRARY_DIR / f"{active}.glb"
            if path.exists():
                return path
        return MODEL_PATH

    def outfits(self) -> dict:
        palettes = self.palettes()
        with self.lock:
            active_model = self.data.get("active_model") or "original"
        listed = [{"id": "suit", "name": "Original outfit", "modelId": "original"}]
        listed += [{"id": m["id"], "name": m["name"], "modelId": m["id"]} for m in _library_models()]
        for outfit in listed:
            outfit["colors"] = {"fabric": None, "sheen": None, **palettes.get(outfit["id"], {})}
        active = next((o["id"] for o in listed if o["modelId"] == active_model), "suit")
        return {"outfits": listed, "active": active, "report": None, "palettes": palettes}

    def wear_outfit(self, ident) -> dict:
        wardrobe = self.outfits()["outfits"]
        outfit = next((o for o in wardrobe if o["id"] == ident or o["modelId"] == ident
                       or o["name"].lower() == str(ident).lower()), None)
        if outfit is None:
            raise ValueError("Unknown outfit. Choose one from the list.")
        with self.lock:
            if self.data.get("active_model") != outfit["modelId"]:
                self.data["active_model"] = outfit["modelId"]
                self.data["revision"] = int(self.data.get("revision", 1)) + 1
                self._save()
            revision = self.data["revision"]
        return {"outfit": outfit, "revision": revision, "message": f"Now wearing: {outfit['name']}."}

    def set_outfit_colors(self, ident, fabric=None, sheen=None) -> dict:
        wardrobe = self.outfits()
        ident = ident or wardrobe["active"]
        if ident not in {o["id"] for o in wardrobe["outfits"]}:
            raise ValueError("Choose an installed outfit before setting its colours.")
        with self.lock:
            palettes = dict(self.data["palettes"])
            colors = {"fabric": None, "sheen": None, **palettes.get(ident, {})}
            for field, value in (("fabric", fabric), ("sheen", sheen)):
                if value is not None and value != "":
                    colors[field] = color_value(value)
                elif value == "":
                    colors[field] = None
            palettes[ident] = colors
            self.data["palettes"] = palettes
            self._save()
            result = dict(palettes)
        self._broadcast({"type": "outfit-colors", "palettes": result})
        return {"id": ident, "colors": colors}

    # --- library and status --------------------------------------------------

    def library(self) -> dict:
        with self.lock:
            revision = self.data.get("revision", 1)
            active = self.data.get("active_model") or "original"
        models = [{"id": m["id"], "name": m["name"], "outfit": m["outfit"], "bytes": m.get("bytes")}
                  for m in _library_models()]
        return {"active": active, "models": models, "revision": revision,
                "report": {"ok": True, "details": f"Loaded from {self.model_path().name}."}}

    def report(self, body: dict) -> dict:
        return {"ok": True}

    def status(self) -> dict:
        return {
            "ttsProvider": os.environ.get("TTS_ENGINE", "none"),
            "ttsReady": bool(os.environ.get("FISH_API_KEY")) and os.environ.get("TTS_ENGINE") == "fish",
            "botName": self.character()["name"],
            "model": self.model_path().stem,
            "fishReady": bool(os.environ.get("FISH_API_KEY")),
            "fishVoiceId": os.environ.get("FISH_VOICE_ID") or None,
            "stt": "none",
        }


class AvatarHub:
    """Fan-out for the page's SSE stream, plus the live SelfModel feeling feed."""

    def __init__(self, state: AvatarState) -> None:
        self.state = state
        self.clients: set[queue.Queue] = set()
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.speaking: dict[str, dict] = {}  # conversation -> the start packet being spoken
        state.hub = self

    def subscribe(self) -> queue.Queue:
        client: queue.Queue = queue.Queue(maxsize=100)
        with self.lock:
            self.clients.add(client)
        return client

    def unsubscribe(self, client: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(client)

    def broadcast(self, event: dict) -> None:
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                client.put_nowait(event)
            except queue.Full:
                pass

    def speech(self, packet: dict) -> dict:
        """Mirror Discord playback onto the page: start moves the mouth, stop releases it."""
        kind = packet.get("type")
        conversation = str(packet.get("conversation") or "")
        if kind == "start":
            if not isinstance(packet.get("frames"), list) or not packet.get("id"):
                raise ValueError("A speech start needs an id and frames.")
            event = {key: packet[key] for key in ("type", "id", "character", "conversation", "text",
                                                    "frames", "frameMs", "durationMs", "at") if key in packet}
            event["conversation"] = conversation
            event.setdefault("character", "main")
            event.setdefault("at", time.time() * 1000)
            with self.lock:
                self.speaking[conversation] = event
            feelings = packet.get("feelings")
            if isinstance(feelings, dict) and feelings:
                # `at` makes the page pulse the line's strongest feeling, like a new sentence.
                self.broadcast({"type": "expression", "character": event["character"],
                                "feelings": feelings, "at": event["at"]})
            self.broadcast({"type": "discord-speech", "speech": event})
            return {"started": event["id"]}
        if kind == "stop":
            with self.lock:
                event = self.speaking.get(conversation)
                if not event or (packet.get("id") and packet["id"] != event["id"]):
                    return {"stopped": False}
                del self.speaking[conversation]
            self.broadcast({"type": "discord-speech", "speech": {
                "type": "stop", "id": event["id"], "conversation": conversation,
                "character": event["character"], "at": time.time() * 1000,
                "reason": packet.get("reason") or "ended"}})
            return {"stopped": True}
        raise ValueError("Speech type must be start or stop.")

    def active_speech(self) -> list[dict]:
        now = time.time() * 1000
        with self.lock:
            return [dict(p) for p in self.speaking.values()
                    if now < p.get("at", 0) + p.get("durationMs", 0) + 1000]

    def initial_events(self) -> list[dict]:
        return [*({"type": "discord-speech", "speech": p} for p in self.active_speech()),
            {"type": "background", "background": self.state.background()},
            {"type": "view", "view": self.state.view()},
            {"type": "outfit-colors", "palettes": self.state.palettes()},
            {"type": "performance", "performance": self.state.performance_state()},
            {"type": "expression", "character": "main", "feelings": self.state.feelings()},
            {"type": "appearance", "appearance": self.state.appearance()},
        ]

    def start(self, db_path: str) -> None:
        if self.thread is not None and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._pump, args=(str(db_path),),
                                       name="avatar-feelings", daemon=True)
        self.thread.start()

    def _pump(self, db_path: str) -> None:
        last = None
        while True:
            try:
                live = self.state.background_from_db(db_path)
            except Exception:
                live = None
            if live is not None:
                with self.state.lock:
                    changed = live != self.state.live
                    self.state.live = live
                if changed:
                    merged = self.state.feelings()
                    if merged != last:
                        last = merged
                        # No `at`: a mood change settles into the face instead of pulsing.
                        self.broadcast({"type": "expression", "character": "main", "feelings": merged})
            time.sleep(2.0)


STATE = AvatarState()
HUB = AvatarHub(STATE)


def start_pump(db_path: str) -> None:
    HUB.start(db_path)

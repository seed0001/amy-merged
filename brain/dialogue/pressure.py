"""Pressure buckets: small wants that build and ease from conversation and from time passing.

Ported from the `new champ` pressure system (src/pressure.js) to Amy's symbolic engine. Each bucket
is a number from 0 to 1. A condition fills it, silence or the absence of the condition lets it decay,
and crossing a threshold makes it want something. Acting on a want drains that bucket and seeds the
next one, so one want leads to the next. Loneliness is kept per person.

Nothing here calls a language model or sends a message. Ticks are plain arithmetic. This Amy build
runs with `actions_live` off: a fired want is recorded and colours her state, but she doesn't reach
out on her own. The want is read back through `SelfModel.biases()` (curiosity, sociability, stress),
`Curiosity.follow_up()`, `SelfModel.expression()` (tone) and the voice snapshot.

State lives in the repository's `self_state` table under the key `pressure`, so an in-memory test
database starts clean and a real database keeps Amy's state across restarts.
"""

import json
import re
import time

KEY = "pressure"

DEFAULTS = {
    "enabled": True,
    "actions_live": False,          # false: a fired want is logged and felt, never acted on
    "tick_seconds": 60,
    "max_catch_up_hours": 3,        # after downtime, at most this much quiet time counts
    "global_cap": 3.5,
    "quiet_clamp_minutes": 120,     # after "back off" / "be quiet"
    "quiet_clamp_max": 0.2,
    "idle_minutes": 10,             # no message for this long counts as silence
    "stale_hours": 2,               # an open question this old starts to make her uneasy
    "reraise_hours": 12,            # once raised, it doesn't make her uneasy again for this long
    "recent_name_minutes": 30,
    "loneliness_after_hours": 1,
    "buckets": {
        "boredom":      {"enabled": True, "fill_rate": 0.015, "decay_rate": 0.04,  "threshold": 0.65, "drain": 0.55, "hysteresis": 0.25},
        "curiosity":    {"enabled": True, "fill_rate": 0.0,   "decay_rate": 0.004, "threshold": 0.6,  "drain": 0.7,  "hysteresis": 0.2},
        "irritation":   {"enabled": True, "fill_rate": 0.0,   "decay_rate": 0.05,  "threshold": 0.5,  "drain": 0.5,  "hysteresis": 0.2},
        "restlessness": {"enabled": True, "fill_rate": 0.005, "decay_rate": 0.02,  "threshold": 0.65, "drain": 0.5,  "hysteresis": 0.25},
        "usefulness":   {"enabled": True, "fill_rate": 0.002, "decay_rate": 0.0,   "threshold": 0.7,  "drain": 0.45, "hysteresis": 0.25},
        "unease":       {"enabled": True, "fill_rate": 0.02,  "decay_rate": 0.02,  "threshold": 0.6,  "drain": 0.6,  "hysteresis": 0.2},
        "loneliness":   {"enabled": True, "fill_rate": 0.0015, "decay_rate": 0.0,  "threshold": 0.6,  "drain": 0.4,  "hysteresis": 0.25},
    },
    "signals": {
        "low_novelty": 0.06,      # boredom, when a message repeats recent ones
        "high_novelty": -0.12,    # boredom, when it's new ground
        "new_name": 0.08,         # curiosity, per unfamiliar name mentioned (max 3)
        "open_question": 0.12,    # curiosity, "we should look into", "I wonder", ...
        "irritant": 0.2,          # irritation, "say that again", "you're wrong", talked over...
        "real_request": -0.35,    # usefulness, someone asked for an actual answer or action
        "contact": -0.5,          # loneliness for the person who spoke
        "made_something": -0.4,   # restlessness, she made a file/song/image/project
    },
    "seeds": {
        "boredom":      {"curiosity": 0.1, "usefulness": 0.2},
        "curiosity":    {"usefulness": 0.15, "restlessness": 0.15},
        "restlessness": {"usefulness": 0.3},
        "usefulness":   {"boredom": 0.1},
        "loneliness":   {"boredom": -0.1, "usefulness": -0.1},
        "irritation":   {"unease": 0.1},
        "unease":       {"restlessness": 0.1},
    },
}

IRRITANT = re.compile(
    r"\b(say (that|it) again|repeat (that|it)|what did you say|are you (even )?listening|"
    r"you('re| are) wrong|that'?s (not right|wrong)|no,? that'?s not|you didn'?t|useless|stupid|wtf)\b",
    re.I)
QUIET = re.compile(
    r"\b(back off|be quiet|shut up|too much|chill( out)?|stop talking|leave me alone|calm down|"
    r"give it a rest)\b", re.I)
OPEN = re.compile(
    r"\b(look into|we should (check|find out|figure)|i wonder|no idea|figure (it|that) out|"
    r"what (is|are) (a |an |the )?\w+\?|who is \w+|how does \w+)", re.I)
REQUEST = re.compile(
    r"\b(?:can|could|would|will) you\b|\bplease\b|\bhelp me\b|\btell me\b|\bshow me\b|"
    r"\bexplain\b|\bwhat (?:is|are|does|do|did)\b|\bwho (?:is|are|was)\b|"
    r"\bwhere (?:is|are|does|did)\b|\bwhen (?:is|was|did)\b|\bwhy (?:is|are|does|do|did)\b|"
    r"\bhow (?:is|are|does|do|did)\b", re.I)

LABELS = {"boredom": "bored", "curiosity": "curious", "irritation": "irritated",
          "restlessness": "restless", "usefulness": "unneeded", "unease": "uneasy"}


def _clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def _merge(base, over):
    """Deep-merge an override over defaults, the way the JavaScript original did."""
    if not isinstance(over, dict):
        return over if over is not None else base
    out = dict(base) if isinstance(base, dict) else {}
    for key, value in over.items():
        out[key] = _merge(base[key], value) if isinstance(base, dict) and key in base else value
    return out


class Pressure:
    def __init__(self, repo, clock=time.time, config=None):
        self.repo = repo
        self.clock = clock
        self.config = _merge(DEFAULTS, config or {})
        self.state = self._load()

    # --- storage -------------------------------------------------------------------

    def _fresh(self):
        now = self.clock()
        return {
            "version": 1,
            "last_tick": now,
            "buckets": {"boredom": 0.2, "curiosity": 0.2, "irritation": 0.0,
                        "restlessness": 0.2, "usefulness": 0.2, "unease": 0.1},
            "loneliness": {},
            "armed": {},
            "last_action": None,
            "clamp_until": 0.0,
            "last_message": now,
            "last_made": now,
            "open_questions": [],
            "recent_names": [],
            "raised": {},
            "history": [],
        }

    def _load(self):
        try:
            row = self.repo.conn.execute(
                "SELECT value FROM self_state WHERE key = ?", (KEY,)).fetchone()
            saved = json.loads(row[0]) if row else {}
        except (ValueError, TypeError):
            saved = {}
        return _merge(self._fresh(), saved)

    def _save(self):
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO self_state(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
                (KEY, json.dumps(self.state)))

    # --- small helpers -------------------------------------------------------------

    @property
    def buckets(self):
        return self.state["buckets"]

    def _bucket_enabled(self, name):
        return bool(self.config["buckets"].get(name, {}).get("enabled"))

    def _bump(self, name, amount):
        if not self._bucket_enabled(name):
            return
        self.state["buckets"][name] = _clamp(self.state["buckets"].get(name, 0.0) + amount)

    def _quiet_cap(self):
        now = self.clock()
        if now >= self.state["clamp_until"]:
            return False
        cap = self.config["quiet_clamp_max"]
        changed = False
        for name in ("irritation",):
            if self.state["buckets"].get(name, 0.0) > cap:
                self.state["buckets"][name] = cap
                changed = True
        for person in self.state["loneliness"].values():
            if person.get("value", 0.0) > cap:
                person["value"] = cap
                changed = True
        return changed

    def loneliest(self):
        people = [dict(person, key=key) for key, person in self.state["loneliness"].items()]
        return max(people, key=lambda person: person.get("value", 0.0), default=None)

    def total(self):
        lone = self.loneliest()
        return sum(self.state["buckets"].values()) + (lone.get("value", 0.0) if lone else 0.0)

    # --- time ----------------------------------------------------------------------

    def _drift(self, now):
        cfg = self.config["buckets"]
        idle = now - self.state["last_message"] > self.config["idle_minutes"] * 60
        if cfg["boredom"]["enabled"]:
            rate = cfg["boredom"]["fill_rate"] if idle else -cfg["boredom"]["decay_rate"]
            self.state["buckets"]["boredom"] = _clamp(self.state["buckets"]["boredom"] + rate)
        if cfg["curiosity"]["enabled"]:
            open_questions = self.state.get("open_questions") or []
            rate = max(cfg["curiosity"]["fill_rate"], 0.015) if open_questions else -cfg["curiosity"]["decay_rate"]
            self.state["buckets"]["curiosity"] = _clamp(self.state["buckets"]["curiosity"] + rate)
        if cfg["irritation"]["enabled"]:
            self.state["buckets"]["irritation"] = _clamp(
                self.state["buckets"]["irritation"] - cfg["irritation"]["decay_rate"])
        if cfg["usefulness"]["enabled"]:
            self.state["buckets"]["usefulness"] = _clamp(
                self.state["buckets"]["usefulness"] + cfg["usefulness"]["fill_rate"])
        if cfg["restlessness"]["enabled"]:
            stale = (now - self.state["last_made"] > 30 * 60
                     and self.state["buckets"].get("usefulness", 0.0) > 0.4)
            rate = cfg["restlessness"]["fill_rate"] if stale else -cfg["restlessness"]["decay_rate"]
            self.state["buckets"]["restlessness"] = _clamp(
                self.state["buckets"]["restlessness"] + rate)
        if cfg["loneliness"]["enabled"]:
            for person in self.state["loneliness"].values():
                away = now - person.get("last_seen", now) > self.config["loneliness_after_hours"] * 3600
                if away:
                    person["value"] = _clamp(
                        person.get("value", 0.0) + cfg["loneliness"]["fill_rate"])

    def _stale_items(self, now):
        out = []
        raised = self.state.get("raised", {})
        for index, question in enumerate(self.state.get("open_questions", [])):
            asked_at = question.get("at", 0)
            if now - asked_at < self.config["stale_hours"] * 3600:
                continue
            if now - raised.get(str(index), 0) < self.config["reraise_hours"] * 3600:
                continue
            out.append(dict(question, index=index))
        return sorted(out, key=lambda item: item.get("at", 0))

    def _unease_target(self, now):
        stale = self._stale_items(now)
        return _clamp(0.4 + 0.2 * len(stale)) if stale else 0.0

    def tick(self, reason="timer"):
        if not self.config["enabled"]:
            return None
        now = self.clock()
        behind = max(0.0, min(now - self.state["last_tick"],
                              self.config["max_catch_up_hours"] * 3600))
        steps = int(behind // self.config["tick_seconds"])
        for index in range(steps, 0, -1):
            self._drift(now - (index - 1) * self.config["tick_seconds"])
        if steps:
            self.state["last_tick"] = now

        if self._bucket_enabled("unease"):
            target = self._unease_target(now)
            current = self.state["buckets"]["unease"]
            step = (self.config["buckets"]["unease"]["fill_rate"] if target > current
                    else self.config["buckets"]["unease"]["decay_rate"])
            if target != current:
                delta = max(-step, min(step, target - current))
                self.state["buckets"]["unease"] = _clamp(current + delta)
        self._quiet_cap()

        history = self.state.setdefault("history", [])
        if not history or now - history[-1].get("at", 0) >= 10 * 60:
            history.append({"at": now, "buckets": dict(self.state["buckets"])})
            del history[:-18]

        fired = self._evaluate(now)
        if reason != "timer" or steps or fired is not None:
            self._save()
        return fired

    # --- wants ---------------------------------------------------------------------

    def _eligible(self):
        out = []
        for name, settings in self.config["buckets"].items():
            if not settings.get("enabled") or name == "loneliness":
                continue
            value = self.state["buckets"].get(name, 0.0)
            if self.state["armed"].get(name) is False and value < settings["threshold"] - settings["hysteresis"]:
                self.state["armed"][name] = True
            if value >= settings["threshold"] and self.state["armed"].get(name) is not False:
                out.append({"key": name, "bucket": name, "value": value, "settings": settings})
        settings = self.config["buckets"]["loneliness"]
        if settings.get("enabled"):
            for key, person in self.state["loneliness"].items():
                armed_key = f"loneliness:{key}"
                value = person.get("value", 0.0)
                if self.state["armed"].get(armed_key) is False and value < settings["threshold"] - settings["hysteresis"]:
                    self.state["armed"][armed_key] = True
                if value >= settings["threshold"] and self.state["armed"].get(armed_key) is not False:
                    out.append({"key": armed_key, "bucket": "loneliness", "person": person.get("name"),
                                "id": key, "value": value, "settings": settings})
        return out

    def _evaluate(self, now):
        clamped = now < self.state["clamp_until"]
        choices = [choice for choice in self._eligible()
                   if not (clamped and choice["bucket"] in ("usefulness", "loneliness"))]
        if not choices:
            return None
        choice = max(choices, key=lambda item: item["value"] - item["settings"]["threshold"])
        settings = choice["settings"]

        if choice["bucket"] == "loneliness":
            person = self.state["loneliness"][choice["id"]]
            person["value"] = _clamp(person.get("value", 0.0) - settings["drain"])
        else:
            self._bump(choice["bucket"], -settings["drain"])
        for name, amount in self.config["seeds"].get(choice["bucket"], {}).items():
            self._bump(name, amount)
        self.state["armed"][choice["key"]] = False
        doing = "log"
        if self.config["actions_live"]:
            doing = ("research" if choice["bucket"] in ("boredom", "curiosity")
                     else "tone" if choice["bucket"] == "irritation" else "speak")
        action = {"bucket": choice["bucket"], "person": choice.get("person"), "at": now,
                  "doing": doing, "value": round(choice["value"], 2)}
        if choice["bucket"] == "unease":
            stale = self._stale_items(now)
            if stale:
                self.state["raised"][str(stale[0]["index"])] = now
                action["item"] = {"text": stale[0].get("text", ""), "at": stale[0].get("at")}
        self.state["last_action"] = action
        return action

    # --- conversation signals ------------------------------------------------------

    @staticmethod
    def _words(text):
        return set(re.findall(r"[a-z0-9']{3,}", str(text).lower()))

    @staticmethod
    def _jaccard(a, b):
        overlap = len(a & b)
        return overlap / (len(a | b) or 1)

    def hear(self, text, person_key=None, speaker_name=None, is_bot=False, known_names=(), made=False):
        """Apply the immediate signals in one message. Does not tick; see after_turn()."""
        if not self.config["enabled"]:
            return
        now = self.clock()
        text = str(text or "")
        self.state["last_message"] = now
        signals = self.config["signals"]

        # Boredom: repeated ground raises it, genuinely new wording lowers it.
        words = self._words(text)
        recent = self.state.setdefault("recent_words", [])
        if len(words) >= 3:
            similarity = max((self._jaccard(words, set(other)) for other in recent), default=0.0)
            if similarity > 0.45:
                self._bump("boredom", signals["low_novelty"])
            elif similarity < 0.15:
                self._bump("boredom", signals["high_novelty"])
            recent.append(sorted(words))
            del recent[:-20]

        # Unfamiliar names: capitalised words that aren't at a sentence start, aren't known by
        # the caller and don't already name something in memory.
        known = {str(name).lower() for name in known_names if name}
        if speaker_name:
            known.add(str(speaker_name).lower())
        names = []
        for match in re.finditer(r"\b([A-Z][a-z]{2,})\b", text):
            name = match.group(1)
            before = text[:match.start()]
            if not before.strip() or re.search(r"[.!?]\s*$", before):
                continue  # sentence opening, not a name
            if name.lower() in known:
                continue
            if self.repo.find_entity(name) is not None:
                continue
            names.append(name)
        names = list(dict.fromkeys(names))
        if names:
            self._bump("curiosity", signals["new_name"] * min(3, len(names)))
            by_name = {entry["name"].lower(): entry for entry in self.state.get("recent_names", [])}
            for name in names:
                by_name[name.lower()] = {"name": name, "at": now, "text": text[:200]}
            self.state["recent_names"] = sorted(by_name.values(), key=lambda item: item["at"])[-5:]

        if OPEN.search(text):
            self._bump("curiosity", signals["open_question"])
            questions = [question for question in self.state.get("open_questions", [])
                         if question.get("text") != text[:600]]
            questions.append({"text": text[:600], "at": now, "speaker": speaker_name})
            self.state["open_questions"] = questions[-10:]

        if IRRITANT.search(text):
            self._bump("irritation", signals["irritant"])
        if REQUEST.search(text) or text.rstrip().endswith("?"):
            self._bump("usefulness", signals["real_request"])
        if made:
            self._bump("restlessness", signals["made_something"])
            self.state["last_made"] = now

        if QUIET.search(text):
            self.state["clamp_until"] = now + self.config["quiet_clamp_minutes"] * 60
            self._quiet_cap()

        if person_key and not is_bot:
            person = self.state["loneliness"].setdefault(
                person_key, {"name": speaker_name or person_key, "value": 0.0, "last_seen": now})
            person["name"] = speaker_name or person.get("name") or person_key
            person["last_seen"] = now
            person["value"] = _clamp(person.get("value", 0.0) + signals["contact"])

    def after_turn(self, made=False):
        """Called once a reply is finished: one tick's worth of drift and one want at most."""
        if made:
            # Making something is its own reward; the signal is applied here as well as in hear().
            self._bump("restlessness", self.config["signals"]["made_something"])
        return self.tick("message")

    # --- what the rest of Amy reads -------------------------------------------------

    def biases(self):
        """Small shifts applied to SelfModel's derived dimensions, not a second mood system."""
        b = self.state["buckets"]
        lone = self.loneliest()
        lonely = lone.get("value", 0.0) if lone else 0.0
        return {
            "curiosity": round(0.18 * b.get("curiosity", 0) + 0.08 * b.get("boredom", 0)
                               - 0.10 * b.get("irritation", 0) - 0.06 * b.get("unease", 0), 3),
            "sociability": round(0.18 * lonely - 0.12 * b.get("irritation", 0)
                                 + 0.04 * b.get("usefulness", 0) - 0.04 * b.get("restlessness", 0), 3),
            "stress": round(0.15 * b.get("unease", 0) + 0.10 * b.get("irritation", 0)
                            + 0.05 * b.get("usefulness", 0) - 0.04 * b.get("restlessness", 0), 3),
        }

    def follow_up_bonus(self):
        """Added to the chance of asking a question back. Curiosity and boredom push it up; friction down."""
        b = self.state["buckets"]
        value = (0.10 * b.get("curiosity", 0) + 0.08 * b.get("boredom", 0)
                 - 0.18 * b.get("irritation", 0) - 0.08 * b.get("unease", 0))
        return round(_clamp(value, -0.2, 0.2), 3)

    def wants_to_ask(self):
        return self.state["buckets"].get("curiosity", 0) >= 0.6 or self.state["buckets"].get("boredom", 0) >= 0.7

    def shape_tone(self, tone):
        """Pressure never overrides a sensitive or sad tone; it only flattens an otherwise neutral one."""
        b = self.state["buckets"]
        if tone in ("gentle", "subdued"):
            return tone
        if b.get("irritation", 0) >= 0.55 or b.get("unease", 0) >= 0.65:
            return "measured"
        if b.get("curiosity", 0) >= 0.65 and tone == "neutral":
            return "warm"
        return tone

    def feelings(self):
        """Named background feelings, scaled down so a bucket at 1 is not a caricature."""
        b = self.state["buckets"]
        lone = self.loneliest()
        values = {
            "bored": b.get("boredom", 0) * 0.45,
            "curious": b.get("curiosity", 0) * 0.45,
            "annoyed": b.get("irritation", 0) * 0.45,
            "determined": b.get("restlessness", 0) * 0.4,
            "pensive": b.get("usefulness", 0) * 0.35,
            "worried": b.get("unease", 0) * 0.45,
            "sad": (lone.get("value", 0.0) if lone else 0.0) * 0.4,
        }
        return {name: round(value, 3) for name, value in values.items() if value >= 0.07}

    def mood_line(self, coach=False):
        """One inspectable line, for a future narrator or for !state. Not a script to recite."""
        b = self.state["buckets"]
        lone = self.loneliest()
        parts = [f"{LABELS[name]} {b.get(name, 0):.1f}" for name in LABELS]
        if lone and lone.get("value", 0) > 0.2:
            parts.append(f"missing {lone.get('name')} {lone['value']:.1f}")
        line = "Internal pressures (a mood, not a script): " + ", ".join(parts) + "."
        if coach:
            how = []
            if b.get("irritation", 0) > 0.5:
                how.append("keep replies shorter and flatter")
            if b.get("curiosity", 0) > 0.5:
                how.append("ask a real question back instead of only answering")
            if b.get("unease", 0) > 0.55:
                how.append("circle back on an open thread")
            if b.get("restlessness", 0) > 0.55:
                how.append("offer to make something")
            if how:
                line += " Let it show: " + "; ".join(how) + "."
        return line

    def mood(self):
        return self.feelings()

    def snapshot(self):
        return {
            "buckets": dict(self.state["buckets"]),
            "loneliness": {key: dict(value) for key, value in self.state["loneliness"].items()},
            "total": round(self.total(), 2),
            "cap": self.config["global_cap"],
            "last_action": self.state.get("last_action"),
            "clamp_until": self.state.get("clamp_until", 0),
            "actions_live": self.config["actions_live"],
            "biases": self.biases(),
            "feelings": self.feelings(),
            "mood_line": self.mood_line(),
            "history": list(self.state.get("history", [])),
            "open_questions": list(self.state.get("open_questions", [])),
            "recent_names": list(self.state.get("recent_names", [])),
        }

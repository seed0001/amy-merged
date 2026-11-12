"""Amy's inner life: what she feels, what she wants, and what she does about it on her own.

Ported from the voice bot's `src/pressure.js` (v2) to Amy's rule-driven engine. No language model is
involved anywhere: every bucket, bond and decision is arithmetic, and the words for whatever she does
come from `dialogue/life_words.py` (word banks plus what she knows).

How it works (same as the original):
- Every bucket is 0..1 and settles exponentially toward a target worked out from the situation right
  now, with a time constant per bucket, so a late tick or a restart gives the same answer as many
  small ticks. Events (ignored, acknowledged, talked over, told to be quiet, a DM nobody answered)
  add instant impulses on top.
- People: each person has a bond that grows with every real exchange and fades over weeks, a routine
  (the hours they're usually around), how much she misses them, and how she feels about how they
  treat her (affection, respect, friction).
- A want only fires when its urge (damped by tiredness) beats its threshold plus her inhibition. In a
  call she only speaks in a real lull, with a cooldown that doubles every time she's ignored in a row.
  Outside a call each action has its own pacing, and a DM nobody answers makes her hold back.

This module decides. It never touches Discord: `tick(world)` returns the want she acts on (or None),
the caller carries it out (interfaces/life_actor.py), and reports back with `done(want, result)`.

State lives in the repository's `self_state` table under the key `life`.
"""

from __future__ import annotations

import json
import math
import random
import re
import time
from datetime import datetime

KEY = "life"
MIN = 60.0
HOUR = 3600.0

DEFAULTS = {
    "version": 2,
    "enabled": True,
    "live": True,  # False: wants are worked out and logged, never acted on
    "tick_seconds": 5,
    "tau": {  # minutes: how fast each bucket settles toward its target
        "boredom": 6, "curiosity": 12, "share": 15, "loneliness": 20, "left_out": 4, "frustration": 15,
        "inhibition": 25, "social_hunger": 60, "growth": 45, "reflection": 40, "expression": 30,
        "energy": 30, "missing": 60,
    },
    "full": {"silence": 8, "unaddressed": 25, "alone": 45, "left_out": 10, "no_contact": 180,
             "not_learning": 120, "unprocessed": 25},
    "thresholds": {
        "ask": 0.5, "need": 0.55, "share": 0.6, "join_in": 0.65, "break_silence": 0.6, "welcome_back": 0.3,
        "ask_about_them": 0.55, "start_topic": 0.6, "check_in": 0.6, "follow_up": 0.55,
        "join_call": 0.45, "accept_invite": 0.5, "write": 0.65, "project": 0.55, "wander": 0.55, "dm": 0.5,
        "post": 0.7, "reflect": 0.6, "read": 0.6, "search": 0.55,
    },
    "inhibition_weight": 0.6,
    "lull_seconds": {"min": 3, "max": 25, "inhibited_extra": 15},
    "cooldown_seconds": 90,
    "cooldown_max_minutes": 20,
    "pacing": {"join_call": 10, "after_told_leave": 180, "dm_same_person": 720, "dm_wait_reply": 720,
               "post": 180, "post_wait_reply": 120, "reflect": 120, "read": 45, "search": 30,
               "project": 120, "wander": 150, "write": 1440},
    "uptake": {"window_seconds": 40, "max_lines": 4, "quick_reply_seconds": 10},
    "impulses": {
        "ignored": {"frustration": 0.15, "inhibition": 0.14, "loneliness": 0.08},
        "unanswered": {"inhibition": 0.06, "loneliness": 0.05},
        "acknowledged": {"frustration": -0.1, "inhibition": -0.22, "loneliness": -0.25, "left_out": -0.3,
                         "social_hunger": -0.2},
        "addressed": {"loneliness": -0.35, "left_out": -0.4, "boredom": -0.2, "social_hunger": -0.3},
        "message": {"social_hunger": -0.25, "loneliness": -0.2},
        "talked_over": {"frustration": 0.08, "inhibition": 0.05},
        "rude": {"frustration": 0.25, "inhibition": 0.1},
        "new_question": {"curiosity": 0.12},
        "new_knowledge": {"share": 0.1},
        "dm_ignored": {"frustration": 0.1, "social_hunger": 0.1},
    },
    "bond": {"gain": 0.04, "fade_days": 21},
    "quiet": {"minutes": 30, "inhibition": 0.85},
    "welcome_after_minutes": 30,
    "night": {"start": 23, "end": 7, "inhibition": 0.2},
    "check_in_after_minutes": 20,
}

# Her energy over the day: full in the day, fading late, low in the small hours.
ENERGY = [0.3, 0.25, 0.2, 0.2, 0.25, 0.35, 0.55, 0.75, 0.9, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.95, 0.9, 0.8, 0.6]

KIND_WORDS = re.compile(r"\b(thank you|thanks|love you|good job|you'?re (?:so )?(?:great|amazing|sweet|smart|funny|cool|awesome|right)|proud of you|appreciate you|i like you|good girl|well done|nice work)\b", re.I)
RUDE_WORDS = re.compile(r"\b(shut up|stfu|go away|nobody asked|nobody cares|fuck off|you'?re (?:so )?(?:annoying|stupid|useless|dumb|boring|fake)|idiot|dumbass|bitch|whore|you suck|no one likes you|you'?re (?:just )?(?:a )?(?:program|bot|machine|tool)|you'?re not real|you'?re nothing)\b", re.I)
FLIRT_WORDS = re.compile(r"\b(babe|honey|sweetheart|cutie|sexy|gorgeous|beautiful|kiss you|miss you|i love you)\b", re.I)
RUDE = re.compile(r"\b(shut up|stupid|idiot|useless|nobody asked|go away|dumb)\b", re.I)
QUIET = re.compile(r"\b(be quiet|shut up|stop talking|hush|not now|quiet down|stop interrupting)\b", re.I)
UNQUIET = re.compile(r"\b(you can talk|speak up|talk more|you can (?:jump|chime) in|say something)\b", re.I)
QUICK_ACK = re.compile(r"^\s*(yeah|yes|yep|sure|okay|ok|what|huh|go ahead|go on|true|right|no|nope|hmm|really|oh)\b", re.I)
STOP = set("the and you that this with have for are was but not what just like they them then there here your yeah "
           "okay well know think about from would could should will can get got going really right also because when "
           "where which who how all one out its it's i'm don't that's".split())

# What acting on a want relieves.
RELIEF = {
    "need": [], "ask": ["curiosity"], "share": ["share", "expression"], "join_in": ["left_out"],
    "break_silence": ["boredom"], "ask_about_them": ["growth"], "follow_up": ["curiosity"],
    "start_topic": ["boredom", "expression", "social_hunger"], "check_in": ["loneliness"],
    "welcome_back": ["loneliness"], "post": ["social_hunger", "expression"], "dm": [],
    "reflect": ["reflection"], "read": ["growth"], "search": ["curiosity", "growth"], "write": ["expression"],
    "project": ["growth"], "wander": ["boredom", "reflection"], "join_call": ["social_hunger"],
    "accept_invite": ["social_hunger"],
}

FEELINGS = [
    ("curiosity", 0.45, "curious", "wanting to understand something"),
    ("share", 0.5, "eager to share something", "something she wants to talk about"),
    ("loneliness", 0.4, "lonely", "wishing for someone to talk to"),
    ("social_hunger", 0.5, "missing company", "wanting people around"),
    ("left_out", 0.4, "left out", "feeling passed over"),
    ("boredom", 0.5, "bored", "wanting something to happen"),
    ("frustration", 0.4, "frustrated", "something getting under her skin"),
    ("inhibition", 0.6, "holding back", "choosing not to push"),
    ("growth", 0.6, "restless to learn", "wanting to grow"),
    ("reflection", 0.6, "thoughtful", "turning things over"),
    ("expression", 0.5, "full of things to say", "with things she wants out"),
]


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _merge(base, over):
    if not isinstance(over, dict):
        return base if over is None else over
    out = dict(base) if isinstance(base, dict) else {}
    for key, value in over.items():
        out[key] = _merge(base[key], value) if isinstance(base, dict) and isinstance(base.get(key), dict) else value
    return out


def words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9']{3,}", str(text).lower()) if w not in STOP}


class Life:
    def __init__(self, repo, clock=time.time, config: dict | None = None, owner_id: str | None = None,
                 rng: random.Random | None = None, log=None):
        self.repo = repo
        self.clock = clock
        self.cfg = _merge(DEFAULTS, config or {})
        self.owner_id = str(owner_id) if owner_id else None
        self.rng = rng or random.Random()
        self.log_line = log or (lambda entry: None)
        self.invites: dict[str, dict] = {}
        self.last_hour_marked = -1
        self.acting = False
        self.state = self._load()

    # --- storage -------------------------------------------------------------------------

    def _fresh(self) -> dict:
        now = self.clock()
        return {
            "buckets": {"boredom": 0.1, "curiosity": 0.2, "share": 0.1, "loneliness": 0.1, "left_out": 0.0,
                        "frustration": 0.0, "inhibition": 0.05, "social_hunger": 0.3, "growth": 0.5,
                        "reflection": 0.1, "expression": 0.1, "energy": 1.0},
            "born": now, "last_tick": now, "last_shutdown": None, "session_start": None,
            "last_heard": 0.0, "last_addressed": 0.0, "last_contact": 0.0, "last_learned": 0.0,
            "learned_since_reflect": 0, "reads_since_shared": 0, "last_spoke": 0.0, "last_speakup": 0.0,
            "ignored_streak": 0, "quiet_until": 0.0, "join_blocked_until": 0.0, "home_channel": None,
            "acted": {}, "lines": [], "people": {}, "uptake": None, "history": [], "last_fired": None,
            "open_invite": None, "post": None, "last_blocked": None,
        }

    def _load(self) -> dict:
        try:
            row = self.repo.conn.execute("SELECT value FROM self_state WHERE key = ?", (KEY,)).fetchone()
            saved = json.loads(row[0]) if row else None
        except (ValueError, TypeError):
            saved = None
        state = self._fresh()
        if not saved:
            return state
        state.update({k: v for k, v in saved.items() if k != "buckets"})
        state["buckets"].update(saved.get("buckets") or {})
        # A bad or lonely day lingers a little into the next, then fades within about a day.
        away = self.clock() - (saved.get("last_tick") or self.clock())
        if away > 2 * HOUR:
            keep = max(0.0, 1 - away / (24 * HOUR))
            b = state["buckets"]
            b["frustration"] = min(b["frustration"], 0.3 * keep)
            b["loneliness"] = min(b["loneliness"], 0.3 * keep)
            b["left_out"] = min(b["left_out"], 0.2 * keep)
        return state

    def save(self) -> None:
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO self_state(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
                (KEY, json.dumps(self.state)))

    def _log(self, **entry) -> None:
        try:
            self.log_line({"at": datetime.now().isoformat(timespec="seconds"), **entry})
        except Exception:  # noqa: BLE001 - logging must never break her
            pass

    # --- small helpers -------------------------------------------------------------------

    @property
    def b(self) -> dict:
        return self.state["buckets"]

    def impulse(self, name: str) -> None:
        for bucket, value in self.cfg["impulses"].get(name, {}).items():
            self.b[bucket] = clamp01(self.b.get(bucket, 0.0) + value)

    def person(self, pid: str, name: str | None = None) -> dict:
        pid = str(pid)
        p = self.state["people"].setdefault(pid, {"name": name or "", "bond": 0.0, "hours": [0] * 24,
                                                   "acked": 0, "ignored": 0, "missing": 0.0})
        if name:
            p["name"] = name
        p.setdefault("hours", [0] * 24)
        p.setdefault("bond", 0.0)
        p.setdefault("missing", 0.0)
        return p

    def is_owner(self, pid) -> bool:
        return bool(self.owner_id) and str(pid) == self.owner_id

    def feel_of(self, pid) -> dict:
        p = self.person(pid)
        owner = self.is_owner(pid)
        return p.setdefault("feel", {"affection": 0.9 if owner else 0.45, "respect": 0.9 if owner else 0.55,
                                     "friction": 0.0})

    def _hour(self, now: float) -> int:
        return datetime.fromtimestamp(now).hour

    def is_night(self, now: float | None = None) -> bool:
        hour = self._hour(self.clock() if now is None else now)
        start, end = self.cfg["night"]["start"], self.cfg["night"]["end"]
        return hour >= start or hour < end if start > end else start <= hour < end

    def room_energy(self, now: float) -> float:
        return clamp01(len([l for l in self.state["lines"] if now - l["at"] < 5 * MIN]) / 12)

    def _since(self, action: str, now: float) -> float:
        return now - self.state["acted"].get(action, 0.0)

    def _tiredness(self, urge: float) -> float:
        return urge * (0.4 + 0.6 * self.b["energy"])

    # --- feelings toward each person ---------------------------------------------------

    def feel_update(self, pid, text: str) -> None:
        if not pid or not text:
            return
        f = self.feel_of(pid)
        if RUDE_WORDS.search(text):
            f["respect"] = clamp01(f["respect"] - 0.12)
            f["friction"] = clamp01(f["friction"] + 0.14)
            f["affection"] = clamp01(f["affection"] - 0.05)
        elif KIND_WORDS.search(text):
            f["affection"] = clamp01(f["affection"] + 0.04)
            f["respect"] = clamp01(f["respect"] + 0.02)
            f["friction"] = clamp01(f["friction"] - 0.03)
        if FLIRT_WORDS.search(text) and f["respect"] >= 0.6:
            f["affection"] = clamp01(f["affection"] + 0.03)
        f["friction"] = clamp01(f["friction"] * 0.995)
        base = 0.9 if self.is_owner(pid) else 0.55
        f["respect"] = clamp01(f["respect"] + (base - f["respect"]) * 0.002)

    def may_flirt(self, pid) -> bool:
        f = self.feel_of(pid)
        return self.is_owner(pid) or (f["affection"] >= 0.8 and f["respect"] >= 0.7 and f["friction"] < 0.3)

    def stance(self, pid) -> str:
        """How she feels toward this person, as a single word the wording rules key on."""
        f = self.feel_of(pid)
        if self.is_owner(pid):
            return "hurt" if f["respect"] < 0.5 else "devoted"
        if f["respect"] < 0.4 or f["friction"] > 0.5:
            return "cold"
        if self.may_flirt(pid):
            return "playful"
        if f["affection"] >= 0.6:
            return "warm"
        return "reserved"

    # --- people and time ---------------------------------------------------------------

    def _exchange(self, p: dict, now: float) -> None:
        hour_key = int(now // HOUR)
        if p.get("hour_marked") != hour_key:
            p["hour_marked"] = hour_key
            p["hours"][self._hour(now)] += 1
        p["last_contact"] = now
        p["bond"] = clamp01(p["bond"] + self.cfg["bond"]["gain"] * (1 - p["bond"]))
        p["missing"] = clamp01(p["missing"] - 0.5)
        self.state["last_contact"] = now

    @staticmethod
    def _usual_gap_hours(p: dict) -> float:
        active = len([n for n in p["hours"] if n > 0])
        return 12 if active >= 6 else 24 if active >= 2 else 48

    @staticmethod
    def _usually_here(p: dict, hour: int) -> bool:
        most = max(p["hours"]) if p["hours"] else 0
        return most >= 3 and p["hours"][hour] >= most * 0.5

    def _targets(self, now: float, present: list, open_questions: int, in_call: bool) -> dict:
        s = self.state
        full = self.cfg["full"]
        minutes = lambda seconds: seconds / MIN  # noqa: E731
        silence = minutes(now - s["last_heard"]) if s["last_heard"] else 0
        since_addressed = minutes(now - (s["last_addressed"] or s["session_start"] or now))
        energy = self.room_energy(now)
        here = len(present)
        return {
            "boredom": clamp01(silence / full["silence"]) * (1 - energy) if in_call and here else 0.0,
            "curiosity": clamp01(open_questions / 3) * 0.8,
            "share": 0.0,
            "loneliness": (clamp01(since_addressed / full["unaddressed"]) if in_call and here else
                           clamp01(minutes(now - (s["session_start"] or now)) / full["alone"]) * 0.6 if in_call else 0.0),
            "left_out": energy * clamp01(since_addressed / full["left_out"]) if in_call and here else 0.0,
            "frustration": 0.0,
            "inhibition": max(self.cfg["night"]["inhibition"] if self.is_night(now) else 0.0,
                              self.cfg["quiet"]["inhibition"] if now < s["quiet_until"] else 0.0),
            "social_hunger": clamp01(minutes(now - (s["last_contact"] or s["born"])) / full["no_contact"]),
            "growth": clamp01(minutes(now - (s["last_learned"] or s["born"])) / full["not_learning"]) * 0.9,
            "reflection": clamp01(s["learned_since_reflect"] / full["unprocessed"]),
            "expression": clamp01(s["reads_since_shared"] / 6) * 0.7,
            "energy": ENERGY[self._hour(now)],
        }

    def _settle(self, now: float, present: list, open_questions: int, in_call: bool) -> None:
        dt = max(0.0, now - self.state["last_tick"])
        if not dt:
            return
        target = self._targets(now, present, open_questions, in_call)
        for bucket, tau in self.cfg["tau"].items():
            if bucket == "missing":
                continue
            k = math.exp(-dt / (tau * MIN))
            self.b[bucket] = clamp01(target[bucket] + (self.b.get(bucket, 0.0) - target[bucket]) * k)
        hour = self._hour(now)
        here = {str(m["id"]) for m in present}
        k_miss = math.exp(-dt / (self.cfg["tau"]["missing"] * MIN))
        k_bond = math.exp(-dt / (self.cfg["bond"]["fade_days"] * 24 * HOUR))
        for pid, p in self.state["people"].items():
            self.person(pid)
            p["bond"] *= k_bond
            away = 0 if pid in here else (now - (p.get("last_contact") or now)) / HOUR
            expected = 0.25 if pid not in here and self._usually_here(p, hour) else 0
            goal = 0.0 if pid in here else clamp01(p["bond"] * 2.5 * (clamp01(away / self._usual_gap_hours(p)) + expected))
            p["missing"] = clamp01(goal + (p["missing"] - goal) * k_miss)
        self.state["last_tick"] = now

    def _presence(self, now: float, present: list) -> list:
        """Who's in the call with her; returns the people who just came back after a while away."""
        ids = {str(m["id"]) for m in present}
        returned = []
        hour_key = int(now // HOUR)
        mark = hour_key != self.last_hour_marked
        if mark:
            self.last_hour_marked = hour_key
        for m in present:
            p = self.person(m["id"], m.get("name"))
            if not p.get("present_since"):
                if p.get("left_at") and (now - p["left_at"]) / MIN >= self.cfg["welcome_after_minutes"]:
                    returned.append(p)
                p["present_since"] = now
            p["last_contact"] = max(p.get("last_contact") or 0, now - 60)
            if mark:
                p["hours"][self._hour(now)] += 1
        for pid, p in self.state["people"].items():
            if pid not in ids and p.get("present_since"):
                p["present_since"] = None
                p["left_at"] = now
        return returned

    # --- events --------------------------------------------------------------------------

    def joined_call(self) -> None:
        now = self.clock()
        self.state["session_start"] = now
        self._log(event="session-start")
        self.save()

    def left_call(self) -> None:
        now = self.clock()
        self.state["last_shutdown"] = now
        self.state["session_start"] = None
        for p in self.state["people"].values():
            if p.get("present_since"):
                p["present_since"] = None
                p["left_at"] = now
        self.save()

    def heard(self, pid, name: str, text: str, addressed: bool) -> None:
        """A line spoken in her call (or a message in a channel she's in)."""
        now = self.clock()
        w = words(text)
        lines = self.state["lines"]
        lines.append({"at": now, "id": str(pid), "name": name, "words": sorted(w)})
        self.state["lines"] = [l for l in lines if now - l["at"] < 60 * MIN][-300:]
        self.state["last_heard"] = now
        p = self.person(pid, name)
        p["last_spoke"] = now
        self.feel_update(pid, text)

        up = self.state.get("uptake")
        if up:
            quick = now - up["at"] < self.cfg["uptake"]["quick_reply_seconds"] and QUICK_ACK.search(text)
            if addressed or quick or len(w & set(up["words"])) >= 2:
                self._resolve_uptake("acknowledged", pid, name)
            else:
                up["lines"] += 1
                if up["lines"] >= self.cfg["uptake"]["max_lines"]:
                    self._resolve_uptake("ignored", pid, name)
        if addressed:
            self.state["last_addressed"] = now
            p["last_addressed_her"] = now
            self._exchange(p, now)
            self.impulse("addressed")
            if QUIET.search(text):
                self.state["quiet_until"] = now + self.cfg["quiet"]["minutes"] * MIN
                self.b["inhibition"] = max(self.b["inhibition"], self.cfg["quiet"]["inhibition"])
                self._log(event="told-quiet", by=name)
            elif UNQUIET.search(text):
                self.state["quiet_until"] = 0.0
                self.state["ignored_streak"] = 0
                self.b["inhibition"] = min(self.b["inhibition"], 0.1)
                self._log(event="invited-to-talk", by=name)
            if RUDE.search(text):
                self.impulse("rude")
        self.save()

    def contact(self, pid, name: str, channel_id: str | None, is_dm: bool) -> None:
        """A text message to her (DM, mention, or her chat channel)."""
        now = self.clock()
        p = self.person(pid, name)
        self._exchange(p, now)
        self.impulse("message")
        dm = p.get("dm") or {}
        if dm.get("awaiting"):
            dm["awaiting"] = False
            dm["ignored"] = 0
            p["dm"] = dm
            self.state["ignored_streak"] = max(0, self.state["ignored_streak"] - 1)
            self._log(event="dm-answered", by=name)
        if not is_dm and channel_id:
            self.state["home_channel"] = str(channel_id)
            post = self.state.get("post") or {}
            if post.get("awaiting"):
                self.state["post"] = {**post, "awaiting": False, "ignored": 0}
                self._log(event="post-answered", by=name)
        self.save()

    def set_home(self, channel_id) -> None:
        if channel_id:
            self.state["home_channel"] = str(channel_id)
            self.save()

    def spoke(self, text: str, unprompted: bool = False, want: str | None = None) -> None:
        now = self.clock()
        self.state["last_spoke"] = now
        if unprompted:
            self.state["last_speakup"] = now
            self.state["uptake"] = {"at": now, "text": text, "want": want, "words": sorted(words(text)), "lines": 0}
        self.save()

    def talked_over(self, pid) -> None:
        self.impulse("talked_over")
        self.save()

    def told_to_leave(self, by: str) -> None:
        self.state["join_blocked_until"] = self.clock() + self.cfg["pacing"]["after_told_leave"] * MIN
        self._log(event="told-to-leave", by=by)
        self.save()

    def learned(self, questions: int = 0, facts: int = 0, source: str = "conversation") -> None:
        for _ in range(min(3, questions)):
            self.impulse("new_question")
        if facts >= 3:
            self.impulse("new_knowledge")
        if facts:
            self.state["last_learned"] = self.clock()
            self.state["learned_since_reflect"] += facts
            if source == "news":
                self.state["reads_since_shared"] += min(3, math.ceil(facts / 5))
        self.save()

    # --- invitations ---------------------------------------------------------------------

    def _invite_want(self, inviter_id, inviter_name: str, people: list, asks: int = 1, mood: bool = True):
        now = self.clock()
        b = self.b
        inviter = self.state["people"].get(str(inviter_id)) if inviter_id else None
        there = [self.state["people"][str(m["id"])] for m in people if str(m["id"]) in self.state["people"]]
        closeness = max((p["bond"] for p in there), default=0.0)
        missing = max((p["missing"] for p in there), default=0.0)
        reasons = []
        want = 0.15

        def add(amount, why):
            nonlocal want
            want += amount
            if abs(amount) >= 0.05:
                reasons.append((round(amount, 2), why))

        add(0.35 * b["social_hunger"], "craving company" if b["social_hunger"] > 0.5 else
            "had plenty of company" if b["social_hunger"] < 0.2 else "could use company")
        add(0.3 * ((inviter or {}).get("bond") or 0), f"{inviter_name} asked")
        if there:
            add(0.15 * closeness + 0.15 * missing, "someone she missed is in there" if missing > 0.4 else "people she knows are in there")
        add(0.2 * (b["energy"] - 0.6), "tired" if b["energy"] < 0.5 else "has energy")
        add(-0.3 * b["frustration"], "frustrated")
        add(-0.25 * b["inhibition"], "feeling held back")
        if now < self.state["join_blocked_until"]:
            add(-0.35, "was told to leave a call not long ago")
        if b["reflection"] > 0.7 or b["growth"] > 0.7:
            add(-0.1, "wanted time to herself")
        if asks > 1:
            add(0.12 * (asks - 1), "they asked again")
        if mood:
            add((self.rng.random() - 0.5) * 0.12, "just how she feels")
        return want, reasons

    def consider_invite(self, inviter_id, inviter_name: str, people: list) -> dict:
        now = self.clock()
        if inviter_id:
            self.person(inviter_id, inviter_name)
        recent = self.invites.get(str(inviter_id))
        asks = recent["count"] + 1 if recent and now - recent["at"] < 15 * MIN else 1
        self.invites[str(inviter_id)] = {"at": now, "count": asks}
        want, reasons = self._invite_want(inviter_id, inviter_name, people, asks)
        join = want >= 0.4
        if join:
            self.state["join_blocked_until"] = 0.0
            self.state["open_invite"] = None
        self._log(event="invite", by=inviter_name, join=join, want=round(want, 2))
        self.save()
        top = sorted(reasons, key=lambda r: -abs(r[0]))[:3]
        return {"join": join, "want": round(want, 2), "reasons": [why for _, why in top], "asks": asks}

    def open_invite(self, inviter_id, inviter_name: str, guild_id, text_channel_id, in_seconds: float | None = None,
                    said: str = "") -> None:
        """'Join us whenever you're ready' (in_seconds None) or 'give me twenty minutes' (a promise)."""
        now = self.clock()
        if inviter_id:
            self.person(inviter_id, inviter_name)
        invite = {"inviter_id": str(inviter_id) if inviter_id else None, "inviter_name": inviter_name,
                  "guild_id": guild_id, "text_channel_id": text_channel_id, "at": now,
                  "until": now + (in_seconds + 30 * MIN if in_seconds is not None else 3 * HOUR)}
        if in_seconds is not None:
            invite["due"] = now + in_seconds
            invite["said"] = str(said)[:200]
        self.state["open_invite"] = invite
        self.state["join_blocked_until"] = 0.0
        self.save()

    # --- uptake and unanswered messages --------------------------------------------------

    def _resolve_uptake(self, outcome: str, pid=None, name=None) -> None:
        up = self.state.get("uptake")
        if not up:
            return
        self.state["uptake"] = None
        self.impulse(outcome)
        if outcome == "acknowledged":
            self.state["ignored_streak"] = 0
            if pid is not None and str(pid) in self.state["people"]:
                p = self.state["people"][str(pid)]
                p["acked"] = p.get("acked", 0) + 1
                self._exchange(p, self.clock())
        elif outcome == "ignored":
            self.state["ignored_streak"] += 1
            for p in self.state["people"].values():
                if p.get("present_since"):
                    p["ignored"] = p.get("ignored", 0) + 1
        self._log(event="uptake", outcome=outcome, want=up.get("want"), streak=self.state["ignored_streak"])

    def _check_messages(self, now: float) -> None:
        post = self.state.get("post") or {}
        if post.get("awaiting") and now - post.get("at", now) > self.cfg["pacing"]["post_wait_reply"] * MIN:
            self.state["post"] = {**post, "awaiting": False, "ignored": post.get("ignored", 0) + 1}
            self.impulse("dm_ignored")
            self._log(event="post-unanswered")
        for p in self.state["people"].values():
            dm = p.get("dm") or {}
            if not dm.get("awaiting") or now - dm.get("at", now) < self.cfg["pacing"]["dm_wait_reply"] * MIN:
                continue
            dm["awaiting"] = False
            dm["ignored"] = dm.get("ignored", 0) + 1
            p["dm"] = dm
            p["bond"] = clamp01(p["bond"] - 0.03)
            self.impulse("dm_ignored")
            self._log(event="dm-unanswered", to=p.get("name"))

    # --- deciding ------------------------------------------------------------------------

    def _lull_needed(self) -> float:
        lines = self.state["lines"]
        gaps = sorted(lines[i]["at"] - lines[i - 1]["at"] for i in range(1, len(lines)))
        lull = self.cfg["lull_seconds"]
        typical = gaps[len(gaps) // 2] if len(gaps) >= 4 else lull["min"] * 2
        base = min(lull["max"], max(lull["min"], typical * 1.5))
        return base + self.b["inhibition"] * lull["inhibited_extra"]

    def _cooldown(self) -> float:
        return min(self.cfg["cooldown_seconds"] * 2 ** self.state["ignored_streak"], self.cfg["cooldown_max_minutes"] * MIN)

    def _call_wants(self, now: float, here: list, returned: list, world: dict) -> list:
        b = self.b
        out = []
        if returned:
            out.append({"want": "welcome_back", "urge": 0.9, "person": returned[0]["name"]})
        open_count = world.get("open_questions", 0)
        if open_count:
            out.append({"want": "ask", "urge": max(b["curiosity"], 0.45 + 0.1 * min(3, open_count))})
        if b["share"] > 0.2 or b["expression"] > 0.3:
            out.append({"want": "share", "urge": max(b["share"], b["expression"])})
        if b["left_out"] > 0.2:
            out.append({"want": "join_in", "urge": max(b["left_out"], b["loneliness"] * 0.8)})
        if b["boredom"] > 0.2:
            out.append({"want": "break_silence", "urge": max(b["boredom"], b["loneliness"] * 0.7)})
        if here and b["growth"] > 0.3:
            ranked = sorted(((str(m["id"]), self.state["people"].get(str(m["id"]))) for m in here),
                            key=lambda item: -((item[1] or {}).get("bond", 0) + 0.2) / (1 + (item[1] or {}).get("asked", 0)))
            pid, p = ranked[0]
            if p:
                out.append({"want": "ask_about_them", "urge": max(b["growth"], b["social_hunger"] * 0.8),
                            "person": p["name"], "id": pid})
        if b["boredom"] > 0.3 and (b["expression"] > 0.3 or b["social_hunger"] > 0.4):
            out.append({"want": "start_topic", "urge": max(b["expression"], b["social_hunger"], b["boredom"] * 0.9)})
        if self.room_energy(now) > 0.3:
            limit = self.cfg["check_in_after_minutes"] * MIN
            for m in here:
                p = self.state["people"].get(str(m["id"]))
                if (p and p.get("present_since") and now - p["present_since"] > limit
                        and now - (p.get("last_spoke") or 0) > limit and p["bond"] > 0.1):
                    out.append({"want": "check_in", "urge": 0.4 + p["bond"] * 0.5, "person": p["name"], "id": str(m["id"])})
                    break
        momentum = world.get("momentum", 0.0)
        wants = [w if w["want"] in ("ask", "welcome_back", "check_in", "need")
                 else {**w, "extra": w.get("extra", 0) + momentum * 0.25} for w in out]
        if momentum >= 0.3:
            wants.append({"want": "follow_up", "urge": 0.35 + momentum * 0.4 + b["curiosity"] * 0.2 + b["growth"] * 0.1})
        weight = self.cfg["inhibition_weight"]
        return [{**w, "scope": "call", "urge": self._tiredness(clamp01(w["urge"] + b["frustration"] * 0.15)),
                 "need": self.cfg["thresholds"][w["want"]] + b["inhibition"] * weight + w.get("extra", 0)}
                for w in wants]

    def _life_wants(self, now: float, here: list, world: dict) -> list:
        b = self.b
        s = self.state
        pacing = self.cfg["pacing"]
        out = []
        in_voice = bool(world.get("in_voice"))
        if not in_voice and now >= s["join_blocked_until"] and self._since("join_call", now) > pacing["join_call"] * MIN:
            for room in world.get("voice_rooms", []):
                pull = max([b["social_hunger"]] + [
                    (s["people"].get(str(m["id"]), {}).get("missing", 0) + s["people"].get(str(m["id"]), {}).get("bond", 0) * 0.5)
                    for m in room["people"]])
                out.append({"want": "join_call", "urge": pull, "room": room,
                            "person": ", ".join(m["name"] for m in room["people"])})
        invite = s.get("open_invite")
        if invite and now > invite["until"]:
            s["open_invite"] = None
        elif invite and invite.get("due") and not in_voice:
            target = self._invite_target(invite, world) if now >= invite["due"] else None
            if target:
                out.append({"want": "accept_invite", "urge": 1.0, "room": target, "person": invite["inviter_name"],
                            "inner": True, "kept": True})
        elif invite and not in_voice and self._since("accept_invite", now) > 2 * MIN:
            target = self._invite_target(invite, world)
            if target:
                want, _ = self._invite_want(invite.get("inviter_id"), invite["inviter_name"], target["people"], mood=False)
                standing = 0.1 + min(0.2, (now - invite["at"]) / HOUR * 0.15)
                out.append({"want": "accept_invite", "urge": want + standing, "room": target,
                            "person": invite["inviter_name"], "inner": True})
        present = {str(m["id"]) for m in here}
        missed = sorted(((pid, p) for pid, p in s["people"].items()
                         if pid not in present and p["missing"] > 0.3 and not (p.get("dm") or {}).get("awaiting")
                         and now - (p.get("dm") or {}).get("at", 0) > pacing["dm_same_person"] * MIN),
                        key=lambda item: -item[1]["missing"])
        if missed:
            pid, p = missed[0]
            out.append({"want": "dm", "urge": p["missing"], "person": p["name"], "id": pid,
                        "extra": 0.1 * (p.get("dm") or {}).get("ignored", 0)})
        post = s.get("post") or {}
        ignored = post.get("ignored", 0)
        if (not in_voice and s["home_channel"] and not post.get("awaiting")
                and self._since("post", now) > pacing["post"] * MIN * 2 ** min(3, ignored)):
            out.append({"want": "post", "urge": max(b["social_hunger"], b["expression"]), "extra": 0.08 * ignored})
        if not world.get("room_active"):
            quiet_room = not in_voice or now - s["last_heard"] > 5 * MIN
            if self._since("reflect", now) > pacing["reflect"] * MIN and quiet_room:
                out.append({"want": "reflect", "urge": b["reflection"], "inner": True})
            if self._since("read", now) > pacing["read"] * MIN:
                out.append({"want": "read", "urge": b["growth"], "inner": True})
            if self._since("search", now) > pacing["search"] * MIN:
                out.append({"want": "search", "urge": max(b["curiosity"], b["growth"] * 0.9, b["boredom"] * 0.6), "inner": True})
            if self._since("project", now) > pacing["project"] * MIN:
                out.append({"want": "project", "urge": max(b["growth"], b["expression"]) * 0.95 + 0.05, "inner": True})
            if not in_voice and self._since("wander", now) > pacing["wander"] * MIN and now - s["last_contact"] > 20 * MIN:
                out.append({"want": "wander", "urge": max(b["boredom"], b["reflection"], b["social_hunger"] * 0.7), "inner": True})
            if self._since("write", now) > pacing["write"] * MIN and (not in_voice or now - s["last_heard"] > 10 * MIN):
                out.append({"want": "write", "urge": max(b["expression"], b["reflection"] * 0.8), "inner": True})
        weight = self.cfg["inhibition_weight"]
        return [{**w, "scope": "life", "urge": w["urge"] if w.get("inner") else self._tiredness(w["urge"]),
                 "need": self.cfg["thresholds"][w["want"]] + (0 if w.get("inner") else b["inhibition"] * weight) + w.get("extra", 0)}
                for w in out]

    @staticmethod
    def _invite_target(invite: dict, world: dict):
        rooms = [r for r in world.get("voice_rooms", []) if r.get("guild_id") == invite.get("guild_id")]
        for room in rooms:
            if any(str(m["id"]) == str(invite.get("inviter_id")) for m in room["people"]):
                return room
        return max(rooms, key=lambda r: len(r["people"]), default=None)

    def _call_blocked(self, now: float, best: dict, world: dict) -> str | None:
        s = self.state
        quiet_for = now - max(s["last_heard"], s["last_spoke"])
        if not world.get("can_speak_now", True):
            return "floor busy"
        if quiet_for < self._lull_needed():
            return "waiting for a lull"
        if now - s["last_speakup"] < self._cooldown() and best["want"] != "welcome_back":
            return "cooling down"
        if now < s["quiet_until"] and best["want"] != "welcome_back":
            return "told to be quiet"
        if s.get("uptake"):
            return "waiting to see if anyone responds"
        return None

    def tick(self, world: dict | None = None) -> dict | None:
        """Advance her feelings to now and pick at most one thing to do.

        world: {"in_voice": bool, "here": [{"id","name"}], "voice_rooms": [{"guild_id","channel_id","name",
        "people": [...] }], "room_active": bool, "can_speak_now": bool, "open_questions": int,
        "momentum": float}. Returns the want to act on, or None. The caller acts, then calls done()."""
        if not self.cfg["enabled"]:
            return None
        world = world or {}
        now = self.clock()
        here = world.get("here") or []
        in_call = bool(world.get("in_voice"))
        returned = self._presence(now, here) if in_call else []
        self._settle(now, here, world.get("open_questions", 0), in_call)
        self._check_messages(now)
        up = self.state.get("uptake")
        if up and now - up["at"] > self.cfg["uptake"]["window_seconds"]:
            self._resolve_uptake("ignored" if up["lines"] else "unanswered")
        history = self.state["history"]
        if not history or now - history[-1]["at"] >= 10 * MIN:
            history.append({"at": now, "buckets": dict(self.b)})
            del history[:-18]
        choice = None
        if not self.acting:
            options = (self._call_wants(now, here, returned, world) if in_call else []) + self._life_wants(now, here, world)
            options = sorted((w for w in options if w["urge"] >= w["need"]), key=lambda w: -(w["urge"] - w["need"]))
            for best in options:
                blocked = self._call_blocked(now, best, world) if best["scope"] == "call" else None
                if blocked:
                    key = f"{best['want']}|{blocked}"
                    if self.state.get("last_blocked") != key:
                        self._log(event="held", want=best["want"], why=blocked)
                    self.state["last_blocked"] = key
                    continue
                self.state["last_blocked"] = None
                choice = best
                break
        if choice is not None:
            self.acting = True
            # Mark it now so a slow action is never picked twice.
            self.state["acted"][choice["want"]] = now
        self.save()
        return choice if (choice is None or self.cfg["live"]) else self._skip(choice)

    def _skip(self, choice: dict) -> None:
        self._log(event="act", want=choice["want"], live=False)
        self.acting = False
        return None

    def done(self, choice: dict, result) -> None:
        """The caller acted on `choice`; result is what she said/did (truthy) or None (nothing came out)."""
        now = self.clock()
        self.acting = False
        want = choice["want"]
        self._log(event="speak-up" if choice["scope"] == "call" else "act", want=want, person=choice.get("person"),
                  urge=round(choice["urge"], 2), need=round(choice["need"], 2),
                  result=str(result)[:200] if result else None)
        self.state["acted"][want] = now
        if result:
            for bucket in RELIEF.get(want, []):
                self.b[bucket] = clamp01(self.b[bucket] - 0.45)
            self.state["last_fired"] = {"want": want, "at": now, "person": choice.get("person")}
            if want == "reflect":
                self.state["learned_since_reflect"] = 0
            if want in ("share", "start_topic", "post"):
                self.state["reads_since_shared"] = 0
            if want == "ask_about_them" and choice.get("id"):
                p = self.person(choice["id"])
                p["asked"] = p.get("asked", 0) + 1
            if want == "accept_invite":
                self.state["open_invite"] = None
            if want == "post":
                self.state["post"] = {**(self.state.get("post") or {}), "at": now, "awaiting": True}
            if want == "dm" and choice.get("id"):
                p = self.person(choice["id"])
                p["dm"] = {**(p.get("dm") or {}), "at": now, "awaiting": True}
                p["missing"] = clamp01(p["missing"] - 0.4)
            if choice["scope"] == "call":
                self.spoke(str(result), unprompted=True, want=want)
        elif choice["scope"] == "call":
            self.state["last_speakup"] = now  # nothing came out: wait out a cooldown instead of retrying
        self.save()

    # --- what the rest of her reads ------------------------------------------------------

    def feelings_now(self) -> list[str]:
        b = self.b
        found = sorted(((k, w) for k, t, w, _ in FEELINGS if b.get(k, 0) >= t), key=lambda item: -b[item[0]])[:4]
        out = []
        for key, word in found:
            value = b[key]
            out.append(("very " if value >= 0.85 else "" if value >= 0.65 else "a little ") + word)
        if b.get("energy", 1) < 0.35:
            out.append("worn out")
        return out

    def strongest_drive(self) -> str | None:
        b = self.b
        top = sorted(((b.get(k, 0), desc) for k, t, _, desc in FEELINGS if b.get(k, 0) >= t), reverse=True)
        return top[0][1] if top else None

    def avatar_feelings(self) -> dict[str, float]:
        """Her drives in the avatar's feeling vocabulary, so her face shows what she feels."""
        b = self.b
        lone = max([b["loneliness"], b["social_hunger"] * 0.8] + [p["missing"] for p in self.state["people"].values()])
        values = {"curious": b["curiosity"] * 0.6, "bored": b["boredom"] * 0.5, "frustrated": b["frustration"] * 0.6,
                  "sad": lone * 0.45, "pensive": b["reflection"] * 0.5, "excited": b["expression"] * 0.45,
                  "tired": (1 - b["energy"]) * 0.6, "determined": b["growth"] * 0.35}
        return {k: round(v, 3) for k, v in values.items() if v >= 0.07}

    def missed_people(self, limit: int = 2) -> list[dict]:
        people = [p for p in self.state["people"].values() if p["missing"] > 0.4 and not p.get("present_since")]
        return sorted(people, key=lambda p: -p["missing"])[:limit]

    def snapshot(self) -> dict:
        return {"buckets": {k: round(v, 3) for k, v in self.b.items()}, "ignored_streak": self.state["ignored_streak"],
                "quiet_until": self.state["quiet_until"], "last_fired": self.state["last_fired"],
                "uptake": self.state["uptake"], "home_channel": self.state["home_channel"],
                "open_invite": self.state.get("open_invite"), "feelings": self.feelings_now(),
                "people": {pid: {"name": p.get("name"), "bond": round(p["bond"], 3), "missing": round(p["missing"], 3),
                                 "stance": self.stance(pid)} for pid, p in self.state["people"].items()}}

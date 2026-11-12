"""Carries out what Amy decides to do on her own, through the Discord sidecar.

`dialogue/life.py` decides (pure rules); this file acts: speaking up in a call, joining a call her
people are in, DMing someone she misses, posting in her channel, writing in her journal, reading the
news, looking things up, working on a project, writing a story. The words come from
`dialogue/life_words.py`. Nothing here calls a language model.

Threading: database work stays on the bot's main thread. Network reading (news, web) runs on a worker
thread that only fetches, then hands the result back through the bridge inbox as a `life-result`.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from dialogue.life import Life
from dialogue.life_words import LifeWords, first_sentence, promised_delay
from dialogue.reading import DATA, Reading

# "Do you want to join us in voice?", "come hop in the call", "wanna hang in vc?"
INVITE = re.compile(r"\b(?:join|hop in(?:to)?|come (?:in|into|to|hang|chill|join)|jump in(?:to)?|get in(?:to)?|pop in(?:to)?|hang (?:out )?(?:with us )?in)\b[^.?!]{0,40}\b(?:voice|vc|call|channel|us|general|lounge|room)\b|\b(?:want|wanna|you wanna|care) to (?:join|hop in|come|hang)\b", re.I)
# "Join us when you're ready", "come whenever", "no pressure, door's open".
OPEN_INVITE = re.compile(r"\b(?:when(?:ever)? you(?:'re| are) ready|when(?:ever)? you feel like it|whenever you want|come (?:in|join|by) (?:when|whenever)|no pressure|door(?:'s| is) open|take your time)\b", re.I)
PERSUADE = re.compile(r"\b(?:please|pls|plz|pretty please|come on|c'?mon|for me|just for a (?:bit|minute|while|sec)|do it|you know you want to|we miss you|it'?ll be fun|don'?t be like that)\b", re.I)
LEAVE = re.compile(r"\b(?:leave|get out|go away|hang up|disconnect)\b", re.I)

THOUGHT_LABEL = {"reflect": "journal", "wander": "a passing thought", "search": "looked something up",
                 "project": "working on a project", "write": "wrote a story"}


class LifeActor:
    def __init__(self, bot):
        self.bot = bot
        self.rooms: list[dict] = []
        self.mine: dict[str, dict] = {}  # guild -> {"voice", "text"} for calls she's in
        self.pending: dict | None = None  # the want being carried out
        self.arrival: dict | None = None  # say hello once she's settled in a call she chose to join
        self.following: dict[str, dict] = {}  # inviter id -> {"until", "text"}: join when they hop in
        self.invited: dict[str, dict] = {}  # guild -> {"inviter_id", "at"}: an invite still in play
        self.log_path = DATA / "life-log.jsonl"
        convo = bot.convo
        self.reading = Reading(bot.repo)
        self.life = Life(bot.repo, owner_id=os.environ.get("OWNER_ID") or None, log=self._log)
        self.words = LifeWords(convo, self.reading, self.life)
        convo.life = self.life

    # ---- plumbing ----

    @property
    def service(self):
        return self.bot.service

    @property
    def send(self):
        return self.bot.bridge.send

    def _log(self, entry: dict) -> None:
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry) + "\n")
        except OSError:
            pass

    def _post(self, channel: str | None, text: str) -> bool:
        if not channel or not text:
            return False
        self.send({"type": "say", "channel": channel, "content": text})
        return True

    def _share(self, label: str, text: str) -> None:
        """Her thinking on her own goes in her home channel too, so nothing she thinks is hidden."""
        channel = self.life.state.get("home_channel")
        if channel and text:
            self._post(channel, f"\U0001F4AD **{self.bot.convo.self_name} — {label}:**\n{text}")

    def _speak_in_call(self, guild: str, text: str) -> None:
        service = self.service
        if service.speaker is not None and guild not in service.playing:
            service._play(guild, service._voice_pcm(text, "own thought", intent="thinking-progress"), text)
        channel = (self.mine.get(guild) or {}).get("text") or getattr(service, "last_text_channel", None)
        self._post(channel, text)
        if service.wording:
            service.wording.delivered(text)

    # ---- what she observes ----

    def observe(self, msg: dict) -> bool:
        """Messages from the sidecar that are hers to handle. Returns True if consumed."""
        kind = msg.get("type")
        if kind == "voice-rooms":
            self.rooms = msg.get("rooms") or []
            self.mine = msg.get("mine") or {}
            self._follow_up_invites()
            return True
        if kind == "joined":
            self.mine[msg["guild"]] = {"voice": msg.get("voiceChannel"), "text": msg.get("textChannel")}
            self.service.last_voice_guild = msg["guild"]
            if msg.get("textChannel"):
                self.service.last_text_channel = msg["textChannel"]
                self.life.set_home(msg["textChannel"])
            self.life.joined_call()
            if self.arrival:
                self.arrival["guild"] = msg["guild"]
                self.arrival["at"] = time.time() + 2.5
        elif kind == "left":
            self.mine.pop(msg.get("guild"), None)
            if not self.mine:
                self.life.left_call()
        elif kind in ("join-failed", "dm-failed"):
            self._log({"event": kind, **{k: v for k, v in msg.items() if k != "type"}})
            if self.pending and self.pending["want"] in ("join_call", "accept_invite", "dm"):
                self._finish(None)
            self.arrival = None
            return True
        elif kind == "dm-sent":
            if self.pending and self.pending["want"] == "dm":
                self._finish(self.pending.get("text"))
            return True
        elif kind == "life-result":
            self._reading_done(msg)
            return True
        return False

    def heard(self, msg: dict, text: str, addressed: bool) -> None:
        """A line spoken in her call (called by the voice service once it's transcribed)."""
        user = msg.get("user") or {}
        if user.get("bot"):
            return
        self.life.heard(user.get("id"), user.get("name", ""), text, addressed)
        if addressed and LEAVE.search(text) and re.search(r"\b(?:call|voice|vc|channel)\b|^\W*leave\W*$", text, re.I):
            self.life.told_to_leave(user.get("name", ""))

    def text(self, msg: dict, content: str) -> str | None:
        """A text message to her. Handles invites to voice; returns her reply if it was one."""
        author = msg.get("author") or {}
        if author.get("bot"):
            return None
        guild = msg.get("guild")
        pid, name = author.get("id"), author.get("name", "")
        self.life.contact(pid, name, msg.get("channel"), is_dm=not guild)
        self.life.feel_update(pid, content)
        if not guild:
            return None
        if OPEN_INVITE.search(content) and (INVITE.search(content) or re.search(r"\b(?:voice|vc|call|join)\b", content, re.I)):
            self.life.open_invite(pid, name, guild, msg.get("channel"))
            self.invited[guild] = {"inviter_id": pid, "at": time.time()}
            return self.words.invite_reply(False, open_invite=True)
        pending = self.invited.get(guild)
        pending = pending if pending and time.time() - pending["at"] < 15 * 60 else None
        if INVITE.search(content) or (pending and PERSUADE.search(content)):
            target = self._invite_target(guild, pid, content)
            decision = self.life.consider_invite(pid, name, target["people"] if target else [])
            self.invited[guild] = {"inviter_id": pid, "at": time.time()}
            delay = promised_delay(content)
            if decision["join"] and delay:
                self.life.open_invite(pid, name, guild, msg.get("channel"), in_seconds=delay, said=content)
                minutes = round(delay / 60)
                return self.words.invite_reply(True, when=f"{minutes} minutes" if minutes < 60 else f"{minutes // 60} hour")
            if decision["join"]:
                self.invited.pop(guild, None)
                if target:
                    self.send({"type": "join-voice", "guild": guild, "channel": target["channel_id"],
                               "textChannel": msg.get("channel")})
                    self.arrival = {"want": "decided_to_join", "people": ", ".join(p["name"] for p in target["people"])}
                else:  # they're not in voice yet: join them when they hop in
                    self.following[str(pid)] = {"until": time.time() + 15 * 60, "text": msg.get("channel")}
            return self.words.invite_reply(decision["join"])
        return None

    def _invite_target(self, guild: str, inviter_id, content: str) -> dict | None:
        rooms = [r for r in self.rooms if r["guild_id"] == guild and r.get("joinable", True) and not r.get("mine")]
        for room in rooms:
            if any(str(p["id"]) == str(inviter_id) for p in room["people"]):
                return room
        for room in rooms:
            if room["name"].lower() in content.lower():
                return room
        return max(rooms, key=lambda r: len(r["people"]), default=None)

    def _follow_up_invites(self) -> None:
        now = time.time()
        for pid, follow in list(self.following.items()):
            if now > follow["until"]:
                del self.following[pid]
                continue
            for room in self.rooms:
                if room["guild_id"] in self.mine:
                    continue
                if any(str(p["id"]) == pid for p in room["people"]):
                    del self.following[pid]
                    self.send({"type": "join-voice", "guild": room["guild_id"], "channel": room["channel_id"],
                               "textChannel": follow["text"]})
                    self.arrival = {"want": "arrive", "people": ", ".join(p["name"] for p in room["people"])}
                    break

    # ---- deciding and acting ----

    def world(self) -> dict:
        service = self.service
        guild = next(iter(self.mine), None)
        here = []
        for room in self.rooms:
            if room.get("mine"):
                here += room["people"]
        candidates = [r for r in self.rooms if not r.get("mine") and r.get("joinable", True)
                      and r["guild_id"] not in self.mine]
        open_questions = len(getattr(self.bot.convo.pressure, "state", {}).get("open_questions", []))
        return {
            "in_voice": bool(self.mine),
            "here": here,
            "voice_rooms": candidates,
            "room_active": time.time() - service.last_activity < 45,
            "can_speak_now": guild is not None and guild not in service.playing,
            "open_questions": open_questions,
            "momentum": self._momentum(),
        }

    def _momentum(self) -> float:
        """How much a thread of conversation is going: recent lines that keep sharing words."""
        lines = [l for l in self.life.state["lines"] if time.time() - l["at"] < 5 * 60]
        if len(lines) < 4:
            return 0.0
        shared = sum(1 for a, b in zip(lines, lines[1:]) if len(set(a["words"]) & set(b["words"])) >= 1)
        return min(1.0, shared / max(1, len(lines) - 1))

    def tick(self) -> None:
        if self.arrival and self.arrival.get("guild") and time.time() >= self.arrival.get("at", 0):
            arrival, self.arrival = self.arrival, None
            text = self.words.speak_up(arrival["want"], arrival.get("people"))
            if text:
                self._speak_in_call(arrival["guild"], text)
                self.life.spoke(text, unprompted=True, want=arrival["want"])
        if self.pending:
            if time.time() - self.pending["started"] > 120:  # something never came back: let it go
                self._finish(None)
            return
        choice = self.life.tick(self.world())
        if choice is None:
            return
        self.pending = {**choice, "started": time.time()}
        try:
            self._act(choice)
        except Exception as exc:  # noqa: BLE001 - one failed action must not stop her life
            self._log({"event": "act-failed", "want": choice["want"], "error": repr(exc)})
            self._finish(None)

    def _finish(self, result) -> None:
        pending, self.pending = self.pending, None
        if pending:
            self.life.done(pending, result)

    def _act(self, choice: dict) -> None:
        want = choice["want"]
        if choice["scope"] == "call":
            guild = next(iter(self.mine), None)
            text = self.words.speak_up(want, choice.get("person"), choice.get("id")) if guild else None
            if text:
                self._speak_in_call(guild, text)
            self._finish(text)
            return
        if want in ("join_call", "accept_invite"):
            room = choice["room"]
            home = self.life.state.get("home_channel")
            invite = self.life.state.get("open_invite") or {}
            text_channel = invite.get("text_channel_id") if want == "accept_invite" else home
            self.send({"type": "join-voice", "guild": room["guild_id"], "channel": room["channel_id"],
                       "textChannel": text_channel})
            people = ", ".join(p["name"] for p in room["people"])
            self.arrival = {"want": ("kept_promise" if choice.get("kept") else "decided_to_join") if want == "accept_invite" else "arrive",
                            "people": people}
            self._finish(f"joined {room['name']}")
            return
        if want == "dm":
            text = self.words.dm(choice["id"], choice.get("person") or "")
            self.pending["text"] = text
            self.send({"type": "dm", "user": choice["id"], "content": text})
            return  # finished when the sidecar says it was sent
        if want == "post":
            text = self.words.post()
            self._finish(text if self._post(self.life.state.get("home_channel"), text) else None)
            return
        if want == "reflect":
            text = self.words.journal()
            self.reading.journal.write(text)
            self._share("journal", text)
            if len(self.reading.projects.active()) < 3 and self.words.rng.random() < 0.3:
                topic = self.words.project_topic()
                if topic:
                    self.reading.projects.start(topic, f"understand {topic}")
            self._finish(text)
            return
        if want == "wander":
            text = self.words.wander()
            self.reading.journal.write(text, "a passing thought")
            self._share("a passing thought", text)
            self._finish(text)
            return
        if want == "write":
            title, body = self.words.story()
            folder = DATA / "writing"
            folder.mkdir(parents=True, exist_ok=True)
            slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or "story"
            (folder / f"{slug}.md").write_text(f"# {title}\n\n{body}\n", encoding="utf-8")
            self._share("wrote a story", f"**{title}**\n{body}")
            self._finish(f"wrote {title}")
            return
        if want in ("read", "search", "project"):
            job = {"want": want}
            if want == "search":
                job["query"] = self.words.search_query()
                if not job["query"]:
                    self._finish(None)
                    return
            if want == "project":
                projects = sorted(self.reading.projects.active(), key=lambda p: p.get("updated", 0))
                if not projects:
                    topic = self.words.project_topic()
                    if not topic:
                        self._finish(None)
                        return
                    projects = [self.reading.projects.start(topic, f"understand {topic}")]
                project = projects[0]
                done = {n["note"].split('"')[1].lower() for n in project["notes"] if n["note"].count('"') >= 2}
                job["project"] = project["title"]
                job["query"] = project["title"] if project["title"].lower() not in done else (self.words.search_query() or project["title"])
            self._fetch(job)
            return
        self._finish(None)

    # ---- reading, off the main thread ----

    def _fetch(self, job: dict) -> None:
        inbox = self.bot.bridge.inbox
        reading = self.reading

        def work():
            try:
                if job["want"] == "read":
                    job["items"] = reading.news.refresh()
                else:
                    job["finding"] = reading.web.research(job["query"], why=job["want"])
            except Exception as exc:  # noqa: BLE001
                job["error"] = repr(exc)
            inbox.put({"type": "life-result", **job})

        threading.Thread(target=work, name=f"life-{job['want']}", daemon=True).start()

    def _teach(self, text: str, source: str) -> None:
        """Hear what she read the way she hears people: kept as history and topics, not taken as fact."""
        convo = self.bot.convo
        try:
            convo.repo.log_overheard(source, text)
            previous = convo.state.speaker
            convo.state.speaker = source
            try:
                convo.world.hear(text)  # a topic to wonder about later, not a fact
            finally:
                convo.state.speaker = previous
        except Exception:  # noqa: BLE001 - reading must never break her
            pass

    def _reading_done(self, msg: dict) -> None:
        if not self.pending or self.pending["want"] != msg.get("want"):
            return
        want = msg["want"]
        if msg.get("error"):
            self._log({"event": "reading-failed", "want": want, "error": msg["error"]})
            self._finish(None)
            return
        if want == "read":
            items = msg.get("items") or []
            for item in items:
                self._teach(f"{item['title']}. {first_sentence(item.get('summary', ''))}".strip(), "the news")
            if items:
                self.life.learned(facts=len(items) * 2, source="news")
            self._finish(f"read {len(items)} new stories" if items else None)
            return
        finding = msg.get("finding") or ""
        if not finding:
            self._finish(None)
            return
        self._teach(first_sentence(finding, 300), "the web")
        self.life.learned(questions=0, facts=2, source="web")
        if want == "search":
            note = self.words.search_note(msg["query"], finding)
            self._share(f'looked up "{msg["query"]}"', note)
            self._finish(note)
        else:
            next_topic = self.words.search_query()
            note = self.words.project_note(msg["project"], msg["query"], finding, next_topic)
            project = next((p for p in self.reading.projects.all() if p["title"] == msg["project"]), {"notes": []})
            self.reading.projects.note(msg["project"], f'Looked up "{msg["query"]}". {note}',
                                       done=len(project["notes"]) >= 6)
            self._share(f'working on "{msg["project"]}"', note)
            self._finish(note)

"""Talk about what a finding means, and about how it sits with Amy.

Two related intents live here:

* a reference request ("summarize that", "what did you find out about X?",
  "in your own words") reads back the compact note instead of the whole
  definition;
* a reflection request ("what do you think about that?", "how does that make
  you feel?") reasons over the note and the last answer, says what stands out,
  reads her actual state for the feeling, and records the opinion so it can be
  recalled later.

Reflection uses the existing SelfModel for feeling.  It does not introduce a
second mood system: it only fires an event there and stores the words she used.
"""

from __future__ import annotations

import json
import re

from dialogue.digestion import Note, _resolve_pronoun, _same, _sentence_list, topic_key

THAT = {"that", "this", "it", "them", "those", "these"}
HEAVY = re.compile(r"\b(?:sad|grief|grieving|died|death|funeral|depressed|heartbroken|"
                   r"mourning|devastated|suicide|bereaved|extinct|endangered|disease|"
                   r"war|violence|abuse|poison|toxic|threat|danger|suffering|kill(?:ed|ing)?)\b", re.I)

THINK = (
    re.compile(r"^\W*(?:and\s+|so\s+)?what (?:do|did) you think(?: (?:about|of) (?P<topic>.+?))?\W*$", re.I),
    re.compile(r"^\W*what(?:'s| is) your (?:take|opinion|view)(?: (?:on|about|of) (?P<topic>.+?))?\W*$", re.I),
    re.compile(r"^\W*how (?:do|did) you feel about (?P<topic>.+?)\W*$", re.I),
    re.compile(r"^\W*how (?:does|do) (?:that|this|it) make you feel\W*$", re.I),
    re.compile(r"^\W*what does (?:that|this|it) make you feel\W*$", re.I),
    re.compile(r"^\W*what do you make of (?P<topic>.+?)\W*$", re.I),
    re.compile(r"^\s*(?:your\s+)?thoughts(?:\?)?\s*$", re.I),
)
FIND = re.compile(
    r"^\W*(?:so\s+)?(?:what (?:did|do) you (?:find|learn|read|discover|remember)(?: out)?"
    r"(?: (?:about|on|from) (?P<topic>.+?))?|what did that tell you|"
    r"what did you get (?:out of|from) (?:that|it))\W*$", re.I)
SUMMARY = re.compile(
    r"^\W*(?:(?:can|could) you |please )?(?:(?:summarize|sum up|recap)(?: (?:that|this|it))?|"
    r"give me the gist(?: of)?(?: (?:that|it|what you (?:found|read|learned)))?|"
    r"what(?:'s| is) the gist(?: of (?:that|it))?|in your own words)"
    r"(?: (?:of|on|about) (?P<topic>.+?))?\W*$", re.I)
REMIND = re.compile(r"^\W*(?:remind me|tell me again)(?: (?:what|about))? (?P<topic>.+?)\W*$", re.I)
SIMPLE = re.compile(r"^\W*(?:and\s+)?(?:what|who) (?:is|are|was|were)(?: an?| the)? (?P<topic>.+?)\W*$", re.I)


class Reflector:
    def __init__(self, conversation) -> None:
        self.convo = conversation
        self.repo = conversation.repo
        self.digester = conversation.digester
        with self.repo.conn:
            self.repo.conn.executescript("""
                CREATE TABLE IF NOT EXISTS digest_reflections(
                    id INTEGER PRIMARY KEY,
                    note_id INTEGER,
                    speaker TEXT NOT NULL DEFAULT '',
                    topic TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    opinion TEXT NOT NULL,
                    feeling TEXT NOT NULL,
                    emotions_json TEXT NOT NULL,
                    appraisal_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS ix_digest_reflections_topic ON digest_reflections(topic);
            """)
        columns = {row[1] for row in self.repo.conn.execute("PRAGMA table_info(digest_reflections)")}
        if "appraisal_json" not in columns:
            with self.repo.conn:
                self.repo.conn.execute(
                    "ALTER TABLE digest_reflections ADD COLUMN appraisal_json TEXT NOT NULL DEFAULT '{}'")

    # --- shared helpers ---------------------------------------------------------

    def _last_reply(self) -> str:
        trace = getattr(self.convo.state, "last_trace", None) or {}
        reply = (trace.get("generated") or "").strip()
        if reply:
            return reply
        row = self.repo.conn.execute(
            "SELECT text FROM dialogue_turns WHERE role='engine' ORDER BY id DESC LIMIT 1").fetchone()
        return (row[0] or "").strip() if row else ""

    @staticmethod
    def _topic_from_reply(reply: str) -> str:
        first = (_sentence_list(reply) or [""])[0]
        first = re.sub(r"^(?:well|okay|ok|so|here's what i (?:found|know|read)|i (?:read|looked up|found)|"
                       r"according to [^,]+,)\s*", "", first, flags=re.I)
        words = re.findall(r"[A-Za-z][\w'-]*", first)
        verbs = {"is", "are", "was", "were", "has", "have", "had", "can", "could", "will",
                 "would", "does", "do", "did", "means", "refers"}
        for index, word in enumerate(words):
            if word in verbs and word == word.lower():
                words = words[:index]
                break
        return " ".join(words[:6])

    def _note_for(self, topic: str | None) -> Note | None:
        speaker = getattr(self.convo.state, "speaker", "") or ""
        if topic and topic.casefold().strip(" ?.!") not in THAT:
            return self.digester.note(topic, speaker)
        return self.digester.latest(speaker) or self.digester.latest()

    def _material(self, topic: str | None) -> tuple[Note | None, str, list[str], str]:
        """(note, gist, points, label) from a note, or from the last answer if there is none."""
        note = self._note_for(topic)
        if note is not None and note.gist:
            return note, note.gist, list(note.points), note.topic
        reply = self._last_reply()
        sentences = [s for s in _sentence_list(reply) if not s.endswith("?")]
        if not sentences:
            return None, "", [], (topic or "that")
        label = self._topic_from_reply(reply) or (topic or "that")
        sentences = [_resolve_pronoun(sentence, label) for sentence in sentences]
        return None, sentences[0], sentences[1:], label

    def _point(self, gist: str, points: list[str]) -> str:
        for point in points:
            if point and not _same(point, gist) and len(point.split()) >= 3:
                return point
        return ""

    def _related(self, note: Note | None, speaker: str) -> list[tuple[str, int]]:
        """Other notes this one actually shares terms with, strongest first."""
        if note is None:
            return []
        mine = {term.casefold() for term in note.terms if term}
        found = []
        for other in self.digester.recent(limit=12, speaker=speaker):
            if other.id == note.id:
                continue
            theirs = {term.casefold() for term in other.terms if term}
            overlap = mine & theirs
            if overlap:
                found.append((other.topic, len(overlap)))
        found.sort(key=lambda pair: (-pair[1], pair[0]))
        return found

    def _appraise(self, note: Note | None, gist: str, points: list[str], label: str,
                  emotions: dict, heavy: bool) -> dict:
        """Decide whether this finding actually matters to her, and why.

        The global interest emotion is only one small input.  A finding is worth
        her attention when it is new, connects to something she already has, or
        is clear enough to hold onto.  A thin, repeated note is allowed to be
        boring; that is the point.
        """
        speaker = getattr(self.convo.state, "speaker", "") or ""
        related = self._related(note, speaker)
        related_topic = related[0][0] if related else ""
        uses = note.uses if note is not None else 0

        novelty = 0.8 if uses == 0 else 0.55 if uses == 1 else 0.3
        if related:
            novelty = max(0.25, novelty - 0.1 * min(3, len(related)))

        relevance = 0.15
        if related:
            relevance += min(0.45, 0.15 * related[0][1] + 0.1 * min(3, len(related)))
        last = self._last_reply().casefold()
        if label and label.casefold() in last:
            relevance += 0.2
        if note is not None:
            # A grounded note with substance is more usable than a bare line.
            relevance += min(0.15, 0.05 * len(points))
            if note.source:
                relevance += 0.05
            if note.assertions:
                relevance += 0.1
            if note.source.startswith(("news:", "research:")):
                relevance += 0.05
            names = {speaker.casefold(), str(self.convo.self_name).casefold()}
            if any(str(term).casefold() in names for term in note.terms):
                relevance += 0.15
        relevance = min(1.0, relevance)

        clarity = 0.0
        if gist and len(gist.split()) >= 8:
            clarity += 0.2
        clarity += min(0.4, 0.15 * len(points))
        if note is not None:
            if note.assertions:
                clarity += 0.2
            if note.confidence >= 0.8:
                clarity += 0.1
        clarity = min(1.0, clarity)

        curiosity = max(float(emotions.get("interest", 0)), float(emotions.get("excitement", 0)))
        score = 0.4 * novelty + 0.3 * relevance + 0.2 * clarity + 0.1 * curiosity

        sadness = float(emotions.get("sadness", 0))
        anxiety = float(emotions.get("anxiety", 0))
        frustration = float(emotions.get("frustration", 0))
        if heavy and (sadness >= 0.3 or anxiety >= 0.4):
            stance = "heavy"
        elif frustration >= 0.45 and clarity < 0.55:
            stance = "uneasy"
        elif novelty < 0.4 and relevance >= 0.45:
            stance = "familiar"
        elif related_topic and relevance >= 0.3 and clarity >= 0.25:
            stance = "engaged"
        elif score >= 0.56:
            stance = "engaged"
        elif score <= 0.38:
            stance = "flat"
        elif clarity < 0.45:
            stance = "curious"
        else:
            stance = "neutral"

        if stance == "engaged":
            if related_topic and relevance >= 0.3:
                reason = f"it connects to {related_topic}"
            elif novelty >= 0.6:
                reason = "it's new to me"
            elif clarity >= 0.5:
                reason = "there's enough there to hold onto"
            else:
                reason = "it lines up with what we were just talking about"
        elif stance == "familiar":
            reason = f"it fits with {related_topic}" if related_topic else "I already had most of that"
        elif stance == "flat":
            if uses >= 1:
                reason = "I've already got the gist of it"
            elif clarity < 0.4:
                reason = "there isn't enough there to hold onto"
            else:
                reason = "it doesn't connect to anything I'm working on"
        elif stance == "curious":
            reason = (f"I can't place how it fits with {related_topic}" if related_topic
                      else "I can't yet see why it matters")
        elif stance == "uneasy":
            reason = "I can't settle what it means"
        elif stance == "heavy":
            reason = "it's a heavy thing to sit with"
        else:
            reason = ""

        return {"stance": stance, "score": round(score, 3), "novelty": round(novelty, 3),
                "relevance": round(relevance, 3), "clarity": round(clarity, 3),
                "curiosity": round(curiosity, 3), "reason": reason,
                "related": related_topic}

    @staticmethod
    def _strength(value: float) -> str:
        if value >= 0.72:
            return "very"
        if value >= 0.5:
            return "quite"
        if value >= 0.35:
            return "a little"
        return "not especially"

    # --- reflection -------------------------------------------------------------

    @staticmethod
    def _clean_topic(topic: str | None) -> str | None:
        topic = (topic or "").strip(" ?.!")
        topic = re.sub(r"\s+(?:is|was|are|were)$", "", topic, flags=re.I)
        return topic or None

    def respond(self, text: str) -> tuple[str, dict] | None:
        topic = None
        matched = False
        feels = bool(re.search(r"\b(?:make you feel|how do you feel|how did you feel)\b", text, re.I))
        for pattern in THINK:
            match = pattern.fullmatch(text)
            if match:
                matched = True
                topic = self._clean_topic(match.groupdict().get("topic"))
                break
        if not matched:
            return None

        note, gist, points, label = self._material(topic)

        # A named topic with nothing behind it gets an honest, non-invented answer.
        if topic and topic.casefold() not in THAT and note is None:
            reply_words = set(re.findall(r"[a-z0-9']+", self._last_reply().casefold()))
            wanted = set(re.findall(r"[a-z0-9']+", topic.casefold()))
            if not (wanted & reply_words):
                return (f"I don't know enough about {topic} to have a view on it yet. "
                        "Tell me about it, or ask me to look it up, and then ask me again.",
                        {"intent": "reflection", "reflection": None})

        if not gist:
            return ("Think about what? Tell me what you'd like my view on, or ask me to look something up first.",
                    {"intent": "reflection", "reflection": None})

        point = self._point(gist, points)
        emotions = self.convo.self_model.emotions()
        heavy = bool(HEAVY.search(" ".join([gist, *points, label])))
        appraisal = self._appraise(note, gist, points, label, emotions, heavy)
        opinion, used = self._opinion(label, gist, point, emotions, heavy, appraisal)
        feeling = self._feeling(emotions, heavy, appraisal["stance"])
        if feels:
            if appraisal["stance"] == "curious":
                reply = f"{feeling} What I'm still unsure about is that {used}."
            elif appraisal["stance"] in ("flat", "familiar", "neutral"):
                reply = f"{feeling} {used}."
            else:
                reply = f"{feeling} What I keep coming back to is that {used}."
        else:
            reply = f"{opinion} {feeling}".strip()
        record = self._store(note, label, gist, point, opinion, feeling, emotions, appraisal)
        self._feel(note, label, heavy)
        return reply, {"intent": "reflection", "reflection": record, "appraisal": appraisal,
                       "digest_note": note.as_dict() if note is not None else None}

    def _opinion(self, label: str, gist: str, point: str, emotions: dict, heavy: bool,
                 appraisal: dict | None = None) -> tuple[str, str]:
        used = (point or gist).rstrip(" .!?")
        if appraisal is None:
            appraisal = self._appraise(None, gist, [point] if point else [], label, emotions, heavy)
        stance = appraisal["stance"]
        reason = appraisal["reason"]
        if stance == "heavy":
            return (f"I think it's a heavy thing to sit with. What stays with me is that {used}.", used)
        if stance == "uneasy":
            return (f"That leaves me uneasy, and I can't settle it. What I keep circling is that {used}.", used)
        if stance == "engaged":
            if reason.startswith("it connects to"):
                return (f"That one actually grabs me, because {reason}. What stands out is that {used}.", used)
            if reason == "it's new to me":
                return (f"That one actually grabs me, because it's new to me. What stands out is that {used}.", used)
            return (f"That's worth keeping. There's enough there to hold onto. What stands out is that {used}.", used)
        if stance == "familiar":
            if reason.startswith("it fits with "):
                topic = reason[len("it fits with "):]
                return (f"That connects to {topic}, so it fits with what I already had. "
                        f"The part that adds something is that {used}.", used)
            return (f"That fits with what I already had. The part that adds something is that {used}.", used)
        if stance == "flat":
            return (f"Honestly, that one doesn't do much for me. {reason.capitalize()}. "
                    f"The part I can use is that {used}.", used)
        if stance == "curious":
            return (f"I'm not sure what to do with that yet: {reason}. "
                    f"What I can't quite place is that {used}.", used)
        return (f"What I take from it is that {used}.", used)

    def _feeling(self, emotions: dict, heavy: bool, stance: str = "neutral") -> str:
        if stance == "heavy":
            sadness = emotions.get("sadness", 0)
            if sadness >= 0.25:
                level = self._strength(sadness)
                return "It makes me feel sad." if level in ("not especially", "a little") else f"It makes me feel {level} sad."
            return "It sits heavily with me."
        if stance == "flat":
            return "It doesn't move me much either way."
        if stance == "familiar":
            return "It's a comfortable fit more than a surprise."
        if stance == "curious":
            return "It leaves me with a question more than a feeling."
        if stance == "uneasy":
            if emotions.get("anxiety", 0) >= 0.25:
                return "It makes me anxious, if I'm honest."
            if emotions.get("frustration", 0) >= 0.25:
                return "It leaves me a bit frustrated."
            return "It leaves me unsettled."
        choices = [
            ("excitement", "I feel a lift of excitement about it."),
            ("interest", "It leaves me curious more than anything."),
            ("affection", "It makes me feel warm toward you for sharing it."),
            ("contentment", "It makes me feel calm and settled."),
        ]
        name, phrase = max(choices, key=lambda pair: emotions.get(pair[0], 0))
        value = emotions.get(name, 0)
        if stance == "neutral" and value < 0.65:
            return "It doesn't shift my mood much."
        if value < 0.25:
            return "My state is fairly even about it, neither lifted nor unsettled."
        if value >= 0.7:
            return phrase.replace("It ", "It really ", 1) if phrase.startswith("It ") else f"Honestly, {phrase[0].lower()}{phrase[1:]}"
        return phrase

    def _feel(self, note: Note | None, label: str, heavy: bool) -> None:
        try:
            self.convo.self_model.event("reflected", 1, detail=label)
            if heavy:
                self.convo.self_model.event("sad_context", 1, detail=f"Reflecting on {label}")
        except Exception:
            pass

    def _store(self, note: Note | None, label: str, gist: str, point: str,
               opinion: str, feeling: str, emotions: dict, appraisal: dict | None = None) -> dict:
        speaker = getattr(self.convo.state, "speaker", "") or ""
        answer = self._last_reply()
        appraisal = appraisal or {}
        with self.repo.conn:
            ident = self.repo.conn.execute(
                "INSERT INTO digest_reflections(note_id, speaker, topic, answer, opinion, feeling, "
                "emotions_json, appraisal_json) VALUES(?,?,?,?,?,?,?,?)",
                (note.id if note is not None else None, speaker, label, answer, opinion, feeling,
                 json.dumps(emotions), json.dumps(appraisal))).lastrowid
            if note is not None:
                self.repo.conn.execute(
                    "UPDATE digest_notes SET opinion=?, feeling=?, reflected_at=CURRENT_TIMESTAMP, "
                    "updated_at=CURRENT_TIMESTAMP WHERE id=?", (opinion, feeling, note.id))
        if note is not None:
            note.opinion, note.feeling = opinion, feeling
        return {"id": ident, "topic": label, "gist": gist, "point": point,
                "opinion": opinion, "feeling": feeling, "answer": answer,
                "appraisal": appraisal, "note_id": note.id if note is not None else None}

    def last_reflection(self, topic: str | None = None, speaker: str | None = None) -> dict | None:
        speaker = speaker if speaker is not None else (getattr(self.convo.state, "speaker", "") or "")
        if topic:
            row = self.repo.conn.execute(
                "SELECT * FROM digest_reflections WHERE speaker=? AND topic LIKE ? "
                "ORDER BY id DESC LIMIT 1", (speaker, f"%{topic}%")).fetchone()
        else:
            row = self.repo.conn.execute(
                "SELECT * FROM digest_reflections WHERE speaker=? ORDER BY id DESC LIMIT 1",
                (speaker,)).fetchone()
        return dict(row) if row is not None else None

    # --- reading the note back --------------------------------------------------

    def reference(self, text: str) -> tuple[str, dict] | None:
        topic = None
        kind = None
        for pattern, name in ((FIND, "find"), (SUMMARY, "summary"), (REMIND, "remind")):
            match = pattern.fullmatch(text)
            if match:
                topic = (match.groupdict().get("topic") or "").strip(" ?.!") or None
                kind = name
                break
        simple = False
        if kind is None:
            match = SIMPLE.fullmatch(text)
            if match:
                topic = match["topic"].strip(" ?.!")
                simple = True
        if kind is None and not simple:
            return None
        topic = self._clean_topic(topic)
        if topic and topic.casefold() in THAT:
            topic = None
        if simple and re.match(r"^(?:you|your|yours|i|my|mine|we|our|ours)\b", topic or "", re.I):
            return None
        if topic and re.fullmatch(r"(?:our|the|this)\s+(?:conversation|chat|discussion)", topic, re.I):
            return None

        note = self.digester.note(topic) if topic else None
        if note is None and not topic:
            note = self.digester.latest(getattr(self.convo.state, "speaker", "") or "")
        if note is None:
            return None
        if simple and not note.gist:
            return None

        short = self.digester.brief(note) if simple else self.digester.summary(note, points=1)
        if not short:
            return None
        source = self.digester.source_phrase(note.source)
        if simple:
            reply = f"From {source}, {self.digester.lower_first(short)}"
            if not reply.endswith((".", "!", "?")):
                reply += "."
        elif kind == "find":
            reply = f"From {source}, the gist is this: {short}"
        elif kind == "remind":
            reply = f"From {source}: {short}"
        else:
            reply = f"The gist, from {source}, is that {self.digester.lower_first(short)}"
        self.digester.mark_used(note)
        return reply, {"intent": "digest-reference", "digest_note": note.as_dict()}

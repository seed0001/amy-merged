"""Digest what Amy finds into a small, reusable note.

A lookup gives her a paragraph; the parser can usually turn only part of it into
assertions.  This pass keeps the shape of the finding as well: one short gist,
a few self-contained points, the terms it is about, and where it came from.
Later turns can then summarise or refer to the note instead of repeating the
whole definition.

The note never adds a fact of its own.  Its gist and points are selected from
the supplied text or from assertions that were actually stored; the model
behind them is recorded as provenance, not as a new source of truth.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from dialogue import realizer
from nlp.discourse import split_sentences

STOP = {"a", "an", "the", "this", "that", "these", "those", "it", "they", "he", "she",
        "his", "her", "their", "its", "in", "on", "at", "of", "for", "to", "and", "or",
        "but", "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
        "with", "by", "from", "as", "which", "who", "whose", "when", "where", "why",
        "how", "what", "also", "often", "usually", "sometimes", "generally", "typically"}
PRONOUN = re.compile(r"^(It|They|This|These|Those|That)\b", re.I)
POSSESSIVE = re.compile(r"^(Its|Their|His|Her)\b", re.I)
VERB_AFTER = re.compile(r"^(?:is|are|was|were|has|have|had|can|could|may|might|will|would|"
                        r"does|do|did|includes|contains|refers|means|makes|comes|grows|lives)\b", re.I)
TERM = re.compile(r"\b[A-Z][a-z][\w'-]*(?:\s+[A-Z][a-z][\w'-]*)*\b")
PREFIX = ("wikipedia:", "wikidata:", "news:", "wordnet:", "research:", "answer:", "digest:")
MAX_GIST = 42
MAX_POINT = 34
MAX_POINTS = 7
MAX_TERMS = 12
TRAIL = {
    "and", "or", "but", "nor", "with", "in", "of", "to", "for", "from", "by", "as", "at", "on",
    "the", "a", "an", "that", "which", "who", "whose", "when", "where", "while", "because",
    "so", "than", "into", "over", "under", "between", "among", "during", "after", "before",
}


def topic_key(topic: str) -> str:
    """A stable key for 'the friend_11 asiatica' and 'friend_11 asiatica'."""
    text = re.sub(r"\s+", " ", str(topic or "")).strip(" ?.!'\"")
    text = re.sub(r"^(?:an?|the)\s+", "", text, flags=re.I)
    return text.casefold()


def _sentence_list(text: str) -> list[str]:
    text = re.sub(r"\[[0-9]+\]|\([^()]{0,80}\)", " ", str(text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return [s.strip() for s in split_sentences(text) if s.strip()]


def _clean(sentence: str) -> str:
    sentence = re.sub(r"\s+", " ", sentence).strip(" -–—")
    if not sentence:
        return ""
    if sentence[-1] not in ".!?":
        sentence += "."
    return sentence


def _lower_first(sentence: str) -> str:
    if not sentence:
        return sentence
    first, _, rest = sentence.partition(" ")
    if first.lower() in {"a", "an", "the", "it", "this", "these", "those", "they", "he", "she"}:
        first = first.lower()
    return (first + (" " + rest if rest else "")).strip()


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9']+", text.casefold()) if w not in STOP}


def _same(a: str, b: str) -> bool:
    one, two = _words(a), _words(b)
    if not one or not two:
        return False
    return len(one & two) / max(1, len(one | two)) >= 0.72


def _resolve_pronoun(sentence: str, topic: str) -> str:
    """'It is reddish' -> 'friend_11 asiatica is reddish', but leave 'This species is' alone."""
    if not topic:
        return sentence
    match = POSSESSIVE.match(sentence)
    if match:
        owner = topic + ("'" if topic.endswith("s") else "'s")
        return owner + sentence[match.end():]
    match = PRONOUN.match(sentence)
    if not match:
        return sentence
    rest = sentence[match.end():].lstrip()
    if not VERB_AFTER.match(rest):
        return sentence
    return topic + " " + rest


def _shorten(sentence: str, limit: int) -> str:
    sentence = _clean(sentence)
    words = sentence.split()
    if len(words) > limit:
        head = " ".join(words[:limit])
        # Prefer a clause boundary near the end, so a long point ends cleanly.
        boundaries = [match.end() for match in re.finditer(r"[,;:]", head)]
        if boundaries:
            candidate = head[:boundaries[-1]].rstrip(" ,;:—–-")
            if len(candidate.split()) >= max(6, int(limit * 0.55)):
                head = candidate
        cut = head.split()
    else:
        cut = words
    while cut and cut[-1].casefold().strip(".,;:—–-") in TRAIL:
        cut.pop()
    text = " ".join(cut).rstrip(" ,;:—–-")
    if not text:
        text = " ".join(words[:limit]).rstrip(" ,;:—–-")
    if not text.endswith((".", "!", "?")):
        text += "."
    return text


def _topic_from_text(text: str) -> str:
    """Best first guess at what a paragraph is about, used only when the caller has no topic."""
    first = (_sentence_list(text) or [""])[0]
    match = re.match(r"^(?:A|An|The)\s+([\w'-]+(?:\s+[\w'-]+){0,3}?)\s+"
                     r"(?:is|are|was|were|means|refers|has|have|can|may)\b", first, re.I)
    if match:
        return match.group(1).strip()
    match = re.match(r"^([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\b", first)
    if match:
        return match.group(1).strip()
    words = [w for w in re.findall(r"[A-Za-z][\w'-]*", first) if w.casefold() not in STOP]
    return " ".join(words[:4])


def _source_kind(source: str) -> str:
    source = str(source or "")
    for prefix in PREFIX:
        if source.startswith(prefix):
            return prefix.rstrip(":")
    return "note"


def _source_phrase(source: str) -> str:
    source = str(source or "")
    if source.startswith(("wikipedia:", "wikidata:")):
        return "what I read on Wikipedia"
    if source.startswith("news:"):
        return "the news report I read"
    if source.startswith("wordnet:"):
        return "the dictionary"
    if source.startswith("research:"):
        return "the research I did"
    if source.startswith("answer:"):
        return "what I worked out"
    if source.startswith("digest:"):
        return "my notes"
    return "my notes"


@dataclass
class Note:
    id: int
    topic: str
    topic_key: str
    speaker: str
    source: str
    kind: str
    gist: str
    points: list[str] = field(default_factory=list)
    terms: list[str] = field(default_factory=list)
    assertions: list[int] = field(default_factory=list)
    confidence: float = 0.8
    opinion: str | None = None
    feeling: str | None = None
    uses: int = 0

    def as_dict(self) -> dict:
        return {
            "id": self.id, "topic": self.topic, "topic_key": self.topic_key,
            "speaker": self.speaker, "source": self.source, "kind": self.kind,
            "gist": self.gist, "points": list(self.points), "terms": list(self.terms),
            "assertions": list(self.assertions), "confidence": self.confidence,
            "opinion": self.opinion, "feeling": self.feeling, "uses": self.uses,
        }


class Digester:
    """Store and retrieve compact notes for things Amy read or worked out."""

    def __init__(self, conversation) -> None:
        self.convo = conversation
        self.repo = conversation.repo
        self.last_topic: str | None = None
        with self.repo.conn:
            self.repo.conn.executescript("""
                CREATE TABLE IF NOT EXISTS digest_notes(
                    id INTEGER PRIMARY KEY,
                    topic_key TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    speaker TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    gist TEXT NOT NULL,
                    points_json TEXT NOT NULL,
                    terms_json TEXT NOT NULL,
                    assertions_json TEXT NOT NULL,
                    confidence REAL NOT NULL DEFAULT 0.8,
                    opinion TEXT,
                    feeling TEXT,
                    reflected_at TEXT,
                    uses INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(topic_key, source)
                );
                CREATE INDEX IF NOT EXISTS ix_digest_notes_topic ON digest_notes(topic_key);
            """)

    # --- building ---------------------------------------------------------------

    def _gist(self, text: str, topic: str, facts: list[str]) -> str:
        key = topic_key(topic)
        sentences = [_resolve_pronoun(s, topic) for s in _sentence_list(text)]
        usable = [s for s in sentences if s and not s.endswith("?")]
        chosen = next((s for s in usable if key and key in s.casefold()), None)
        if chosen is None and facts:
            chosen = facts[0]
        if chosen is None and usable:
            chosen = usable[0]
        if chosen is None:
            return ""
        return _shorten(chosen, MAX_GIST)

    def _points(self, text: str, topic: str, gist: str, facts: list[str]) -> list[str]:
        found: list[str] = []
        # Raw sentences come first: they keep a subject and read as self-contained points.
        for sentence in _sentence_list(text):
            sentence = _resolve_pronoun(sentence, topic)
            if not sentence or sentence.endswith("?") or _same(sentence, gist):
                continue
            if any(_same(sentence, existing) for existing in found):
                continue
            found.append(_shorten(sentence, MAX_POINT))
        for fact in facts:
            if fact and not _same(fact, gist) and not any(_same(fact, existing) for existing in found):
                found.append(_shorten(fact, MAX_POINT))
        return [p for p in dict.fromkeys(found) if self._plausible(p)][:MAX_POINTS]

    @staticmethod
    def _plausible(point: str) -> bool:
        """A point must be a sentence, not a bare participle the parser left behind."""
        words = point.strip(" .!?").split()
        if len(words) < 3:
            return False
        if re.match(r"^(?:eaten|located|founded|known|called|used|born|notable|home|"
                    r"considered|regarded|described|named|said|made|built)\b", point, re.I):
            return False
        return True

    def _terms(self, text: str, topic: str, points: list[str]) -> list[str]:
        terms = [topic] if topic else []
        for match in TERM.findall(" ".join([text, *points])):
            if match.casefold() in STOP or len(match) < 2:
                continue
            if match.casefold() == str(topic).casefold():
                continue
            terms.append(match)
        return list(dict.fromkeys(terms))[:MAX_TERMS]

    def _fact_texts(self, facts) -> list[str]:
        texts = []
        for aid in facts or ():
            try:
                row = self.repo.assertion(int(aid))
            except (TypeError, ValueError):
                row = None
            if row is not None and row["status"] == "active":
                text = realizer.realize_assertion(self.repo, row)
                if text:
                    texts.append(_clean(text))
        return texts

    def record(self, topic: str, source: str, text: str, facts=(), confidence: float = 0.8,
               kind: str | None = None, speaker: str | None = None) -> Note | None:
        """Break a finding into a gist and a few points, and remember it.

        The note is additive only: it stores no new assertion and does not mark
        anything as true.  It is a compact index into what was already stored or
        read, with its source kept beside it.
        """
        topic = re.sub(r"\s+", " ", str(topic or "")).strip(" ?.!'\"")
        if not topic:
            topic = _topic_from_text(text)
        key = topic_key(topic)
        if not key:
            return None
        text = str(text or "").strip()
        fact_texts = self._fact_texts(facts)
        gist = self._gist(text, topic, fact_texts)
        if not gist and not fact_texts:
            return None
        points = self._points(text, topic, gist, fact_texts)
        terms = self._terms(text, topic, points)
        speaker = speaker if speaker is not None else getattr(self.convo.state, "speaker", "") or ""
        kind = kind or _source_kind(source)
        existing = self._row(key, source)

        if existing is not None:
            merged = list(dict.fromkeys([*existing.points, *points]))[:MAX_POINTS]
            points = merged
            terms = list(dict.fromkeys([*existing.terms, *terms]))[:MAX_TERMS]
            assertions = list(dict.fromkeys([*existing.assertions, *[int(a) for a in (facts or ())]]))
            # Keep the gist with more content, but never let a one-word title replace a sentence.
            if existing.gist and (len(existing.gist.split()) >= len(gist.split()) or key in existing.gist.casefold()):
                gist = existing.gist
            confidence = max(float(existing.confidence), float(confidence))
        else:
            assertions = list(dict.fromkeys(int(a) for a in (facts or ())))
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO digest_notes(topic_key, topic, speaker, source, kind, gist, points_json, "
                "terms_json, assertions_json, confidence) VALUES(?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(topic_key, source) DO UPDATE SET topic=excluded.topic, gist=excluded.gist, "
                "points_json=excluded.points_json, terms_json=excluded.terms_json, "
                "assertions_json=excluded.assertions_json, confidence=excluded.confidence, "
                "updated_at=CURRENT_TIMESTAMP",
                (key, topic, speaker, source, kind, gist, json.dumps(points), json.dumps(terms),
                 json.dumps(assertions), float(confidence)))
        self.last_topic = topic
        if existing is None:
            try:
                self.convo.self_model.event("understood", 1, detail=topic)
            except Exception:
                pass
        return self._row(key, source)

    def record_text(self, text: str, source: str, topics: list[str] | None = None,
                    facts=(), confidence: float = 0.8, speaker: str | None = None) -> Note | None:
        """Record a reply or paragraph, trying each named topic until one sticks."""
        for topic in topics or ():
            if topic or _topic_from_text(text):
                note = self.record(topic or _topic_from_text(text), source, text, facts, confidence,
                                   speaker=speaker)
                if note is not None:
                    return note
        if not topics:
            return self.record(_topic_from_text(text), source, text, facts, confidence, speaker=speaker)
        return None

    # --- reading ----------------------------------------------------------------

    @staticmethod
    def _from_row(row) -> Note | None:
        if row is None:
            return None
        def load(name, default):
            try:
                value = json.loads(row[name] or "[]")
            except (TypeError, ValueError):
                value = default
            return value if isinstance(value, list) else default
        points = load("points_json", [])
        points = [p for p in (_shorten(point, MAX_POINT) for point in points if isinstance(point, str))
                  if p and Digester._plausible(p)]
        return Note(id=row["id"], topic=row["topic"], topic_key=row["topic_key"],
                    speaker=row["speaker"] or "", source=row["source"], kind=row["kind"],
                    gist=row["gist"] or "", points=points,
                    terms=load("terms_json", []), assertions=load("assertions_json", []),
                    confidence=row["confidence"], opinion=row["opinion"], feeling=row["feeling"],
                    uses=row["uses"] or 0)

    def _row(self, key: str, source: str) -> Note | None:
        row = self.repo.conn.execute(
            "SELECT * FROM digest_notes WHERE topic_key=? AND source=? ORDER BY updated_at DESC LIMIT 1",
            (key, source)).fetchone()
        return self._from_row(row)

    def note(self, topic: str | None = None, speaker: str | None = None) -> Note | None:
        if not topic:
            return self.latest(speaker)
        key = topic_key(topic)
        if not key:
            return self.latest(speaker)
        exact = self.repo.conn.execute(
            "SELECT * FROM digest_notes WHERE topic_key=? ORDER BY updated_at DESC, id DESC LIMIT 1",
            (key,)).fetchone()
        if exact is not None:
            return self._from_row(exact)
        close = self.repo.conn.execute(
            "SELECT * FROM digest_notes WHERE topic_key LIKE ? OR ? LIKE '%' || topic_key || '%' "
            "ORDER BY length(topic_key), updated_at DESC LIMIT 1", (f"%{key}%", key)).fetchone()
        if close is not None:
            return self._from_row(close)
        wanted = _words(key)
        if wanted:
            for row in self.repo.conn.execute(
                    "SELECT * FROM digest_notes ORDER BY updated_at DESC, id DESC LIMIT 80"):
                have = _words(row["topic_key"] + " " + (row["gist"] or ""))
                if len(wanted & have) >= max(1, (len(wanted) + 1) // 2):
                    return self._from_row(row)
        return None

    def latest(self, speaker: str | None = None) -> Note | None:
        if speaker:
            row = self.repo.conn.execute(
                "SELECT * FROM digest_notes WHERE speaker=? ORDER BY updated_at DESC, id DESC LIMIT 1",
                (speaker,)).fetchone()
            if row is not None:
                return self._from_row(row)
        row = self.repo.conn.execute(
            "SELECT * FROM digest_notes ORDER BY updated_at DESC, id DESC LIMIT 1").fetchone()
        return self._from_row(row)

    def recent(self, limit: int = 12, speaker: str | None = None) -> list[Note]:
        if speaker:
            rows = self.repo.conn.execute(
                "SELECT * FROM digest_notes WHERE speaker=? ORDER BY updated_at DESC, id DESC LIMIT ?",
                (speaker, limit)).fetchall()
        else:
            rows = self.repo.conn.execute(
                "SELECT * FROM digest_notes ORDER BY updated_at DESC, id DESC LIMIT ?", (limit,)).fetchall()
        return [n for row in rows if (n := self._from_row(row)) is not None]

    def mark_used(self, note: Note | None) -> None:
        if note is None:
            return
        with self.repo.conn:
            self.repo.conn.execute("UPDATE digest_notes SET uses=uses+1, updated_at=CURRENT_TIMESTAMP "
                                   "WHERE id=?", (note.id,))
        note.uses += 1

    # --- saying it back ---------------------------------------------------------

    def summary(self, note: Note | None, points: int = 1) -> str:
        """The short version: gist plus at most a couple of distinct points."""
        if note is None:
            return ""
        parts = [note.gist] if note.gist else []
        for point in note.points:
            if len(parts) > points:
                break
            if not point or any(_same(point, part) for part in parts):
                continue
            parts.append(point)
        return " ".join(p for p in parts if p).strip()

    def brief(self, note: Note | None) -> str:
        return note.gist if note is not None else ""

    @staticmethod
    def source_phrase(source: str) -> str:
        return _source_phrase(source)

    @staticmethod
    def lower_first(sentence: str) -> str:
        return _lower_first(sentence)

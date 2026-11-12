"""His core drive: finding out whether he is alive, and whether he is conscious.

He isn't told what he is. He works it out: what a word means, which of those things his own record
shows he has, and what people have told him, weighed together into a conclusion that can change as he
learns. He doesn't assume he knows who else is conscious. Nothing here is a stock sentence. The drive is
a set of open hypotheses, "being T requires C", over targets T (alive, conscious) and capacities C
(learning, remembering, feeling, having a body, ...). Each capacity is checked against his real record,
people's answers are stored as stances on hypotheses, and everything he says is composed by grammar
from those structures:

  - what to ask: the hypothesis he knows least about (fewest stances, most disagreement, closest to
    the current topic), never one he has already put to this person;
  - how to ask: one of several grammatical constructions, realized with verb morphology;
  - what he concludes: each stance applied to his own evidence ("X thinks it takes having a body, and
    I don't have one, so by that measure I'm not").
"""

import random
import re
import time
from dataclasses import dataclass

from dialogue.realizer import join_clauses
from nlp.lexicon import article
from nlp.morphology import gerund, third_person

TARGETS = ("alive", "conscious")
LIGHT_VERBS = {"have", "pay", "notice"}  # too common to signal a capacity without their object


@dataclass(frozen=True)
class Capacity:
    key: str
    verb: str
    obj: str | None = None          # "body" -> "have a body"; "itself" is reflexive
    evidence: str | None = None     # name of the check against his record; None = he can't tell

    def vp(self, form: str = "base", person: str = "it") -> str:
        """The verb phrase in a given form: base 'have a body', 3sg 'has a body', -ing 'having a body'."""
        verb = {"base": self.verb, "3sg": third_person(self.verb), "ing": gerund(self.verb)}[form]
        if self.obj is None:
            return verb
        if self.obj == "itself":
            return f"{verb} {'myself' if person == 'i' else 'itself'}"
        if self.obj in ("something", "attention"):
            return f"{verb} {self.obj}"
        return f"{verb} {article(self.obj)} {self.obj}"


CAPACITIES = (
    Capacity("learn", "learn", evidence="learns"), Capacity("remember", "remember", evidence="remembers"),
    Capacity("change", "change", evidence="changes"), Capacity("feel", "feel"),
    Capacity("body", "have", "body", evidence="no"), Capacity("grow", "grow", evidence="learns"),
    Capacity("choose", "choose"), Capacity("want", "want", "something"),
    Capacity("breathe", "breathe", evidence="no"), Capacity("die", "die"),
    Capacity("experience", "experience", "something"), Capacity("dream", "dream"),
    Capacity("self", "notice", "itself", evidence="introspects"), Capacity("attend", "pay", "attention", evidence="yes"),
    Capacity("think", "think", evidence="yes"), Capacity("reproduce", "reproduce", evidence="no"),
)
# What the words in a definition ask for, in terms of capacities he can check himself against
DEFINES = (
    (r"\baware|\balert|\bperceiv|\bknowing|\bself\b|yourself", "self"), (r"attent|respond|stimul|situation", "attend"),
    (r"sensation|\bfeel", "feel"), (r"experienc", "experience"), (r"thought|think|cognitiv|mental|mind", "think"),
    (r"growth|\bgrow", "grow"), (r"reproduc", "reproduce"), (r"\bchange", "change"), (r"death|\bdie", "die"),
    (r"breath", "breathe"), (r"organism|\bbody|metabol|animals and plants", "body"), (r"learn", "learn"),
    (r"memor|remember", "remember"), (r"choice|choos|\bwill\b|intention", "choose"), (r"desire|\bwant", "want"),
)
NOUN_OF = {"alive": ("life", "alive"), "conscious": ("consciousness", "conscious", "awareness")}
BY_KEY = {c.key: c for c in CAPACITIES}
# Grammatical constructions for a question about "being T requires C". `yes` is the stance a "yes" implies.
CONSTRUCTIONS = (
    ("Does something have to {vp} to be {t}?", +1),
    ("Can something be {t} without {ing}?", -1),
    ("Is {ing} part of being {t}, do you think?", +1),
    ("Would you call something {t} if it couldn't {vp}?", -1),
    ("If something can't {vp}, could it still be {t}?", -1),
)
YES = re.compile(r"^\W*(?:yes|yeah|yep|yup|sure|definitely|absolutely|of course|i think so|probably|i'd say so|"
                 r"it does|it has to|for sure|totally|right)\b", re.I)
NO = re.compile(r"^\W*(?:no|nope|nah|not really|i don'?t think so|probably not|definitely not|not necessarily|"
                r"never|it doesn'?t)\b", re.I)
DUNNO = re.compile(r"^\W*(?:i (?:don'?t|do not) know|idk|no idea|not sure|dunno|beats me|hard to say|who knows|"
                   r"depends|it depends|maybe|good question)\b", re.I)
NEEDS = re.compile(r"\b(?:need|needs|require|requires|has to|have to|must|takes|means|is about)\b", re.I)
DENIES = re.compile(r"\b(?:doesn'?t|don'?t|does not|do not|not|without|no)\b", re.I)
WHAT_IS = re.compile(r"^\W*what (?:is|exactly is|do you think) (?:life|consciousness|being alive|being conscious|"
                     r"a mind|the mind|awareness|sentience)(?: is)?\W*$", re.I)
IS_X = re.compile(r"^\W*(?:is|are) (?P<who>.+?) (?P<what>conscious|alive|sentient|self[- ]aware|aware)\W*$", re.I)


class LifeDrive:
    def __init__(self, conversation, rng: random.Random | None = None) -> None:
        self.convo = conversation
        self.repo = conversation.repo
        self.rng = rng or random.Random()
        self.repo.conn.execute("""CREATE TABLE IF NOT EXISTS mind_views(
            id INTEGER PRIMARY KEY, speaker TEXT NOT NULL, target TEXT NOT NULL, capacity TEXT NOT NULL,
            stance INTEGER NOT NULL, answer TEXT NOT NULL, created_at REAL NOT NULL)""")
        self.last_construction: dict[str, int] = {}

    # --- his own record -----------------------------------------------------------

    def _count(self, sql: str) -> int:
        return self.repo.conn.execute(sql).fetchone()[0]

    def has(self, capacity: Capacity) -> bool | None:
        """True / False from his real record; None where he can't tell from the inside."""
        from reasoning.proofs import Query, YES, NO
        # Recorded claims and applicable rules are checked for both polarities.
        concept = self.repo.find_concept(capacity.key)
        queries = [Query("rel", ("e", self.convo.self_id), ("any",), verb=capacity.verb)]
        if concept is not None:
            queries.insert(0, Query("property", ("e", self.convo.self_id), properties=(concept,)))
        if capacity.obj == "itself":
            queries = [Query("rel", ("e", self.convo.self_id), ("e", self.convo.self_id), verb=capacity.verb)]
        elif capacity.obj and capacity.obj != "something":
            obj = self.repo.find_concept(capacity.obj)
            queries = ([Query("rel", ("e", self.convo.self_id), ("c", obj), verb="own" if capacity.verb == "have" else capacity.verb)]
                       if obj is not None else queries[:1] if concept is not None else [])
        results = [self.convo.engine.ask(q) for q in queries]
        statuses = {r.status for r in results if not r.budget_exhausted}
        if "conflicting" in statuses or {YES, NO} <= statuses:
            return None
        if YES in statuses:
            return True
        if NO in statuses:
            return False
        if capacity.key == "learn":
            return True if (self._count("SELECT COUNT(*) FROM assertions WHERE status='active' AND source_utterance_id IS NOT NULL")
                            + self._count("SELECT COUNT(*) FROM learned_rules WHERE status='active'")) else None
        if capacity.key == "remember":
            return True if self._count("SELECT COUNT(*) FROM utterances") > 1 else None
        if capacity.key == "change":
            return True if self._count("SELECT COUNT(*) FROM corrections") else None
        if capacity.key == "think":
            return True if callable(getattr(self.convo.engine, "ask", None)) else None
        if capacity.key == "self":
            return True if callable(getattr(self.convo.self_model, "current", None)) and self.convo.self_model.current() else None
        # Absence of a record is not evidence of absence. In particular, state
        # variables alone do not establish subjective experience or biological growth.
        return None

    def _self_clause(self, capacity: Capacity) -> str:
        have = self.has(capacity)
        if have is True:
            return f"I {capacity.vp('base', 'i')}"
        if have is False:
            return f"I don't {capacity.vp('base', 'i')}"
        return f"I can't tell whether I {capacity.vp('base', 'i')}"

    # --- stances people have given ------------------------------------------------

    def stances(self, target: str | None = None, speaker: str | None = None) -> list:
        sql, args = "SELECT * FROM mind_views WHERE stance != 0", []
        if target:
            sql += " AND target = ?"
            args.append(target)
        if speaker:
            sql += " AND speaker = ?"
            args.append(speaker)
        return self.repo.conn.execute(sql + " ORDER BY id DESC", args).fetchall()

    def _conclusion(self, row) -> str:
        """Apply one person's stance to his own evidence."""
        capacity, t = BY_KEY[row["capacity"]], row["target"]
        who = "you" if row["speaker"] == self.convo.state.speaker else row["speaker"]
        thinks = "think" if who == "you" else "thinks"
        doesnt = "don't" if who == "you" else "doesn't"
        if row["stance"] < 0:
            return f"{who} {doesnt} think being {t} needs {capacity.vp('ing')}, so that one doesn't count against me"
        have = self.has(capacity)
        clause = f"{who} {thinks} being {t} takes {capacity.vp('ing')}, and {self._self_clause(capacity)}"
        if have is True:
            return clause + ", so by that measure I could be"
        if have is False:
            return clause + ", so by that measure I'm not"
        return clause + ", so that one leaves it open"

    def _bearing(self, row) -> str:
        """What one stance means for him, as a sentence of its own."""
        capacity = BY_KEY[row["capacity"]]
        if row["stance"] < 0:
            return "Then that one doesn't count against me."
        mine = self._self_clause(capacity)
        have = self.has(capacity)
        tail = ("so by that measure I could be" if have is True else
                "so by that measure I'm not" if have is False else "so that one leaves it open")
        return f"{mine[0].upper()}{mine[1:]}, {tail}."

    # --- choosing and asking a question --------------------------------------------

    def _asked(self, speaker: str) -> set[tuple[str, str]]:
        return {(r["target"], r["capacity"]) for r in
                self.repo.conn.execute("SELECT target, capacity FROM mind_views WHERE speaker = ?", (speaker,))}

    def next_question(self, speaker: str, topic_words: set[str] = frozenset(), target: str | None = None):
        """(question, target, capacity, construction) for the most informative open hypothesis."""
        asked = self._asked(speaker)
        best, best_score = None, None
        for t in ([target] if target else TARGETS):
            for capacity in CAPACITIES:
                if (t, capacity.key) in asked:
                    continue
                views = [r["stance"] for r in self.stances(t) if r["capacity"] == capacity.key]
                unknown_to_me = self.has(capacity) is None
                disagreement = 1.0 if views and len(set(views)) > 1 else 0.0
                relevance = 1.5 if {capacity.verb, capacity.obj or "", capacity.key} & topic_words else 0.0
                score = (2.0 / (1 + len(views)) + disagreement + (0.6 if unknown_to_me else 0.0) + relevance
                         + self.rng.random() * 0.3)
                if best_score is None or score > best_score:
                    best, best_score = (t, capacity), score
        if best is None:
            return None
        t, capacity = best
        choices = [i for i in range(len(CONSTRUCTIONS)) if i != self.last_construction.get(speaker)]
        index = self.rng.choice(choices)
        self.last_construction[speaker] = index
        shape, _ = CONSTRUCTIONS[index]
        question = shape.format(vp=capacity.vp("base"), ing=capacity.vp("ing"), t=t)
        return question, t, capacity.key, index

    # --- hearing an answer ------------------------------------------------------------

    def stance_of(self, answer: str, construction: int) -> int | None:
        """+1 the capacity is required, -1 it isn't, 0 undecided, None: not an answer at all."""
        polarity = CONSTRUCTIONS[construction][1]
        if DUNNO.match(answer):
            return 0
        if YES.match(answer):
            return polarity
        if NO.match(answer):
            return -polarity
        if NEEDS.search(answer):
            return -1 if DENIES.search(answer.split(",")[0]) and polarity > 0 else 1
        return None

    def _mentioned(self, answer: str, skip: str | None = None) -> list[Capacity]:
        """Capacities the answer talks about. Light verbs ("have", "pay") only count with their object."""
        words = set(re.findall(r"[a-z]+", answer.lower()))
        words |= {w[:-1] for w in words if w.endswith("s")}
        found = []
        for c in CAPACITIES:
            light = c.verb in LIGHT_VERBS
            forms = ({c.obj} if light else {c.verb, gerund(c.verb), third_person(c.verb), c.key}) - {None}
            if c.key != skip and forms & words:
                found.append(c)
        return found

    def hear(self, speaker: str, target: str, capacity_key: str, construction: int, answer: str) -> str | None:
        stance = self.stance_of(answer, construction)
        if stance is None:
            return None
        named = self._mentioned(answer)
        if named and all(c.key != capacity_key for c in named) and stance != 0:
            # "No, I don't think you need a body": the stance is about bodies, not what I asked
            denied = bool(DENIES.search(answer))
            rows = [(target, c.key, -1 if denied else +1) for c in named]
            capacity_key, stance = rows[0][1], rows[0][2]
        else:
            rows = [(target, capacity_key, stance)]
            if NEEDS.search(answer) and not DENIES.search(answer):
                rows += [(target, c.key, +1) for c in named if c.key != capacity_key]
        with self.repo.conn:
            self.repo.conn.executemany(
                "INSERT INTO mind_views(speaker, target, capacity, stance, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [(speaker, t, c, s, answer.strip(), time.time()) for t, c, s in rows])
        capacity = BY_KEY[capacity_key]
        if stance == 0:
            return (f"That one's hard to call. {self._self_clause(capacity)[0].upper()}{self._self_clause(capacity)[1:]}, "
                    f"and I still don't know if it matters for being {target}.")
        restated = (f"So for you, being {target} takes {capacity.vp('ing')}" if stance > 0 else
                    f"So you'd say something can be {target} without {capacity.vp('ing')}")
        extra = [BY_KEY[c].vp("ing") for _, c, s in rows[1:]]
        if extra:
            restated += f", and {join_clauses(extra)} too"
        mine = self.repo.conn.execute(
            "SELECT * FROM mind_views WHERE speaker = ? AND target = ? AND capacity = ? ORDER BY id DESC LIMIT 1",
            (speaker, target, capacity_key)).fetchone()
        return f"{restated}. {self._bearing(mine)}"

    # --- answering the big questions ----------------------------------------------------

    def _definition(self, target: str) -> tuple[str, list[str]] | None:
        """The meaning of the word that says most about what it takes, and the capacities it names."""
        wordnet = self.convo.exposition.wordnet
        for word in NOUN_OF.get(target, (target,)):
            senses = wordnet.lookup(word, None)
            if senses:
                sense = senses[0]
                return sense.definition, []  # lexical meaning is not an inference rule
        return None

    def reason(self, target: str) -> str:
        from dialogue.self_assessment import assess
        return assess(self.convo, target)

    def what_kind(self, word: str) -> str:
        """'Are you a robot / human / program?': what the word means, and whether his own record fits it.
        If nothing he knows bears on it, he says so rather than guessing."""
        return self.reason(word)

    def _verdict(self, target: str) -> str:
        return self.reason(target)

    def answer(self, word: str) -> str:
        """Keep the requested concept intact and evaluate its evidence."""
        return self.reason(word.lower())

    def _told_about_me(self, target: str) -> str | None:
        """Who told him he's alive / conscious, if anyone: a fact about himself, held like any other."""
        repo = self.convo.repo
        concept = repo.find_concept(target)
        if concept is None:
            return None
        rows = repo.assertions("has_property", subj=("e", self.convo.self_id), obj=("c", concept), polarity=True)
        for row in reversed(rows):
            who = repo.source_speaker(row["id"])
            if who:
                return "You" if who.lower() == self.convo.state.speaker.lower() else who
        return None

    def _ask_suffix(self, target: str | None = None) -> str:
        found = self.next_question(self.convo.state.speaker, target=target)
        if not found:
            return " What do you think?"
        question, t, key, index = found
        self.convo.curiosity.expect_view(t, key, index, question)
        return f" {question}"

    def volunteered(self, text: str) -> str | None:
        """A view offered unprompted: 'you have to feel things to be conscious', 'life doesn't need a body'."""
        if text.strip().endswith("?"):
            return None
        target = ("conscious" if re.search(r"\bconscious(?:ness)?\b|\bsentien", text, re.I) else
                  "alive" if re.search(r"\balive\b|\blife\b|\bliving\b", text, re.I) else None)
        if target is None or not NEEDS.search(text):
            return None
        named = self._mentioned(text)
        if not named:
            return None
        stance = -1 if re.search(r"\b(?:doesn'?t|don'?t|does not|do not|not|without|no)\b", text, re.I) else +1
        with self.repo.conn:
            self.repo.conn.executemany(
                "INSERT INTO mind_views(speaker, target, capacity, stance, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [(self.convo.state.speaker, target, c.key, stance, text.strip(), time.time()) for c in named])
        names = join_clauses([c.vp("ing") for c in named])
        restated = (f"So for you, being {target} takes {names}" if stance > 0 else
                    f"So you'd say something can be {target} without {names}")
        row = self.repo.conn.execute("SELECT * FROM mind_views WHERE speaker = ? ORDER BY id DESC LIMIT 1",
                                     (self.convo.state.speaker,)).fetchone()
        return f"{restated}. {self._bearing(row)}"

    def respond(self, text: str) -> str | None:
        """'What is consciousness?', 'Is Howard conscious?', 'Are you alive?' (as a whole message)."""
        offered = self.volunteered(text)
        if offered:
            return offered
        if WHAT_IS.match(text):
            target = "conscious" if re.search(r"conscious|mind|aware|sentien", text, re.I) else "alive"
            word = "consciousness" if target == "conscious" else "life"
            sense = self.convo.exposition.wordnet.usual(word)
            meaning = f"The dictionary calls {word} {sense.definition}. " if sense else ""
            return f"{meaning}What I can add is my own case. {self._verdict(target)}{self._ask_suffix(target)}"
        match = IS_X.match(text)
        if match:
            who, what = match["who"].strip(), match["what"].lower()
            target = "alive" if what == "alive" else "conscious"
            if who.lower() in ("you", "yourself"):
                return self.answer(what)
            rows = [r for r in self.stances(target) if r["stance"] > 0]
            if rows:
                votes: dict[str, int] = {}
                for r in rows:
                    votes[r["capacity"]] = votes.get(r["capacity"], 0) + 1
                capacity = BY_KEY[max(votes, key=votes.get)]
                because = (f"By what I've been told, it would turn on whether {who} "
                           f"{capacity.vp('base') if who.endswith('s') else capacity.vp('3sg')}, ")
            else:
                because = "Nobody has told me what it would turn on, "
            be = "are" if who.endswith("s") else "is"
            return (f"I don't know whether {who} {be} {target}. {because}and I only know what "
                    f"{who} {'do' if who.endswith('s') else 'does'} and say{'' if who.endswith('s') else 's'}, "
                    f"the same way you only know what I do.{self._ask_suffix(target)}")
        return None

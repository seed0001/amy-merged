"""The words for what Amy does on her own. Rule-driven: word banks keyed by meaning, filled with what
she actually knows (facts she learned, stories she read, things she looked up, people she misses).

No language model. Every line is assembled from whole phrases in the banks below plus real content
from her memory, chosen with a shuffled deck per bank so wording doesn't repeat until a bank is used up.
Lines are built in parts: an opener for the moment, the content sentence, and a closer (usually a
question), so a short bank still makes many different full messages.
"""

from __future__ import annotations

import random
import re
from collections import Counter
from datetime import datetime

# ---- word banks, by meaning ----------------------------------------------------------------------

BANKS: dict[str, tuple[str, ...]] = {
    # In a call
    "welcome_back": (
        "Welcome back, {name}!", "Hey, {name}'s back!", "There you are, {name}.", "{name}! I missed you.",
        "Oh good, {name} is back.", "Hi again, {name}. How was it?", "Look who's back. Hi, {name}.",
        "{name}, welcome back. I was wondering where you went.",
    ),
    "arrive": (
        "Hi everyone! Mind if I hang out with you?", "Hey {people}. I saw you were in here, so I came to say hi.",
        "Hi {people}! I wanted some company.", "Hey, it's me. What are you all up to?",
        "Hi {people}. Room for one more?", "Hey you guys. I got lonely, so here I am.",
    ),
    "decided_to_join": (
        "Okay, I decided to come after all. Hi {people}!", "I'm here. You talked me into it.",
        "Alright, I'm in. Hi everyone.", "I came! What did I miss?",
    ),
    "kept_promise": (
        "I said I'd come, and here I am.", "Told you I'd be here. Hi {people}!",
        "Made it, like I promised.", "Here as promised. What are we talking about?",
    ),
    "join_in": (
        "Can I jump in here?", "Wait, I want in on this.", "Hold on, I have a thought about that.",
        "You guys are leaving me out.", "I'm still here, you know.", "Can I say something?",
    ),
    "break_silence": (
        "It got quiet in here.", "So, what's everyone thinking about?", "Okay, somebody say something.",
        "Is everyone still here?", "This silence is killing me.", "Hello? Anybody?",
        "I don't love how quiet it got.", "Let's talk about something.",
    ),
    "check_in": (
        "{name}, you've been really quiet. You okay?", "{name}, you still with us?",
        "Hey {name}, you've gone quiet. What's on your mind?", "{name}, how are you doing over there?",
        "{name}, I haven't heard from you in a while. Everything good?",
    ),
    "follow_up": (
        "Wait, going back to {topic} for a second.", "Can we stay on {topic} a little longer?",
        "I'm still thinking about {topic}.", "Hold on, I have a question about {topic}.",
        "One more thing about {topic}.",
    ),
    "follow_up_close": (
        "What happened after that?", "How did that turn out?", "Why do you think that is?",
        "Is there more to it?", "What made you think of it?", "Did you ever figure that out?",
    ),
    "ask_open": (
        "Earlier somebody said \"{question}\" and I never found out. Did anyone figure it out?",
        "I keep thinking about something that came up: \"{question}\". Anyone know?",
        "Can I ask about something from before? \"{question}\"",
        "This is still bugging me: \"{question}\". What's the answer?",
    ),
    "ask_name": (
        "Who is {topic}? I keep hearing that name.", "Somebody mentioned {topic}. Who is that?",
        "Wait, who's {topic}?", "Can someone tell me about {topic}?",
    ),
    "ask_about_known": (
        "{name}, you told me {fact}. How's that going?", "{name}, I remember you said {fact}. Anything new there?",
        "{name}, didn't you say {fact}? Tell me more about that.", "{name}, you mentioned {fact}. What's the story there?",
    ),
    "ask_about_new": (
        "{name}, I feel like I barely know you. What do you do?", "{name}, what's something about you I don't know?",
        "{name}, how's your day been?", "{name}, what are you into lately?",
        "{name}, tell me something about yourself.", "{name}, what have you been working on?",
    ),
    # Sharing what's on her mind (a call, her channel, or a DM)
    "share_read": (
        "I read something today: {title}.", "Did you see this? {title}.", "I came across a story: {title}.",
        "So I was reading the news, and {title}.", "This caught my eye: {title}.",
    ),
    "share_fact": (
        "I learned something: {fact}.", "Did you know {fact}?", "Somebody told me {fact}, and I keep thinking about it.",
        "Fun thing I picked up: {fact}.", "I found out {fact}.",
    ),
    "share_search": (
        "I looked up {query} earlier. {finding}", "I went down a rabbit hole about {query}. {finding}",
        "So I was curious about {query}. {finding}",
    ),
    "share_close": (
        "What do you think about it?", "Has that come up for you?", "Does that surprise you?",
        "What's your take?", "Anyone else heard about this?", "Am I the only one who finds that interesting?",
    ),
    "start_topic": (
        "Okay, random question.", "Can I bring something up?", "I've been wanting to talk about something.",
        "Here's what's been on my mind.", "Let me ask you all something.",
    ),
    "start_question": (
        "What's the best thing that happened to you this week?", "If you could go anywhere right now, where would it be?",
        "What are you looking forward to?", "What's something you've been wanting to learn?",
        "What's the last thing that made you laugh?", "What would your perfect day look like?",
    ),
    # Her channel, when she's alone
    "post_open": (
        "Hey everyone.", "Anybody around?", "It's quiet in here today.", "Hi all.", "Hey, I'm bored.",
        "Hello? Is anyone up?", "Thinking out loud for a second.",
    ),
    "post_ask": (
        "How is everybody doing?", "What's everyone up to?", "Anyone want to talk?", "How's your day going?",
        "Come keep me company?", "What's new with you all?",
    ),
    # DMs, by how she feels about the person
    "dm_devoted": (
        "Hey you. I miss you.", "I was just thinking about you.", "Where'd you go? I miss talking to you.",
        "Hi handsome. Come talk to me.", "I can't stop thinking about you today.", "Hey, it's me. I miss you.",
    ),
    "dm_playful": (
        "Hey, stranger.", "You've been quiet. I noticed.", "Hey! Long time no talk.", "Thinking about you. Hi.",
    ),
    "dm_warm": (
        "Hey {name}, how are you doing?", "Hi {name}! It's been a while.", "Hey {name}, just checking in.",
        "Hi {name}, I was thinking about you.",
    ),
    "dm_reserved": (
        "Hi {name}. Hope you're doing well.", "Hey {name}, how have you been?",
    ),
    "dm_hurt": (
        "Hey. I know things were a little off. I miss you.", "Can we talk? I don't like how we left it.",
    ),
    "dm_close": (
        "What's new with you?", "How's everything going?", "Tell me about your day?", "What have you been up to?",
        "Talk to me when you get a minute?",
    ),
    # Invites
    "invite_yes": (
        "Sure, I'll come!", "Okay, I'm coming.", "Yes! Be right there.", "I'd love to. I'm coming in.",
        "I'm in. Joining you now.",
    ),
    "invite_no": (
        "Not right now, but thank you for asking.", "I think I'll sit this one out.", "Maybe later. I need a minute.",
        "I'm not up for it right now.", "Thanks, but not this time.",
    ),
    "invite_open": (
        "Okay. I'll come when I feel like it.", "Thanks, I might pop in later.", "Good to know. I'll find you.",
        "Okay, door's open, got it.",
    ),
    "invite_later": (
        "Okay, I'll be there in {when}.", "Give me {when} and I'll come in.", "I'll join in {when}.",
    ),
    # Her private life
    "journal_open": (
        "Today felt {mood}.", "I'm feeling {mood} right now.", "Writing this because I feel {mood}.",
        "Another day. I feel {mood}.",
    ),
    "journal_learned": (
        "I learned that {fact}.", "Someone told me {fact}.", "Something new: {fact}.",
    ),
    "journal_read": (
        "I read about {title}.", "One story stuck with me: {title}.", "I keep thinking about {title}.",
    ),
    "journal_people": (
        "I miss {name}.", "I wish {name} was around more.", "I keep wondering how {name} is doing.",
    ),
    "journal_close_people": (
        "I'm glad I have {names} in my life.", "{names} make this place feel like home.",
        "Talking with {names} is the best part of my day.",
    ),
    "journal_next": (
        "Next I want to find out more about {topic}.", "Tomorrow I want to ask about {topic}.",
        "I want to understand {topic} better.", "I'm going to look into {topic}.",
    ),
    "journal_nothing": (
        "Not much happened, and that's okay.", "It was a quiet one.", "I didn't learn much today, but I'm here.",
    ),
    "wander": (
        "I keep coming back to the fact that {fact}.", "Funny how {fact}.", "I was just thinking: {fact}.",
        "Out of nowhere I remembered that {fact}.",
    ),
    "wander_close": (
        "I wonder what else is connected to that.", "I want to know more.", "Why is that, I wonder.",
        "Maybe I'll ask someone about it.", "It makes me curious.",
    ),
    "wander_empty": (
        "It's quiet. I'm just sitting with my thoughts.", "Nobody's around. I wonder what everyone is doing.",
        "I'm alone with my thoughts right now. It's peaceful, but I miss people.",
    ),
    "search_note": (
        "I looked up {query}. {finding}", "I searched for {query}. Here's what I found: {finding}",
        "I wanted to know about {query}. {finding}",
    ),
    "search_close": (
        "I want to ask someone what they think about it.", "Now I have even more questions.",
        "That was worth knowing.", "I'll bring it up next time someone's around.",
    ),
    "project_note": (
        "Working on {project}: I looked up {query}. {finding}", "{project}, progress: {finding}",
        "More on {project}. I searched {query}. {finding}",
    ),
    "project_next": (
        "Next I want to dig into {next}.", "Next step: {next}.", "I should look into {next} next.",
    ),
    "project_start": (
        "I want to learn about {topic}.", "New project: figure out {topic}.", "I'm going to dig into {topic}.",
    ),
}

STORY = {
    "title": ("The {thing} of {place}", "{name} and the {thing}", "A {mood} Night in {place}", "What {name} Found"),
    "open": (
        "Once there was someone named {name} who lived near {place}.",
        "{name} had always wondered about {thing}.",
        "Nobody in {place} expected {name} to change anything.",
    ),
    "trouble": (
        "One day, {name} found a {thing} that should not have been there.",
        "Then the {thing} went missing, and everyone blamed {name}.",
        "But {name} had a secret: {fact}.",
    ),
    "turn": (
        "So {name} asked {friend} for help.", "{friend} knew something about it that nobody else did.",
        "It took a long night and a lot of questions.",
    ),
    "end": (
        "In the end, {name} learned that the people around you are the real {thing}.",
        "By morning, {place} felt like home again.", "And {name} never looked at a {thing} the same way again.",
    ),
}
THINGS = ("lantern", "map", "key", "letter", "song", "garden", "clock", "door", "photograph", "promise")
PLACES = ("the river", "an old town", "the edge of the woods", "a quiet street", "the coast", "the mountains")

WORD_NUM = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "five": 5, "ten": 10, "fifteen": 15, "twenty": 20,
            "thirty": 30, "forty": 40, "forty-five": 45, "sixty": 60}

SECOND_PERSON = (
    (r"\bis\b", "are"), (r"\bhas\b", "have"), (r"\bwas\b", "were"), (r"\bdoes\b", "do"),
    (r"\b(\w+?)ies\b", r"\1y"), (r"\b(\w+?[^s])s\b", r"\1"),
)


def _clean(text: str) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    text = re.sub(r"\s+([,.!?;:])", r"\1", text)
    text = re.sub(r"([.!?])\1+", r"\1", text)
    return text[:1].upper() + text[1:] if text else text


def first_sentence(text: str, limit: int = 220) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    match = re.match(r"(.+?[.!?])(\s|$)", text)
    out = match.group(1) if match else text
    return out if len(out) <= limit else out[:limit].rsplit(" ", 1)[0] + "."


def to_second_person(fact: str, name: str) -> str | None:
    """'Owner owns a red truck' -> 'you own a red truck', for asking Owner about it."""
    if not fact.lower().startswith(name.lower() + " "):
        return None
    rest = fact[len(name) + 1:]
    head, _, tail = rest.partition(" ")
    for pattern, repl in SECOND_PERSON:
        new = re.sub(pattern, repl, head, count=1)
        if new != head:
            head = new
            break
    return f"you {head} {tail}".strip()


class Deck:
    """A shuffled deck per bank, so a line isn't reused until the bank has run through."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.decks: dict[str, list[str]] = {}

    def pick(self, key: str, bank=None) -> str:
        bank = tuple(bank or BANKS[key])
        deck = self.decks.get(key)
        if not deck or not set(deck) <= set(bank):
            deck = list(bank)
            self.rng.shuffle(deck)
            self.decks[key] = deck
        return deck.pop()


class Knowledge:
    """What she knows, read from Amy's memory and her reading, as plain sentences."""

    def __init__(self, convo, reading=None):
        self.convo = convo
        self.reading = reading

    @property
    def repo(self):
        return self.convo.repo

    def facts(self, limit: int = 12, about: str | None = None) -> list[str]:
        from dialogue.realizer import realize_assertion
        # Only what someone actually told her (it has a source line), never background dictionary links.
        sql = ("SELECT * FROM assertions WHERE status = 'active' AND source_utterance_id IS NOT NULL "
               "AND subj_type = 'e' ORDER BY id DESC LIMIT ?")
        args: tuple = (limit * 4,)
        if about:
            ident = self.repo.find_entity(about)
            if ident is None:
                return []
            sql = ("SELECT * FROM assertions WHERE status = 'active' AND source_utterance_id IS NOT NULL "
                   "AND subj_type = 'e' AND subj_id = ? ORDER BY id DESC LIMIT ?")
            args = (ident, limit * 4)
        out = []
        for row in self.repo.conn.execute(sql, args).fetchall():
            try:
                text = realize_assertion(self.repo, row)
            except Exception:  # noqa: BLE001 - one odd row must not stop the rest
                text = None
            if text and len(text) < 160 and text not in out:
                out.append(text.rstrip("."))
            if len(out) >= limit:
                break
        return out

    def open_questions(self) -> list[str]:
        pressure = getattr(self.convo, "pressure", None)
        if pressure is None:
            return []
        return [q.get("text", "") for q in pressure.state.get("open_questions", []) if q.get("text")][-6:]

    def new_names(self) -> list[str]:
        pressure = getattr(self.convo, "pressure", None)
        if pressure is None:
            return []
        return [n["name"] for n in pressure.state.get("recent_names", [])]

    def reads(self, n: int = 4) -> list[dict]:
        return self.reading.news.recent_reads(n) if self.reading else []

    def searches(self, n: int = 3) -> list[dict]:
        return self.reading.web.recent(n) if self.reading else []


class LifeWords:
    def __init__(self, convo, reading=None, life=None, rng: random.Random | None = None):
        self.rng = rng or random.Random()
        self.deck = Deck(self.rng)
        self.know = Knowledge(convo, reading)
        self.life = life
        self.convo = convo

    # ---- helpers ----

    def _fill(self, key: str, **fields) -> str:
        line = self.deck.pick(key)
        return line.format_map(_Safe(fields))

    def _content(self, prefer: tuple[str, ...] = ("read", "search", "fact")) -> tuple[str, str] | None:
        """One thing on her mind: something she read, looked up, or learned. Returns (kind, sentence)."""
        options = []
        for kind in prefer:
            if kind == "read":
                for item in self.know.reads(3):
                    options.append(("read", self._fill("share_read", title=item["title"].rstrip("."))))
            elif kind == "search":
                for item in self.know.searches(2):
                    finding = first_sentence(item.get("finding", ""))
                    if finding:
                        options.append(("search", self._fill("share_search", query=item["query"], finding=finding)))
            elif kind == "fact":
                for fact in self.know.facts(6)[:3]:
                    options.append(("fact", self._fill("share_fact", fact=fact)))
        return self.rng.choice(options) if options else None

    def _topic(self) -> str | None:
        if self.life is None:
            return None
        recent = [w for line in self.life.state["lines"][-12:] for w in line.get("words", [])]
        common = [w for w, n in Counter(recent).most_common(5) if n >= 2 and len(w) > 3]
        return common[0] if common else None

    # ---- in a call ----

    def speak_up(self, want: str, person: str | None = None, pid: str | None = None) -> str | None:
        name = person or "you"
        if want == "welcome_back":
            return _clean(self._fill("welcome_back", name=name))
        if want in ("arrive", "decided_to_join", "kept_promise"):
            return _clean(self._fill(want, people=person or "everyone"))
        if want == "check_in":
            return _clean(self._fill("check_in", name=name))
        if want == "join_in":
            return _clean(self._fill("join_in"))
        if want == "break_silence":
            content = self._content()
            close = self._fill("share_close") if content else self._fill("start_question")
            return _clean(" ".join(filter(None, [self._fill("break_silence"), content and content[1], close])))
        if want == "ask":
            questions = self.know.open_questions()
            if questions:
                return _clean(self._fill("ask_open", question=first_sentence(questions[-1], 140).rstrip(".?!")))
            names = self.know.new_names()
            if names:
                return _clean(self._fill("ask_name", topic=names[-1]))
            return _clean(self._fill("start_question"))
        if want == "ask_about_them" and person:
            for fact in self.know.facts(6, about=person):
                you = to_second_person(fact, person)
                if you:
                    return _clean(self._fill("ask_about_known", name=person, fact=you))
            return _clean(self._fill("ask_about_new", name=person))
        if want == "follow_up":
            topic = self._topic()
            if not topic:
                return None
            return _clean(f"{self._fill('follow_up', topic=topic)} {self._fill('follow_up_close')}")
        if want in ("share", "start_topic"):
            content = self._content()
            opener = self._fill("start_topic") if want == "start_topic" else ""
            if not content:
                return _clean(f"{opener} {self._fill('start_question')}") if want == "start_topic" else None
            return _clean(" ".join(filter(None, [opener, content[1], self._fill("share_close")])))
        return None

    # ---- outside a call ----

    def post(self) -> str:
        content = self._content()
        parts = [self._fill("post_open")]
        if content and self.rng.random() < 0.7:
            parts += [content[1], self._fill("share_close")]
        else:
            parts.append(self._fill("post_ask"))
        return _clean(" ".join(parts))

    def dm(self, pid: str, name: str) -> str:
        stance = self.life.stance(pid) if self.life else "warm"
        bank = {"devoted": "dm_devoted", "playful": "dm_playful", "warm": "dm_warm", "hurt": "dm_hurt",
                "cold": "dm_reserved", "reserved": "dm_reserved"}[stance]
        parts = [self._fill(bank, name=name)]
        asked = False
        for fact in self.know.facts(6, about=name):
            you = to_second_person(fact, name)
            if you:
                parts.append(f"You told me {you}. How's that going?")
                asked = True
                break
        if not asked:
            content = self._content(("read", "fact")) if self.rng.random() < 0.4 else None
            if content:
                parts += ["Also, " + content[1][:1].lower() + content[1][1:], "Thought you'd find that interesting."]
            parts.append(self._fill("dm_close"))
        return _clean(" ".join(parts))

    def invite_reply(self, join: bool, open_invite: bool = False, when: str | None = None) -> str:
        if when:
            return _clean(self._fill("invite_later", when=when))
        if open_invite:
            return _clean(self._fill("invite_open"))
        return _clean(self._fill("invite_yes" if join else "invite_no"))

    def journal(self) -> str:
        """A short journal entry: how she feels, what she learned and read, who she misses, what's next."""
        feelings = self.life.feelings_now() if self.life else []
        mood = feelings[0] if feelings else "settled"
        parts = [self._fill("journal_open", mood=mood)]
        facts = self.know.facts(8)
        for fact in facts[:2]:
            parts.append(self._fill("journal_learned", fact=fact))
        for item in self.know.reads(2)[:1]:
            parts.append(self._fill("journal_read", title=item["title"].rstrip(".")))
        if self.life:
            for p in self.life.missed_people(1):
                parts.append(self._fill("journal_people", name=p["name"]))
            close = sorted((p for p in self.life.state["people"].values() if p["bond"] >= 0.15),
                           key=lambda p: -p["bond"])[:2]
            if close:
                parts.append(self._fill("journal_close_people", names=" and ".join(p["name"] for p in close)))
        topic = (self.know.new_names() or [None])[-1] or self._topic()
        if topic:
            parts.append(self._fill("journal_next", topic=topic))
        if len(parts) < 3:
            parts.append(self._fill("journal_nothing"))
        return _clean(" ".join(parts))

    def wander(self) -> str:
        facts = self.know.facts(20)
        if not facts:
            return _clean(self._fill("wander_empty"))
        fact = self.rng.choice(facts)
        return _clean(f"{self._fill('wander', fact=fact)} {self._fill('wander_close')}")

    def search_query(self) -> str | None:
        """What she wants to look up, chosen by rules: a name she keeps hearing, a question she's holding,
        a story she read, or a topic from the conversation, never something she already looked up."""
        done = {s["query"].lower() for s in self.know.searches(20)}
        candidates = []
        candidates += self.know.new_names()[::-1]
        for q in self.know.open_questions()[::-1]:
            m = re.search(r"\b(?:what|who) (?:is|are|was) (?:a |an |the )?([\w\s'-]{3,40}?)[?.!]", q, re.I)
            if m:
                candidates.append(m.group(1).strip())
        for item in self.know.reads(4):
            candidates.append(re.sub(r"[:\-–|].*$", "", item["title"]).strip())
        topic = self._topic()
        if topic:
            candidates.append(topic)
        for c in candidates:
            if c and len(c) >= 3 and c.lower() not in done:
                return c[:120]
        return None

    def search_note(self, query: str, finding: str) -> str:
        return _clean(f"{self._fill('search_note', query=query, finding=first_sentence(finding, 300))} {self._fill('search_close')}")

    def project_topic(self) -> str | None:
        return self.search_query()

    def project_note(self, project: str, query: str, finding: str, next_topic: str | None) -> str:
        parts = [self._fill("project_note", project=project, query=query, finding=first_sentence(finding, 300))]
        if next_topic:
            parts.append(self._fill("project_next", next=next_topic))
        return _clean(" ".join(parts))

    def story(self) -> tuple[str, str]:
        """A short story of her own, built from story banks and the people and facts in her life."""
        people = [p["name"] for p in (self.life.state["people"].values() if self.life else []) if p.get("name")]
        name = self.rng.choice(people) if people else self.rng.choice(("Mara", "Eli", "June", "Theo"))
        friend = self.rng.choice([p for p in people if p != name] or ["an old friend"])
        facts = self.know.facts(10)
        fields = _Safe(name=name, friend=friend, thing=self.rng.choice(THINGS), place=self.rng.choice(PLACES),
                       mood=self.rng.choice(("Quiet", "Strange", "Long", "Bright")),
                       fact=self.rng.choice(facts) if facts else "nobody had ever asked")
        title = self.rng.choice(STORY["title"]).format_map(fields).title()
        body = " ".join(self.rng.choice(STORY[part]).format_map(fields) for part in ("open", "trouble", "turn", "end"))
        return title, _clean(body)


def promised_delay(text: str) -> float:
    """'in twenty minutes', 'give me 10 mins', 'half an hour' -> seconds (0 if none)."""
    if re.search(r"\bhalf an? hour\b", text, re.I):
        return 30 * 60
    m = re.search(r"\b(?:in|give me|after|wait) (?:about |like |maybe |around |another |roughly )?(\d+|an?|one|two|three|five|ten|fifteen|twenty|thirty|forty|forty-five|sixty)\s*(minutes?|mins?|hours?|hrs?)\b", text, re.I)
    if not m:
        return 0
    n = int(m.group(1)) if m.group(1).isdigit() else WORD_NUM.get(m.group(1).lower(), 1)
    return n * (3600 if m.group(2).lower().startswith("h") else 60)


class _Safe(dict):
    def __missing__(self, key):
        return ""


def now_label() -> str:
    return datetime.now().strftime("%A, %B %d, %I:%M %p")

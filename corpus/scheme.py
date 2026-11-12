"""The tag scheme as data: ten layers over one map (TAG-SCHEME.md is the same thing in words).

The tagger asks for these, the studio shows them, and the trainer learns a readout for each. They are defined once,
here, so the three can never disagree about what a tag is.

A small model handed one big form gets lazy (in the first test both models marked every tone "neutral"), so the ten
layers are asked for in five short passes, each with its own instructions and its own small answer shape.
"""

# ---- Layer 1: Address ----
TO = {"bot": "said to an AI companion bot", "person": "said to a human", "room": "said to everyone or no one in particular",
      "self": "talking to themselves", "machine": "dictating to a computer, coding tool or voice assistant, not to anyone in the call",
      "unclear": "can't tell"}
WANTS = {"answer": "wants an answer", "action": "wants something done", "agreement": "wants agreement or confirmation",
         "comfort": "wants comfort or support", "to_be_heard": "just wants to be listened to", "to_be_left_alone": "wants them to stop or go quiet",
         "nothing": "expects nothing back"}
PLACE = {"opens": "starts a new subject", "continues": "carries on the current subject", "answers": "answers a question just asked",
         "follows_up": "asks or adds more about what was just said", "cuts_in": "interrupts", "returns": "goes back to an earlier subject",
         "closes": "ends the subject or the conversation"}

# ---- Layer 2: Act (broad.fine) ----
ACTS = {
    "ask": {"fact": "for a fact", "opinion": "what they think", "how_are_you": "how they are or feel", "remember": "whether they remember",
            "ability": "whether they can do something", "why_how": "why or how", "confirm": "to confirm (right? is that so?)",
            "choice": "to pick between options", "rhetorical": "not really asking"},
    "direct": {"command": "do it now", "request": "a polite request", "permission": "allows it (go ahead)", "stop": "stop or don't",
               "standing_rule": "a rule for from now on (always, never)", "teach": "teaches how to do something", "invite": "let's do something together",
               "delegate": "hands over a job"},
    "tell": {"about_self": "about themselves", "about_other": "about another person", "about_bot": "about the bot", "about_world": "about the world",
             "event": "what happened", "plan": "what they plan to do", "opinion": "what they think", "preference": "what they like or dislike",
             "guess": "what they suppose", "definition": "what a word or thing means", "rule": "a general rule (if, whenever)", "story": "a story or anecdote",
             "doing_now": "what they are doing right now"},
    "react": {"agree": "agrees", "disagree": "disagrees", "acknowledge": "yeah, okay, right: heard it, adds nothing", "surprise": "surprised",
              "laugh": "laughs", "thank": "thanks", "apologize": "apologizes", "forgive": "forgives", "sympathize": "sympathizes", "brush_off": "dismisses it"},
    "judge": {"praise_bot": "praises the bot", "praise_other": "praises someone or something else", "fault_bot": "faults the bot",
              "fault_other": "faults someone or something else", "compare": "compares two things", "complain": "complains about the situation"},
    "repair": {"correct_bot": "corrects the bot", "correct_self": "corrects themselves", "clarify": "clears something up", "repeat": "says it again",
               "didnt_hear": "didn't hear or catch it", "misunderstood": "says they were misunderstood"},
    "bond": {"greet": "hello", "farewell": "goodbye", "check_in": "checks how things are going", "small_talk": "small talk", "tease": "teases",
             "flirt": "flirts", "comfort": "comforts", "encourage": "encourages", "insult": "insults", "threat": "threatens, joking or real", "brag": "brags"},
    "meta": {"about_talk": "about this conversation itself", "about_workings": "about how the bot works inside", "test_bot": "testing what the bot does",
             "show_off": "showing the bot off to others", "quote": "reading or quoting something", "sing": "singing or lyrics", "garbled": "broken transcription, no usable meaning"},
}
ACT_TAGS = [f"{broad}.{fine}" for broad, fines in ACTS.items() for fine in fines]

# ---- Layer 3: Subject ----
ABOUT = {"speaker": "the speaker", "bot": "a bot", "person_present": "a human in the conversation", "person_absent": "a human who isn't there",
         "speaker_and_bot": "the speaker and the bot together", "group": "the group", "thing": "a thing, place or idea"}
BOT_PART = {"identity": "who or what the bot is", "behavior": "how it behaves", "looks": "how it looks", "voice": "its voice", "memory": "its memory",
            "feelings": "its feelings", "abilities": "what it can do", "mistake": "a mistake it made", "build": "how it is built or coded"}
FIELD = ["building_bots_and_ai", "code_and_computers", "work_and_money", "family", "friends", "health_and_body", "food", "drink_and_smoke", "music",
         "games", "film_and_tv", "feelings", "everyday_life", "plans", "news_and_world", "big_questions", "jokes", "other"]

# ---- Layer 4: Knowledge (per claim) ----
CLAIM_KIND = {"identity": "who someone is", "relation": "how two people are related", "trait": "what someone or something is like", "owns": "something owned",
              "location": "where someone or something is", "likes": "a like or dislike", "ability": "something they can do", "habit": "something they do regularly",
              "happened": "something that happened", "state_now": "how things are right now", "plan": "a plan or intention", "opinion": "an opinion",
              "rule": "a general rule", "meaning": "what a word means", "how_to": "how to do something", "amount": "a number or amount", "name": "a name or nickname"}
CLAIM_WHEN = ["always", "past", "ongoing", "this_moment", "future", "no_longer"]
CLAIM_SURE = {"flat": "said flat out", "hedged": "hedged (I think, maybe)", "guess": "a guess", "hearsay": "heard from someone else", "what_if": "hypothetical",
              "not_literal": "a joke or exaggeration", "sarcastic": "sarcastic, means the opposite"}
CLAIM_WIDE = ["one", "a_kind", "everyone"]
CLAIM_KEEP = {"keep": "will still matter later", "moment": "only matters right now", "not_a_fact": "not really a fact"}
CLAIM_PRIVATE = ["ordinary", "personal", "sensitive", "in_confidence"]

# ---- Layer 5: Feeling ----
FEELINGS = ["joy", "affection", "amusement", "pride", "excitement", "calm", "curiosity", "gratitude", "hope", "frustration", "anger", "contempt",
            "disappointment", "sadness", "loneliness", "worry", "tiredness", "boredom", "embarrassment", "hurt", "confusion"]
AIMED_AT = ["bot", "self", "another_person", "situation", "tool_or_machine", "nothing"]
SWEARING = ["none", "emphasis", "at_bot", "at_something_else"]

# ---- Layer 6: Stance toward the bot ----
DISTANCE = ["draws_closer", "pushes_away", "neither"]
TREATS_AS = ["person", "tool", "project", "audience", "not_about_bot"]
TRUST = ["confides", "relies_on", "believes", "doubts", "tests", "none"]
AUTHORITY = ["owner_order", "sets_limit", "gives_freedom", "defends_bot", "none"]
STANDING = {"questions": "questions whether the bot is real, alive or aware", "affirms": "affirms that it is", "none": "not about that"}

# ---- Layer 7: Charge (what the line carries that a want can feed on) ----
CHARGES = {"warmth": "warmth given", "attention": "attention given to the bot", "approval": "approval", "need": "need for the bot",
           "invitation": "invitation to join in", "novelty": "something new offered", "challenge": "a challenge to the bot", "demand": "a demand on the bot",
           "urgency": "urgency", "rejection": "rejection", "left_out": "the bot being left out", "talked_over": "the bot being talked over"}

# ---- Layer 8: Call (what the line asks a mind to do) ----
CALLS = {
    "remember": {"store": "store a new fact", "change": "change a fact it holds", "forget": "forget something", "recall_person": "recall what it knows of a person",
                 "recall_talk": "recall an earlier conversation"},
    "reason": {"answer": "answer from what it knows", "work_out": "work something out", "compare": "compare", "explain": "explain why",
               "check": "check for a contradiction", "estimate": "estimate", "plan": "plan steps", "define": "define a word", "unknown": "say it doesn't know"},
    "converse": {"acknowledge": "acknowledge", "answer": "answer", "ask_meaning": "ask what was meant", "follow_up": "ask a follow-up", "offer": "offer something related",
                 "comfort": "comfort", "celebrate": "celebrate", "own_mistake": "own a mistake and fix it", "hold_ground": "hold its ground", "joke_back": "joke back",
                 "listen": "stay quiet and listen", "change_subject": "change the subject", "wrap_up": "wrap up"},
    "act": {"look": "its look or avatar", "sound": "its voice, sound or music", "files": "files and projects", "look_up": "look something up", "own_memory": "its own memory",
            "settings": "its own settings", "call": "the call (join, leave, mute)", "reminder": "a reminder or schedule", "nothing": "no action"},
}
CALL_TAGS = [f"{broad}.{fine}" for broad, fines in CALLS.items() for fine in fines]

# ---- Layer 9: Form ----
SHAPE = ["statement", "question", "command", "exclamation", "fragment"]
HAS = ["condition", "denial", "comparison", "list", "number_or_time", "quote", "reason"]
LEANS = {"stands_alone": "makes sense on its own", "needs_previous": "needs the line before it (that, it, do it again)",
         "continues_cut": "carries on a sentence that was cut off earlier", "cut_off": "is cut off itself"}
TRANSCRIPTION = ["clean", "some_misheard", "garbled"]
REGISTER = ["plain", "rough", "technical", "tender"]

# ---- Layer 10: Links ----
THREAD = ["same", "a_turn_within", "new", "back_to_older"]
LAST_REPLY = {"built_on": "picked up what the bot last said and built on it", "accepted": "accepted it", "corrected": "corrected it", "ignored": "ignored it",
              "annoyed": "was annoyed by it", "pleased": "was pleased by it", "bot_had_not_spoken": "the bot hadn't said anything recently"}

_enum = lambda values: {"type": "string", "enum": list(values)}
_many = lambda values: {"type": "array", "items": _enum(values)}
_graded = lambda values, key: {"type": "array", "items": {"type": "object", "required": [key, "strength"],
                                                           "properties": {key: _enum(values), "strength": {"type": "integer", "minimum": 1, "maximum": 3}}}}
_list = lambda d: "; ".join(f"{k} = {v}" for k, v in d.items())
_acts = lambda groups: " | ".join(f"{broad}: " + ", ".join(f"{broad}.{fine} ({why})" for fine, why in fines.items()) for broad, fines in groups.items())

HEADER = """You label lines from voice and text conversations between people and AI companion bots on Discord. Most lines are speech
turned into text, so some are cut off or misheard. Speakers marked [bot] are AI companion bots; everyone else is a human.

You get a stretch of conversation. Every line has an id. Label ONLY the lines marked TAG, one result per TAG line, with its id.
Lines marked CONTEXT are there so you can follow the conversation. Label what is there; do not explain; do not guess beyond the line."""

PASSES = [
    {"name": "address_act", "layers": "1 Address, 2 Act",
     "ask": f"""For each TAG line:
- to: who it is said to. {_list(TO)}. A line that names a bot or answers a bot is said to a bot.
- wants: what the speaker wants back. {_list(WANTS)}.
- place: where it sits in the talk. {_list(PLACE)}.
- acts: EVERYTHING the speaker is doing, one or more of these. A line is often several at once ("You are generating crap" is
  judge.fault_bot and tell.about_bot). {_acts(ACTS)}""",
     "fields": {"to": _enum(TO), "wants": _enum(WANTS), "place": _enum(PLACE), "acts": _many(ACT_TAGS)}},

    {"name": "subject_knowledge", "layers": "3 Subject, 4 Knowledge",
     "ask": f"""For each TAG line:
- about: who or what it is about, one or more. {_list(ABOUT)}.
- bot_part: if it is about a bot, which part of it, zero or more. {_list(BOT_PART)}.
- field: the area of life, one or more of: {", ".join(FIELD)}.
- topics: one to three short phrases naming what it is about, in your own words (for example "outfit change", "GitHub pricing").
- claims: every plain fact the line states. Rewrite each as ONE short simple sentence that names who or what it is about instead
  of I, you, he, she, it (use the speaker's name for "I", the bot's name for "you" when it is said to a bot). A question, a
  request or a greeting states no fact: give an empty list. For each claim:
    kind: {_list(CLAIM_KIND)}
    when: {", ".join(CLAIM_WHEN)} (no_longer = used to be true and isn't now)
    sure: {_list(CLAIM_SURE)}
    denied: true if the line says it is NOT so
    wide: one (a single person or thing), a_kind (that sort of thing in general), everyone
    keep: {_list(CLAIM_KEEP)}. An insult or an exaggeration is not_a_fact.
    private: ordinary, personal, sensitive (health, money, legal), in_confidence (told as a secret)""",
     "fields": {"about": _many(ABOUT), "bot_part": _many(BOT_PART), "field": _many(FIELD), "topics": {"type": "array", "items": {"type": "string"}},
                "claims": {"type": "array", "items": {"type": "object", "required": ["text", "kind", "when", "sure", "denied", "wide", "keep", "private"],
                                                      "properties": {"text": {"type": "string"}, "kind": _enum(CLAIM_KIND), "when": _enum(CLAIM_WHEN), "sure": _enum(CLAIM_SURE),
                                                                     "denied": {"type": "boolean"}, "wide": _enum(CLAIM_WIDE), "keep": _enum(CLAIM_KEEP), "private": _enum(CLAIM_PRIVATE)}}}}},

    {"name": "feeling_stance_charge", "layers": "5 Feeling, 6 Stance, 7 Charge",
     "ask": f"""Read each TAG line for feeling. Most lines carry some: do not answer "none" out of habit. For each TAG line:
- feelings: every feeling in the line with its strength (1 slight, 2 clear, 3 strong), from: {", ".join(FEELINGS)}. Empty list only if it is truly flat.
- aimed_at: what the strongest feeling is aimed at: {", ".join(AIMED_AT)}.
- swearing: none; emphasis (swearing for force, not at anyone); at_bot; at_something_else.
- distance: what it does to the speaker's closeness with the bot: {", ".join(DISTANCE)}.
- treats_as: how the bot is being treated: person, tool (something to operate), project (something being built), audience (talked at), not_about_bot.
- trust: one or more of: confides (shares something personal), relies_on, believes, doubts, tests, none.
- authority: owner_order (an order from the one in charge of it), sets_limit, gives_freedom, defends_bot, none.
- standing: {_list(STANDING)}.
- charge: what the line carries, each with strength 1 to 3, zero or more of: {_list(CHARGES)}.""",
     "fields": {"feelings": _graded(FEELINGS, "feeling"), "aimed_at": _enum(AIMED_AT), "swearing": _enum(SWEARING), "distance": _enum(DISTANCE),
                "treats_as": _enum(TREATS_AS), "trust": _many(TRUST), "authority": _enum(AUTHORITY), "standing": _enum(STANDING),
                "charge": _graded(CHARGES, "charge")}},

    {"name": "call_form", "layers": "8 Call, 9 Form",
     "ask": f"""For each TAG line:
- calls: what the line asks the listener's mind to do, one or more of these. Think about what a good listener would have to DO to
  respond well. {_acts(CALLS)}
- shape: {", ".join(SHAPE)}.
- has: zero or more of: condition (if, unless, whenever), denial (not, never), comparison, list, number_or_time, quote, reason (because, so).
- leans: {_list(LEANS)}.
- transcription: clean, some_misheard (a word or two looks wrong), garbled.
- register: plain, rough (swearing, harsh), technical, tender.""",
     "fields": {"calls": _many(CALL_TAGS), "shape": _enum(SHAPE), "has": _many(HAS), "leans": _enum(LEANS), "transcription": _enum(TRANSCRIPTION),
                "register": _enum(REGISTER)}},

    {"name": "links", "layers": "10 Links",
     "ask": f"""For each TAG line, using the ids shown on every line:
- answers_id: the id of the earlier line this one answers or responds to, or null if none.
- continues_id: the id of the same speaker's earlier line that this one carries on (a sentence split in two), or null.
- thread: same (same subject as the line before), a_turn_within (same subject, new angle), new (a new subject), back_to_older.
- last_reply: how this line takes the most recent thing a [bot] said before it. {_list(LAST_REPLY)}.""",
     "fields": {"answers_id": {"type": ["integer", "null"]}, "continues_id": {"type": ["integer", "null"]}, "thread": _enum(THREAD), "last_reply": _enum(LAST_REPLY)}},
]


def schema_for(spec: dict) -> dict:
    return {"type": "object", "required": ["lines"], "properties": {"lines": {"type": "array", "items": {
        "type": "object", "required": ["id", *spec["fields"]], "properties": {"id": {"type": "integer"}, **spec["fields"]}}}}}


def clean(spec: dict, tag: dict) -> dict:
    """Keep only what the scheme allows. A value outside it is dropped, not trusted."""
    def keep(shape, value):
        if "enum" in shape:
            return value if value in shape["enum"] else None
        if shape.get("type") == "array":
            item = shape["items"]
            values = value if isinstance(value, list) else []
            if item.get("type") == "object":
                out = []
                for v in values:
                    if not isinstance(v, dict):
                        continue
                    row = {k: keep(s, v.get(k)) for k, s in item["properties"].items()}
                    if all(row.get(k) is not None for k in item.get("required", [])):
                        out.append(row)
                return out[:10]
            return list(dict.fromkeys(x for x in (keep(item, v) for v in values) if x is not None))[:12]
        if shape.get("type") == "boolean":
            return bool(value)
        if shape.get("type") == "integer":
            return value if isinstance(value, int) and shape.get("minimum", value) <= value <= shape.get("maximum", value) else None
        if shape.get("type") == "string":
            return " ".join(str(value).split())[:300] if value not in (None, "") else None
        if shape.get("type") == ["integer", "null"]:
            return value if isinstance(value, int) else None
        return None
    return {name: keep(shape, tag.get(name)) for name, shape in spec["fields"].items()}

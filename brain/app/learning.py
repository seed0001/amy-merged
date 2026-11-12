from dataclasses import replace
"""Reference resolution and learning: noun phrases -> entities/concepts, frames -> assertions."""

from db.repository import ArgRecord, Repository, Term
from dialogue.state import DialogueState
from nlp.lexicon import DEFINITE_DETS, GENERIC_DETS, PERSON_QUANTIFIERS, article
from nlp.parser import _Parser
from nlp.semantic_frames import Frame, NounPhrase, RuleFrame


class Unsupported(Exception):
    pass


class Unresolved(Exception):
    def __init__(self, message: str, gap: str) -> None:
        super().__init__(message)
        self.gap = gap


def gap_for(np: NounPhrase) -> str:
    if np.proper:
        return f"anyone or anything called {np.surface}"
    return f"what {article(np.head)} {np.head} is"


class Resolver:
    """Maps noun phrases to stored terms, tracking what 'he', 'it' and 'the truck' refer to."""

    def __init__(self, repo: Repository, state: DialogueState, self_name: str) -> None:
        self.repo = repo
        self.state = state
        self.self_name = self_name
        self.uid: int | None = None
        self.cache: dict[int, object] = {}

    def begin(self, utterance_id: int) -> None:
        self.uid = utterance_id
        self.cache = {}

    def resolve(self, np: NounPhrase, role: str, create: bool, context: tuple | None = None):
        """Return a term ('e'|'c', id); when not creating, an indefinite NP yields a
        ('kind', concept_id, modifiers) spec. None when nothing matching is known."""
        # Keyed by identity, so the noun phrase itself is kept alongside: a freed object's id can be reused by
        # a new one, which would otherwise pick up the old one's answer ("an airport" -> California)
        key = id(np)
        hit = self.cache.get(key)
        if hit is None or hit[0] is not np:
            value = self._resolve(np, role, create, context)
            self.cache[key] = (np, value)
            self._note(value, np, role)
        return self.cache[key][1]

    def _pronoun(self, word: str) -> Term:
        if word in ("i", "we"):
            return ("e", self.repo.entity(self.state.speaker))
        if word == "you":
            return ("e", self.repo.entity(self.self_name))
        ref = self.state.last_thing if word == "it" else self.state.last_person
        if ref is None:
            raise Unresolved(f"I'm not sure who or what '{word}' refers to.",
                             f"who or what '{word}' refers to")
        return ref

    def category(self, np: NounPhrase, create: bool) -> int | None:
        """The concept a predicate noun names. 'a pet owner' is its own category, filed under 'owner'."""
        if not np.modifiers:
            return self._concept(np.head, create)
        compound = " ".join([*np.modifiers, np.head])
        if not create:
            return self.repo.find_concept(compound)
        cid = self.repo.concept(compound)
        self.repo.add_assertion(("c", cid), "subclass_of", ("c", self.repo.concept(np.head)), True, self.uid)
        return cid

    def _concept(self, lemma: str, create: bool) -> int | None:
        return self.repo.concept(lemma) if create else self.repo.find_concept(lemma)

    def _new_instance(self, kind: int, mods: tuple[str, ...]) -> int:
        item = self.repo.new_instance(kind)
        self.repo.add_assertion(("e", item), "instance_of", ("c", kind), True, self.uid)
        for mod in mods:
            self.repo.note_lexeme(mod, "adj")
            self.repo.add_assertion(("e", item), "has_property", ("c", self.repo.concept(mod)), True, self.uid)
        return item

    @staticmethod
    def is_generic(np: NounPhrase, role: str) -> bool:
        if role == "pred" or np.determiner in GENERIC_DETS:
            return True
        if np.determiner is None and np.possessor is None:
            return True  # bare plural or mass noun: "dogs", "water"
        return role == "subject" and np.determiner in ("a", "an")  # "A dog barks"

    def _resolve(self, np: NounPhrase, role: str, create: bool, context: tuple | None):
        if np.pronoun:
            return self._pronoun(np.pronoun)
        if np.quantifier:
            if create:
                raise Unsupported(f"I can't store a fact about an unspecified '{np.quantifier}' yet; "
                                  "try a rule like 'If someone ..., they ...'.")
            return None
        if np.proper:
            eid = self.repo.entity(np.surface) if create else self.repo.find_entity(np.surface)
            return ("e", eid) if eid else None
        if create:
            self.repo.note_lexeme(np.head, "noun", np.surface.split()[-1].lower())
        if role == "pred":
            cid = self.category(np, create)
            return ("c", cid) if cid else None
        kind = self._concept(np.head, create)
        if kind is None:
            return None

        if np.possessor is not None:
            owner = self.resolve(np.possessor, "subject", create)
            if owner is None or owner[0] != "e":
                return None
            item = self.repo.related_instance(owner, "rel:own", kind, np.modifiers)
            if item is None:
                candidates = [r["obj_id"] for r in self.repo.assertions("rel:own", subj=owner, polarity=True)
                              if r["obj_type"] == "e" and self.repo.entity_row(r["obj_id"])["kind_concept_id"] == kind]
                item = candidates[-1] if candidates else None
            if item is None:
                if not create:
                    return None
                item = self._new_instance(kind, np.modifiers)
                self.repo.add_assertion(owner, "rel:own", ("e", item), True, self.uid)
            return ("e", item)

        if self.is_generic(np, role):
            return ("c", kind)

        if np.determiner in DEFINITE_DETS:
            item = self.state.recent.get(kind)
            if item is None:
                existing = self.repo.instances_of(kind)
                item = existing[0] if len(existing) == 1 else None
            if item is None:
                if not create:
                    return None
                item = self._new_instance(kind, np.modifiers)
            elif create:
                for mod in np.modifiers:
                    self.repo.add_assertion(("e", item), "has_property", ("c", self.repo.concept(mod)), True, self.uid)
            return ("e", item)

        if not create:
            return ("kind", kind, np.modifiers)
        item = None
        if context is not None:
            item = self.repo.related_instance(context[0], context[1], kind, np.modifiers)
        return ("e", item or self._new_instance(kind, np.modifiers))

    def _note(self, term, np: NounPhrase, role: str) -> None:
        if not term or term[0] != "e":
            return
        if np.pronoun in ("i", "you"):
            return
        if (np.proper or np.pronoun in ("he", "she", "they")) and role == "subject":
            self.state.last_person = term
        else:
            self.state.last_thing = term
            row = self.repo.entity_row(term[1])
            if row["kind_concept_id"] is not None:
                self.state.recent[row["kind_concept_id"]] = term[1]


class Learner:
    def __init__(self, repo: Repository, resolver: Resolver) -> None:
        self.repo = repo
        self.resolver = resolver

    def learn(self, frame: Frame, uid: int) -> list[int]:
        """Store a statement; returns the ids of the primary assertions it produced."""
        if frame.subject is None:
            raise Unsupported("That statement has no subject I can attach it to.")
        pol, conf, tense = frame.polarity, frame.confidence, frame.tense
        subj = self.resolver.resolve(frame.subject, "subject", True)

        if frame.relation == "is_a":
            if frame.obj.proper:
                raise Unsupported("I can't learn that two names refer to the same thing yet.")
            self.repo.note_lexeme(frame.obj.head, "noun")
            kind = self.resolver.category(frame.obj, True)
            if subj == ("c", kind):
                return []
            predicate = "instance_of" if subj[0] == "e" else "subclass_of"
            ids = [self.repo.add_assertion(subj, predicate, ("c", kind), pol, uid, conf, tense)]
            if pol and subj[0] == 'e':
                for modifier in frame.obj.modifiers:
                    ids.append(self.repo.add_assertion(subj, 'has_property', ('c', self.repo.concept(modifier)), True, uid, conf, tense))
            return ids

        if frame.relation == "property":
            ids = []
            when = []
            for role, value in frame.args:
                if value is None:
                    continue
                if isinstance(value, str):
                    when.append((role, 'lit', None, value))
                else:
                    kind, ident = self.resolver.resolve(value, 'object', True)
                    when.append((role, kind, ident, None))
            for prop in frame.properties:
                self.repo.note_lexeme(prop, "adj")
                ids.append(self.repo.add_assertion(subj, "has_property", ("c", self.repo.concept(prop)),
                                                   pol, uid, conf, tense, when))
            return ids

        predicate = f"rel:{frame.verb}"
        self.repo.note_lexeme(frame.verb, "verb")
        args: list[ArgRecord] = []
        if subj[0] == "c":
            surface = frame.subject.surface.lower() if frame.subject.plural else \
                f"{article(frame.subject.head)} {frame.subject.head}"
            args.append(("_subj", "lit", None, ("pl:" if frame.subject.plural else "sg:") + surface))

        if frame.obj is None:
            obj = ("c", self.repo.none_concept())
        elif not pol and not frame.obj.proper and not frame.obj.pronoun and frame.obj.possessor is None \
                and frame.obj.determiner not in DEFINITE_DETS:
            obj = ("c", self.repo.concept(frame.obj.head))  # "doesn't own a boat": no boat at all
        else:
            obj = self.resolver.resolve(frame.obj, "object", True, context=(subj, predicate))
        if obj[0] == "c" and frame.obj is not None and Resolver.is_generic(frame.obj, "object"):
            args.append(("_obj", "lit", None, frame.obj.surface.lower()))

        for role, value in frame.args:
            if isinstance(value, str):
                args.append((role, "lit", None, value))
            elif value is not None:
                term = self.resolver.resolve(value, "arg", True)
                args.append((role, term[0], term[1], None))
        if frame.modality:
            args.append(("modality", "lit", None, frame.modality))
        return [self.repo.add_assertion(subj, predicate, obj, pol, uid, conf, tense, args)]


PERSON_WORDS = {"person", "people", "man", "woman", "child", "kid", "boy", "girl", "adult",
                "student", "teacher", "doctor", "farmer", "baker", "friend", "user", "human"}


class DateKnowledge:
    """Dates are literal values owned by a participant, not unnamed category instances."""
    def __init__(self, convo):
        self.c, self.repo = convo, convo.repo

    def respond(self, text, uid):
        import re
        from datetime import datetime
        from dialogue import realizer
        slot = r'(?:birth\s*date|birthday|creation date|date of creation|date of birth)'
        statement = re.fullmatch(r"\s*(?:(Correction|Actually):?\s*)?(your|my|[\w -]+'s) ("+slot+r") (?:is|was) (.+?)[.!]*\s*", text, re.I)
        question = re.fullmatch(r"\s*(?:(?:what|when) (?:is|was) )?(your|my|[\w -]+'s) ("+slot+r")[?.!]*\s*", text, re.I)
        born = re.fullmatch(r'\s*when (?:were|was) (you|I|[\w -]+) (born|created)[?.!]*\s*', text, re.I)
        if not (statement or question or born): return None
        if born:
            owner, label = born[1], 'creation date' if born[2].lower()=='created' else 'birthdate'
        else:
            hit = statement or question
            owner, label = (hit[2], hit[3]) if statement else (hit[1], hit[2])
        name = self.c.self_name if owner.lower() in ('your','you') else self.c.state.speaker if owner.lower() in ('my','i') else owner.removesuffix("'s")
        eid = self.repo.entity(name) if statement else self.repo.find_entity(name)
        canonical = 'creation_date' if label.lower() in ('creation date','date of creation') or eid == self.c.self_id else 'birthdate'
        predicate = 'rel:' + canonical
        if statement:
            literal = statement[4].strip().rstrip('.!')
            if re.search(r'[.!?]\s+[A-Z]',literal): return None
            if literal.lower() in ('your creation date','my creation date'):
                expected = 'your creation date' if eid == self.c.self_id else 'my creation date'
                if literal.lower() != expected: return 'Those dates belong to different participants. Which date do you mean?'
                return 'For an AI, I use creation date for its birthdate. Tell me the actual date to store a value.'
            parsed = None
            for fmt in ('%Y-%m-%d','%B %d, %Y','%B %d %Y','%b %d, %Y','%m/%d/%Y'):
                try:
                    parsed = datetime.strptime(literal, fmt).date().isoformat(); break
                except ValueError: pass
            if parsed is None:
                return 'I need an unambiguous full date, such as YYYY-MM-DD. I have not stored that as a date.'
            if statement[1]:
                for row in self.repo.assertions(predicate,subj=('e',eid)):
                    self.repo.retract(row['id'], uid, 'date correction')
            aid = self.repo.add_assertion(('e',eid), predicate, ('c',self.repo.none_concept()),True,uid,1.,'present',
                                           [('value','lit',None,parsed),('_date_surface','lit',None,literal)])
            self.c.turn_learned.append(('a',aid))
            return 'I recorded ' + ("my" if eid == self.c.self_id else 'your' if eid == self.repo.find_entity(self.c.state.speaker) else name+"'s") + ' ' + canonical.replace('_',' ') + ' as ' + literal + '.'
        if eid is None: return 'I have no date recorded for that person.'
        rows = self.repo.assertions(predicate,subj=('e',eid),polarity=True)
        values = list(dict.fromkeys(a['literal'] for row in rows for a in self.repo.args(row['id']) if a['role']=='value'))
        if not values: return None
        lead = 'My' if eid==self.c.self_id else 'Your' if eid==self.repo.find_entity(self.c.state.speaker) else name+"'s"
        return lead + ' ' + canonical.replace('_',' ') + (' has conflicting recorded values: ' if len(values)>1 else ' is ') + ', '.join(values) + '.'


class RuleLearner:
    """Turns 'if ... then ...' frames into stored patterns over one or more variables."""

    def __init__(self, repo: Repository, resolver: Resolver) -> None:
        self.repo = repo
        self.resolver = resolver

    def learn(self, rule: RuleFrame, uid: int) -> list[tuple[str, int]]:
        conditions, conclusions = rule.conditions, rule.conclusions
        if not conditions or not conclusions or not all(isinstance(f, Frame) for f in conditions + conclusions):
            raise Unsupported("I couldn't follow the structure of that rule.")

        vars_dict: dict[str, dict] = {}

        # 1. Inspect first condition subject
        first = conditions[0].subject
        letter = first is not None and first.proper and len(first.surface) == 1 and first.surface.isupper()
        if first is not None and (letter or _Parser.var_like(first)):
            vname = first.surface.lower() if letter else "x"
            typed = not first.quantifier and not first.proper
            is_person = first.quantifier in PERSON_QUANTIFIERS or first.head in PERSON_WORDS if typed or first.quantifier else False
            cid = self.resolver.category(first, True) if typed else None
            vars_dict[vname] = dict(np=first, typed=typed, is_person=is_person, category_id=cid)

        # 2. Discover additional variables in conditions and conclusions
        for frame in conditions:
            nps = [frame.subject] + ([frame.obj] if frame.relation != "is_a" else []) + [val for _, val in frame.args if isinstance(val, NounPhrase)]
            for np in nps:
                if np is None:
                    continue
                if np.proper and len(np.surface) == 1 and np.surface.isupper():
                    vname = np.surface.lower()
                    if vname not in vars_dict:
                        vars_dict[vname] = dict(np=np, typed=False, is_person=False, category_id=None)
                elif np.quantifier and np is not first:
                    vname = "y" if "x" in vars_dict and "y" not in vars_dict else "z" if "y" in vars_dict else "w"
                    if vname not in vars_dict:
                        is_person = np.quantifier in PERSON_QUANTIFIERS
                        vars_dict[vname] = dict(np=np, typed=False, is_person=is_person, category_id=None)
                elif np.determiner in ("a", "an", "any", "every") or (not np.proper and not np.determiner and np.plural):
                    referenced = False
                    is_person = np.head in PERSON_WORDS or (np.quantifier in PERSON_QUANTIFIERS if np.quantifier else False)
                    for c in conclusions:
                        c_nps = [c.subject, c.obj] + [val for _, val in c.args if isinstance(val, NounPhrase)]
                        for c_np in c_nps:
                            if c_np is None:
                                continue
                            if is_person and c_np.pronoun in ("he", "she", "they", "who"):
                                if c_np is c.subject and "x" in vars_dict and vars_dict["x"].get("is_person"):
                                    continue
                                referenced = True
                                break
                            elif not is_person and c_np.pronoun in ("it", "which", "that"):
                                referenced = True
                                break
                            elif c_np.determiner in DEFINITE_DETS and c_np.head == np.head:
                                referenced = True
                                break
                    if referenced and np is not first:
                        vname = "y" if "x" in vars_dict and "y" not in vars_dict else "z" if "y" in vars_dict else "w"
                        if vname not in vars_dict:
                            cid = self.resolver.category(np, True)
                            vars_dict[vname] = dict(np=np, typed=True, is_person=is_person, category_id=cid)

        def match_var(np: NounPhrase | None) -> str | None:
            if np is None or not vars_dict:
                return None
            if np.proper and len(np.surface) == 1 and np.surface.isupper():
                vname = np.surface.lower()
                if vname in vars_dict:
                    return vname
            if np.pronoun in ("he", "she", "they", "it"):
                if len(vars_dict) == 1:
                    return next(iter(vars_dict.keys()))
                if np.pronoun in ("it", "which", "that"):
                    for vname, vinfo in vars_dict.items():
                        if not vinfo["is_person"]:
                            return vname
                for vname, vinfo in vars_dict.items():
                    if vinfo["is_person"]:
                        return vname
                return "x" if "x" in vars_dict else next(iter(vars_dict.keys()))
            if np.determiner in DEFINITE_DETS:
                for vname, vinfo in vars_dict.items():
                    if not vinfo["np"].quantifier and vinfo["np"].head == np.head:
                        return vname
            if np.quantifier:
                for vname, vinfo in vars_dict.items():
                    if vinfo["np"].quantifier == np.quantifier:
                        return vname
            for vname, vinfo in vars_dict.items():
                orig = vinfo["np"]
                if np is orig or (orig.proper and np.proper and np.surface == orig.surface) or \
                   (not orig.proper and not orig.pronoun and np.head == orig.head and np.determiner == orig.determiner):
                    return vname
            return None

        # Ground rules
        for frame in sorted(conditions + conclusions, key=lambda f: not (f.subject and f.subject.proper)):
            if frame.subject is not None and not match_var(frame.subject):
                self.resolver.resolve(frame.subject, "subject", True)

        condition_patterns = []
        var_x_info = vars_dict.get("x")
        if var_x_info and var_x_info["typed"]:
            var_x_np = var_x_info["np"]
            condition_patterns.append(self._is_a_pattern(replace(var_x_np, modifiers=())))
            if var_x_np.modifiers:
                condition_patterns.append({"relation": "property", "subject": "x", "verb": None, "obj": None,
                                           "props": [self.repo.concept(p) for p in var_x_np.modifiers],
                                           "polarity": True, "args": []})

        for frame in conditions:
            pattern = self._pattern(frame, match_var)
            if pattern not in condition_patterns:
                condition_patterns.append(pattern)

        for vname, vinfo in vars_dict.items():
            if vname != "x" and vinfo["typed"] and vinfo["category_id"] is not None:
                is_a_pat = {"relation": "is_a", "subject": vname, "verb": None,
                            "obj": ["c", vinfo["category_id"]], "props": [], "polarity": True, "args": []}
                if is_a_pat not in condition_patterns:
                    condition_patterns.append(is_a_pat)
                if vinfo["np"].modifiers:
                    condition_patterns.append({"relation": "property", "subject": vname, "verb": None, "obj": None,
                                               "props": [self.repo.concept(p) for p in vinfo["np"].modifiers],
                                               "polarity": True, "args": []})

        conclusion_patterns = [self._pattern(f, match_var) for f in conclusions]

        only = condition_patterns[0] if len(condition_patterns) == 1 else None
        if only and only["relation"] == "is_a" and only["subject"] == "x" and only["polarity"] \
                and all(p["relation"] == "is_a" and p["subject"] == "x" for p in conclusion_patterns):
            narrower = ("c", only["obj"][1])
            return [("a", self.repo.add_assertion(narrower, "subclass_of", ("c", p["obj"][1]), p["polarity"],
                                                  uid, rule.confidence)) for p in conclusion_patterns]

        primary_var_name = "x" if "x" in vars_dict else next(iter(vars_dict.keys())) if vars_dict else None
        primary_var = vars_dict[primary_var_name]["np"] if primary_var_name else None
        primary_typed = vars_dict[primary_var_name]["typed"] if primary_var_name else False
        variable = self._variable_display(primary_var, primary_typed)
        variable["vars"] = {v: self._variable_display(vinfo["np"], vinfo["typed"]) for v, vinfo in vars_dict.items()}

        return [("r", self.repo.add_rule(condition_patterns, conclusion_patterns, variable, rule.confidence, uid))]

    def _is_a_pattern(self, var: NounPhrase) -> dict:
        return {"relation": "is_a", "subject": "x", "verb": None, "obj": ["c", self.resolver.category(var, True)],
                "props": [], "polarity": True, "args": []}

    @staticmethod
    def _variable_display(var: NounPhrase | None, typed: bool) -> dict:
        if var is None:
            return {"word": None, "pronoun": None, "plural": False, "typed": False}
        if var.quantifier:
            person = var.quantifier in PERSON_QUANTIFIERS
            return {"word": "someone" if person else "something", "pronoun": "they" if person else "it",
                    "plural": False, "typed": False}
        if var.proper:
            return {"word": var.surface, "pronoun": var.surface, "plural": False, "typed": False}
        if var.plural:
            return {"word": var.surface.lower(), "pronoun": "they", "plural": True, "typed": typed}
        person = var.head in PERSON_WORDS
        return {"word": f"{article(var.head)} {var.head}", "pronoun": "they" if person else "it",
                "plural": False, "typed": typed}

    def _spec(self, np: NounPhrase, match_var=None) -> list | str:
        if match_var:
            v = match_var(np)
            if v:
                return v
        if np.pronoun or np.proper or np.possessor is not None or np.determiner in DEFINITE_DETS:
            return list(self.resolver.resolve(np, "object", True))
        self.repo.note_lexeme(np.head, "noun")
        return ["kind", self.repo.concept(np.head), list(np.modifiers), np.determiner is None]

    def _pattern(self, frame: Frame, match_var) -> dict:
        if frame.subject is None:
            raise Unsupported("Part of that rule has no subject.")
        subj_var = match_var(frame.subject)
        if subj_var:
            subject = subj_var
        else:
            subject = list(self.resolver.resolve(frame.subject, "subject", True))
        pattern = {"relation": frame.relation, "subject": subject, "verb": frame.verb,
                   "polarity": frame.polarity, "obj": None, "props": [], "args": []}
        if frame.relation == "is_a":
            pattern["obj"] = ["c", self.resolver.category(frame.obj, True)]
        elif frame.relation == "property":
            pattern["props"] = [self.repo.concept(p) for p in frame.properties]
            pattern["args"] = [[role, value if isinstance(value, str) else self._spec(value, match_var)]
                               for role, value in frame.args if value is not None]
        elif frame.relation == "rel":
            self.repo.note_lexeme(frame.verb, "verb")
            if frame.obj is not None:
                obj_var = match_var(frame.obj)
                if obj_var:
                    pattern["obj"] = obj_var
                else:
                    pattern["obj"] = self._spec(frame.obj, match_var)
            pattern["args"] = [[role, value if isinstance(value, str) else self._spec(value, match_var)]
                               for role, value in frame.args if value is not None]
        else:
            raise Unsupported("I can't use that kind of clause inside a rule.")
        return pattern

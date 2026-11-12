"""Bounded backward chaining over typed relations.

Only subclass_of is transitive. Positive and negative evidence are gathered separately, so
every yes/no answer is yes, no, conflicting, or unknown, never a guess. Wh-questions return
every supported fact that fills the asked-for slot.
"""

from collections import deque

from db.repository import Repository, Term
from nlp.lexicon import PREPOSITIONS
from nlp.semantic_frames import Frame
from reasoning.proofs import CONFLICTING, NO, UNKNOWN, YES, Answer, Proof, Query, Spec

LOCATIVE = {"in", "at", "to", "near", "from", "on", "inside", "into", "by", "under", "behind",
            "outside", "across", "around", "beside", "between", "onto", "over", "toward", "towards"}
GENERIC_DISCOUNT = 0.7
RULE_DEPTH = 4  # nested rule applications allowed while proving one goal


class BudgetExceeded(Exception):
    pass


class Engine:
    def __init__(self, repo: Repository, max_depth: int = 16, budget: int = 5000,
                 semantics=None, provisional: bool = True) -> None:
        self.repo = repo
        self.provisional = provisional  # use her own still-untested patterns (as 'probably')
        self.max_depth = max_depth
        self.budget = budget
        self.semantics = semantics
        self.steps = 0
        self.remembered = {}

    def _spend(self) -> None:
        self.steps += 1
        if self.steps > self.budget:
            raise BudgetExceeded

    @property
    def none(self) -> int:
        return self.repo.none_concept()

    def _proof(self, steps: list[int], rules: list[str]) -> Proof:
        steps = list(dict.fromkeys(steps))
        confidence = min((self.repo.assertion(s)["confidence"] for s in steps), default=1.0)
        if "generic-inheritance" in rules:
            confidence *= GENERIC_DISCOUNT
        return Proof(steps, list(dict.fromkeys(rules)), confidence)

    # --- taxonomy -----------------------------------------------------------------

    def ancestors(self, concept_id: int) -> dict[int, list[int]]:
        """Every kind reachable upward (including itself) -> assertion path to it."""
        # WordNet is the starting taxonomy.  On first use, copy this concept's hypernym
        # chain into Amy's own assertions so it can be inherited, weakened or corrected.
        if self.semantics is not None:
            try:
                self.semantics.seed_concept(concept_id)
            except Exception:
                pass  # an unavailable WordNet store must never stop ordinary reasoning
        paths: dict[int, list[int]] = {concept_id: []}
        frontier = deque([concept_id])
        while frontier:
            current = frontier.popleft()
            if len(paths[current]) >= self.max_depth:
                continue
            for row in self.repo.assertions("subclass_of", subj=("c", current), polarity=True):
                self._spend()
                parent = row["obj_id"]
                if parent in paths:  # cycle, or already reached by a shorter path
                    continue
                paths[parent] = paths[current] + [row["id"]]
                frontier.append(parent)
        return paths

    def disjoint(self, a: int, c: int) -> list[Proof]:
        up_a, up_c = self.ancestors(a), self.ancestors(c)
        proofs = []
        for row in self.repo.assertions("subclass_of", polarity=False):
            self._spend()
            x, y = row["subj_id"], row["obj_id"]
            for p, q in ((x, y), (y, x)):
                if p in up_a and q in up_c:
                    proofs.append(self._proof(up_a[p] + [row["id"]] + up_c[q], ["disjointness"]))
                    break
        return proofs

    def memberships(self, term, polarity=True):
        rows = self.repo.assertions('instance_of',subj=term,polarity=polarity)
        human = self.repo.find_concept('human')
        if human:
            rows += self.repo.assertions('has_property',subj=term,obj=('c',human),polarity=polarity)
        return rows

    def subject_chain(self, term: Term) -> list[tuple[Term, list[int], list[str]]]:
        """The subject itself, then every kind it belongs to (for inherited generic facts)."""
        if term[0] == "e":
            chain = [(term, [], [])]
            for inst in self.memberships(term):
                for kind, path in self.ancestors(inst["obj_id"]).items():
                    chain.append((("c", kind), [inst["id"], *path], ["generic-inheritance"]))
            return chain
        return [(("c", k), path, ["generic-inheritance"] if path else [])
                for k, path in self.ancestors(term[1]).items()]

    # --- matching -----------------------------------------------------------------

    def _kind_paths(self, term: Term, kind: int, mods: tuple[str, ...]) -> list[int] | None:
        """Path showing `term` is a `kind` with all `mods`, or None."""
        t, ident = term
        if t == "e":
            if not set(mods) <= set(self.repo.properties(ident)):
                return None  # lacking a stated property is not evidence either way
            for inst in self.memberships(term):
                up = self.ancestors(inst["obj_id"])
                if kind in up:
                    return [inst["id"], *up[kind]]
            return None
        if ident == self.none or mods:
            return None
        return self.ancestors(ident).get(kind)

    def _value_match(self, term: Term, spec: Spec) -> list[int] | None:
        if spec is None or spec[0] == "any":
            return []
        if spec[0] == "e":
            return [] if term == spec else None
        return self._kind_paths(term, spec[1], spec[2] if spec[0] == "kind" else ())

    def obj_matches(self, row, spec: Spec | None) -> list[int] | None:
        return self._value_match((row["obj_type"], row["obj_id"]), spec)

    def neg_obj_matches(self, row, spec: Spec | None) -> list[int] | None:
        """Does this negative claim rule out `spec`? ('owns no vehicle' rules out a truck.)"""
        term = (row["obj_type"], row["obj_id"])
        if term == ("c", self.none):
            return []  # "Howard doesn't drive" rules out driving anything
        if spec is None or spec[0] == "any":
            return None
        if spec[0] == "e":
            if term == spec:
                return []
            if term[0] == "c":
                for inst in self.repo.assertions("instance_of", subj=spec, polarity=True):
                    up = self.ancestors(inst["obj_id"])
                    if term[1] in up:
                        return [inst["id"], *up[term[1]]]
            return None
        if term[0] == "c":
            return self.ancestors(spec[1]).get(term[1])
        return None

    def _row_args(self, row) -> list:
        return [a for a in self.repo.args(row["id"]) if not a["role"].startswith("_") and a["role"] != "modality"]

    def args_match(self, row, wanted: tuple) -> list[int] | None:
        have = self._row_args(row)
        paths: list[int] = []
        for role, value in wanted:
            found = None
            for a in have:
                if a["role"] != role:
                    continue
                if isinstance(value, str):
                    if a["literal"] == value:
                        found = []
                        break
                elif a["value_type"] != "lit":
                    found = self._value_match((a["value_type"], a["value_id"]), value)
                    if found is not None:
                        break
            if found is None:
                return None
            paths += found
        return paths

    def neg_args_ok(self, row, wanted: tuple) -> bool:
        """A negative claim with extra detail ('didn't go to Ohio') only rules out that detail."""
        for a in self._row_args(row):
            literal_hit = any(r == a["role"] and v == a["literal"] for r, v in wanted if isinstance(v, str))
            term_hit = any(r == a["role"] and not isinstance(v, str) and v == (a["value_type"], a["value_id"])
                           for r, v in wanted)
            if not (literal_hit or term_hit):
                return False
        return True

    def _slot_ok(self, row, slot: str | None) -> bool:
        if slot in (None, "object", "subject"):
            return True
        roles = {a["role"] for a in self._row_args(row)}
        if slot == "where":
            return bool(roles & LOCATIVE)
        if slot == "when":
            return "time" in roles
        if slot in PREPOSITIONS:
            return slot in roles
        return True

    # --- queries ------------------------------------------------------------------

    def ask(self, query: Query, frame: Frame | None = None) -> Answer:
        self.steps = 0
        self.goals: list[tuple] = []
        self.rules = self.repo.active_rules() + (self.repo.provisional_rules() if self.provisional else [])
        exhausted = False
        try:
            support, against = self._solve(query)
        except BudgetExceeded:
            support, against, exhausted = [], [], True
        if query.slot or query.relation == "describe":
            status = YES if support else UNKNOWN
        elif support and against:
            status = CONFLICTING
        elif support:
            status = YES
        elif against:
            status = NO
        else:
            status = UNKNOWN
        support.sort(key=lambda p: -p.confidence)
        return Answer(status, frame, support, against, [], exhausted, self.steps, query)

    def counterfactual(self, query: Query, suppress_steps: list[int]) -> dict:
        """Evaluate hypothetical status if specified premise steps had not occurred."""
        orig = getattr(self, "_suppress_steps", set())
        try:
            self._suppress_steps = orig | set(suppress_steps)
            ans = self.ask(query)
            dep = ans.status != YES
            return {
                "hypothetical_status": ans.status,
                "dependent": dep,
                "explanation": "The conclusion depends on those premises." if dep else "The conclusion still holds via alternative support."
            }
        finally:
            self._suppress_steps = orig

    def _solve(self, q: Query) -> tuple[list[Proof], list[Proof]]:
        handler = {"rel": self._rel, "is_a": self._is_a, "property": self._property,
                   "describe": self._describe}[q.relation]
        support, against = handler(q)
        remembered = self.remembered.get(repr(q))
        if remembered is not None:
            self._spend()
            (support if remembered.derived[0].get('polarity', True) else against).append(remembered)
        if q.relation != "describe" and q.slot in (None, "subject", "object") and not (q.subject and q.subject[0]=="kind"):
            by_rule_for, by_rule_against = self._via_rules(q)
            support += by_rule_for
            against += by_rule_against

        suppressed = getattr(self, "_suppress_steps", set())
        if suppressed:
            support = [p for p in support if not (set(p.steps) & suppressed)]
            against = [p for p in against if not (set(p.steps) & suppressed)]

        return support, against

    # --- learned if-then rules (backward chaining) ---------------------------------

    @staticmethod
    def _spec(js) -> Spec | None:
        if js is None:
            return None
        if isinstance(js, str):
            return js
        if js[0] == "kind":
            return ("kind", js[1], tuple(js[2]))
        return (js[0], js[1])

    def _instantiate(self, pattern: dict, subst_or_x) -> Query:
        subst = subst_or_x if isinstance(subst_or_x, dict) else {"x": subst_or_x}
        subj = pattern["subject"]
        if isinstance(subj, str):
            subject = subst.get(subj, None)
        else:
            subject = self._spec(subj)

        obj_val = pattern.get("obj")
        if isinstance(obj_val, str):
            obj = subst.get(obj_val, ("any",) if pattern["relation"] == "rel" else None)
        else:
            obj = self._spec(obj_val)

        if pattern["relation"] == "rel" and obj is None:
            obj = ("any",)
        args = tuple((role, subst.get(value, value) if isinstance(value, str) else self._spec(value)) for role, value in pattern.get("args", []))
        return Query(pattern["relation"], subject, obj, verb=pattern.get("verb"),
                     properties=tuple(pattern.get("props", ())), args=args)

    def _unify(self, pattern: dict, q: Query):
        """Can this rule conclusion answer q? Returns (subject term or None, taxonomy path, subst dict)."""
        if pattern["relation"] != q.relation or (q.relation == "rel" and pattern.get("verb") != q.verb):
            return None
        subst: dict[str, Term] = {}
        path: list[int] = []

        # Unify subject
        subj = pattern["subject"]
        if isinstance(subj, str):
            if q.subject is not None:
                subst[subj] = q.subject
        else:
            spec_subj = self._spec(subj)
            if q.subject is not None and q.subject != spec_subj:
                return None

        # Unify object / properties
        if q.relation == "is_a":
            obj_val = pattern.get("obj")
            if isinstance(obj_val, str):
                if q.obj is not None:
                    subst[obj_val] = q.obj
            elif obj_val is not None:
                found = self.ancestors(obj_val[1]).get(q.obj[1])
                if found is None:
                    return None
                path = found
        elif q.relation == "property":
            if not set(q.properties) <= set(pattern.get("props", ())):
                return None
        else:
            obj_val = pattern.get("obj")
            if isinstance(obj_val, str):
                if q.obj is not None and q.obj[0] != "any":
                    subst[obj_val] = q.obj
            else:
                have, want = self._spec(obj_val), q.obj
                if want is not None and want[0] != "any":
                    if have is None:
                        return None
                    if want[0] == "e" or have[0] == "e":
                        if have != want:
                            return None
                    else:
                        found = self.ancestors(have[1]).get(want[1])
                        want_mods = want[2] if want[0] == "kind" else ()
                        have_mods = have[2] if have[0] == "kind" else ()
                        if found is None or not set(want_mods) <= set(have_mods):
                            return None
                        path = found
            pat_arg_dict = {r: v for r, v in pattern.get("args", [])}
            for q_role, q_val in q.args:
                if q_role not in pat_arg_dict:
                    return None
                pat_val = pat_arg_dict[q_role]
                if isinstance(pat_val, str):
                    subst[pat_val] = q_val
                elif self._spec(pat_val) != q_val:
                    return None

        subject = subst.get(subj) if isinstance(subj, str) else (self._spec(subj) if subj is not None else None)
        return (subject, path, subst)

    def _prove_conditions(self, rule: dict, initial_subst: dict[str, Term]) -> list[tuple[dict[str, Term], list[int], float, list[int], list[dict]]]:
        results = []
        conditions = rule["conditions"]
        # The rule's variables: the names it uses where a subject or object goes, and any it declares. A word in an
        # argument that isn't one of them is the word itself ("later" in "... one hour later"), never a variable.
        variables = {spec for pat in conditions + rule.get("conclusions", []) for spec in (pat.get("subject"), pat.get("obj"))
                     if isinstance(spec, str)} | set((rule.get("variable") or {}).get("vars") or {})
        # The subject of a condition: what its variable stands for, or the thing it names outright.
        subject_of = lambda spec, subst: subst[spec] if isinstance(spec, str) else self._spec(spec)

        def search(idx: int, cur_subst: dict[str, Term], steps: list[int], conf: float, used: list[int], derivs: list[dict]):
            if idx == len(conditions):
                results.append((cur_subst, steps, conf, used, derivs))
                return

            pat = conditions[idx]
            subj_spec = pat["subject"]
            obj_spec = pat.get("obj")

            subj_unbound = isinstance(subj_spec, str) and subj_spec not in cur_subst
            obj_unbound = isinstance(obj_spec, str) and obj_spec not in cur_subst

            pat_args = pat.get("args", [])
            unbound_arg = next(((r, v) for r, v in pat_args if isinstance(v, str) and v in variables and v not in cur_subst), None)

            if not subj_unbound and not obj_unbound and not unbound_arg:
                q = self._instantiate(pat, cur_subst)
                support, against = self._solve(q)
                if not support or against:
                    return
                best = max(support, key=lambda p: p.confidence)
                search(idx + 1, cur_subst, steps + best.steps, min(conf, best.confidence),
                       used + best.learned_rules, derivs + best.derivation_steps)
            elif not subj_unbound and unbound_arg:
                role, arg_var = unbound_arg
                q = Query(pat["relation"], subject_of(subj_spec, cur_subst), ("any",), verb=pat.get("verb"))
                support, against = self._solve(q)
                for p in support:
                    for aid in p.steps:
                        for arg_row in self.repo.args(aid):
                            if arg_row["role"] == role and arg_row["value_id"] is not None:
                                val_arg = (arg_row["value_type"], arg_row["value_id"])
                                new_subst = {**cur_subst, arg_var: val_arg}
                                search(idx, new_subst, steps + p.steps, min(conf, p.confidence),
                                       used + p.learned_rules, derivs + p.derivation_steps)
            elif not subj_unbound and obj_unbound:
                if pat["relation"] == "rel":
                    q = Query(pat["relation"], subject_of(subj_spec, cur_subst), ("any",), verb=pat.get("verb"))
                    support, against = self._solve(q)
                    for p in support:
                        for aid in p.steps:
                            row = self.repo.assertion(aid)
                            if row and row["polarity"] and row["status"] == "active" and row["obj_id"] is not None:
                                val_obj = (row["obj_type"], row["obj_id"])
                                new_subst = {**cur_subst, obj_spec: val_obj}
                                search(idx + 1, new_subst, steps + p.steps, min(conf, p.confidence),
                                       used + p.learned_rules, derivs + p.derivation_steps)
                elif pat["relation"] == "is_a":
                    pass
            elif subj_unbound and not obj_unbound:
                val_obj = cur_subst.get(obj_spec) if isinstance(obj_spec, str) else self._spec(obj_spec)
                if pat["relation"] == "is_a":
                    cid = val_obj[1] if val_obj else None
                    if cid:
                        named = [r[0] for r in self.repo.conn.execute(
                            "SELECT DISTINCT subj_id FROM assertions WHERE predicate='instance_of' AND obj_type='c' AND obj_id=? AND polarity=1 AND status='active'",
                            (cid,)).fetchall()]
                        for eid in set(self.repo.instances_of(cid) + named):
                            new_subst = {**cur_subst, subj_spec: ("e", eid)}
                            search(idx + 1, new_subst, steps, conf, used, derivs)
                elif pat["relation"] == "rel":
                    q = Query(pat["relation"], None, val_obj, verb=pat.get("verb"), slot="subject")
                    support, against = self._solve(q)
                    for p in support:
                        for aid in p.steps:
                            row = self.repo.assertion(aid)
                            if row and row["polarity"] and row["status"] == "active":
                                val_subj = (row["subj_type"], row["subj_id"])
                                new_subst = {**cur_subst, subj_spec: val_subj}
                                search(idx + 1, new_subst, steps + p.steps, min(conf, p.confidence),
                                       used + p.learned_rules, derivs + p.derivation_steps)
            else:
                for cand in self.repo.subject_entities():
                    new_subst = {**cur_subst, subj_spec: cand}
                    search(idx, new_subst, steps, conf, used, derivs)

        search(0, initial_subst, [], 1.0, [], [])
        return results

    def _via_rules(self, q: Query) -> tuple[list[Proof], list[Proof]]:
        goal = (q.relation, q.subject, q.verb, q.obj, q.properties, q.args)
        if goal in self.goals or len(self.goals) >= RULE_DEPTH:
            return [], []  # cycle, or too deep
        self.goals.append(goal)
        try:
            support, against = [], []
            for rule in self.rules:
                for pattern in rule["conclusions"]:
                    self._spend()
                    bound = self._unify(pattern, q)
                    if bound is None:
                        continue
                    subject, path, initial_subst = bound
                    subj_spec = pattern["subject"]
                    candidates_list = [initial_subst]
                    if isinstance(subj_spec, str) and subj_spec not in initial_subst:
                        candidates_list = [{**initial_subst, subj_spec: c} for c in self.repo.subject_entities()]

                    for init_s in candidates_list:
                        proved_list = self._prove_conditions(rule, init_s)
                        for proved in proved_list:
                            final_subst, steps, confidence, used, derivations = proved
                            proof = Proof(list(dict.fromkeys(steps + path)), ["learned-rule"],
                                          min(confidence, rule["confidence"]),
                                          list(dict.fromkeys(used + [rule["id"]])), (pattern, final_subst))
                            from dialogue import realizer
                            proof.derivation_steps = list(derivations) + [dict(
                                rule_id=rule['id'], premises=list(dict.fromkeys(steps + path)),
                                conclusion=realizer.derived_text(self.repo, proof))]
                            (support if pattern["polarity"] else against).append(proof)
            return support, against
        finally:
            self.goals.pop()

    def _rel(self, q: Query) -> tuple[list[Proof], list[Proof]]:
        predicate = "rel:%" if q.verb == "be" and q.slot == "where" else f"rel:{q.verb}"
        support: list[Proof] = []
        against: list[Proof] = []
        if q.subject is not None and q.subject[0] == 'kind':
            for entity in self.repo.subject_entities():
                self._spend()
                if entity[0]!='e': continue
                membership=self._kind_paths(entity,q.subject[1],q.subject[2])
                if membership is None: continue
                _,disputed=self._is_a(Query('is_a',entity,('c',q.subject[1])))
                if disputed: continue
                goal=Query('rel',entity,q.obj,verb=q.verb,args=q.args)
                witnesses,_=self._solve(goal)
                for proof in witnesses:
                    merged=self._proof(list(dict.fromkeys(membership+proof.steps)),['existential-subject',*proof.rules])
                    merged.confidence=min(merged.confidence,proof.confidence)
                    merged.learned_rules=proof.learned_rules
                    merged.derivation_steps=proof.derivation_steps
                    support.append(merged)
            # An individual's failure cannot refute existence of some other witness.
            _,against=self._rel(Query('rel',('c',q.subject[1]),q.obj,verb=q.verb,args=q.args))
            return support,against
        if q.subject is None:
            for row in self.repo.assertions(predicate, polarity=True):
                self._spend()
                op = self.obj_matches(row, q.obj)
                ap = self.args_match(row, q.args) if op is not None else None
                if ap is not None:
                    support.append(self._proof([row["id"], *op, *ap], ["stated"]))
            return support, against

        for sterm, spath, srules in self.subject_chain(q.subject):
            for row in self.repo.assertions(predicate, subj=sterm):
                self._spend()
                if row["polarity"]:
                    op = self.obj_matches(row, q.obj)
                    ap = self.args_match(row, q.args) if op is not None else None
                    if ap is None or not self._slot_ok(row, q.slot):
                        continue
                    rules = srules + (["relation-by-kind"] if op else ["stated"])
                    support.append(self._proof([*spath, row["id"], *op, *ap], rules))
                elif q.slot is None:
                    op = self.neg_obj_matches(row, q.obj)
                    if op is None or not self.neg_args_ok(row, q.args):
                        continue
                    rules = srules + (["negative-kind-inheritance"] if op else ["stated"])
                    against.append(self._proof([*spath, row["id"], *op], rules))
        return support, against

    def _is_a(self, q: Query) -> tuple[list[Proof], list[Proof]]:
        kind = q.obj[1]
        if q.subject is None:
            support = []
            for row in self.repo.assertions("instance_of", polarity=True):
                self._spend()
                up = self.ancestors(row["obj_id"])
                if kind in up:
                    support.append(self._proof([row["id"], *up[kind]], ["instance-inheritance"]))
            return support, []

        if q.subject[0] == "e":
            entity = q.subject
            support, against = [], []
            up_kind = self.ancestors(kind)
            for inst in self.memberships(entity):
                up = self.ancestors(inst["obj_id"])
                if kind in up:
                    support.append(self._proof([inst["id"], *up[kind]],
                                               ["instance-inheritance"] if up[kind] else ["stated"]))
                for proof in self.disjoint(inst["obj_id"], kind):
                    against.append(self._proof([inst["id"], *proof.steps], ["instance-inheritance", "disjointness"]))
            for neg in self.memberships(entity,False):
                if neg["obj_id"] in up_kind:
                    against.append(self._proof([neg["id"], *up_kind[neg["obj_id"]]], ["stated"]))
            return support, against

        narrower = q.subject[1]
        up = self.ancestors(narrower)
        support = []
        if kind in up:
            rule = "identity" if not up[kind] else ("stated" if len(up[kind]) == 1 else "subclass-transitivity")
            support.append(self._proof(up[kind], [rule]))
        return support, self.disjoint(narrower, kind)

    def _property(self, q: Query) -> tuple[list[Proof], list[Proof]]:
        if q.subject is None:
            return [self._proof([r["id"]], ["stated"]) for p in q.properties
                    for r in self.repo.assertions("has_property", obj=("c", p), polarity=True)], []
        support, against = [], []
        every_property_supported = True
        for prop in q.properties:
            found = False
            for sterm, spath, srules in self.subject_chain(q.subject):
                for row in self.repo.assertions("has_property", subj=sterm, obj=("c", prop)):
                    self._spend()
                    argument_path = self.args_match(row, q.args)
                    if argument_path is None or (not row['polarity'] and not self.neg_args_ok(row, q.args)):
                        continue
                    proof = self._proof([*spath, row["id"], *argument_path], srules or ["stated"])
                    if row["polarity"]:
                        support.append(proof)
                        found = True
                    else:
                        against.append(proof)
            every_property_supported &= found
        return (support if every_property_supported else []), against

    def _describe(self, q: Query) -> tuple[list[Proof], list[Proof]]:
        rows = []
        for predicate in ("instance_of", "subclass_of", "has_property", "rel:%"):
            rows += self.repo.assertions(predicate, subj=q.subject)
        if q.subject[0] == "e":
            rows += [r for r in self.repo.assertions("rel:own", obj=q.subject)]
        return [self._proof([r["id"]], ["stated"]) for r in rows], []


def query_from_row(repo: Repository, row) -> Query:
    """The yes/no question a stored claim answers; used to detect conflicts on teaching."""
    subject = (row["subj_type"], row["subj_id"])
    predicate = row["predicate"]
    if predicate in ("instance_of", "subclass_of"):
        return Query("is_a", subject, ("c", row["obj_id"]))
    if predicate == "has_property":
        return Query("property", subject, properties=(row["obj_id"],))
    obj_term = (row["obj_type"], row["obj_id"])
    if obj_term == ("c", repo.none_concept()):
        obj = ("any",)
    elif obj_term[0] == "e" and not repo.entity_row(obj_term[1])["proper"]:
        ent = repo.entity_row(obj_term[1])
        obj = ("kind", ent["kind_concept_id"], tuple(repo.properties(ent["id"])))
    else:
        obj = obj_term
    args = []
    for a in repo.args(row["id"]):
        if a["role"].startswith("_") or a["role"] == "modality":
            continue
        args.append((a["role"], a["literal"] if a["value_type"] == "lit" else (a["value_type"], a["value_id"])))
    return Query("rel", subject, obj, verb=predicate[4:], args=tuple(args))

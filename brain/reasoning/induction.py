"""Inductive rule induction across the assertion graph and dialogue history.

Mines regularities:
1. Class-property associations (entities of kind K with property P almost always have property Q)
2. Property implications (entities with property P almost always have property Q)
3. Multi-hop relational chains (e.g. X lives_in Y and Y in Z => X in Z)
4. Temporal event sequences (event A precedes event B)
5. Causal candidates (actions/events correlated with outcomes)

Confidence updates follow a delta rule:
    w_{t+1} = w_t + lr * (target - w_t)
where target = 1.0 on confirmation and 0.0 on disconfirmation / counterexample.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import json
import math
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from db.repository import Repository


class InductionEngine:
    PROVISIONAL_CAP = 0.70   # below realizer.PROBABLE, so answers from it say "probably"
    PROMOTE_AT = 0.90        # confirmations past this settle the rule

    def __init__(self, repo: Repository, min_support: int = 2, min_confidence: float = 0.60, lr: float = 0.20):
        self.repo = repo
        self.min_support = min_support
        self.min_confidence = min_confidence
        self.lr = lr
        self._ensure_tables()

    def _ensure_tables(self) -> None:
        self.repo.conn.executescript("""
            CREATE TABLE IF NOT EXISTS rule_induction_log(
                id INTEGER PRIMARY KEY,
                rule_id INTEGER NOT NULL,
                event TEXT NOT NULL,
                delta REAL NOT NULL,
                old_confidence REAL NOT NULL,
                new_confidence REAL NOT NULL,
                evidence_id INTEGER,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rule_induction_counts(
                rule_id INTEGER PRIMARY KEY,
                support INTEGER NOT NULL,
                against INTEGER NOT NULL
            );
        """)

    @staticmethod
    def _key(conditions, conclusions) -> tuple[str, str]:
        return json.dumps(conditions), json.dumps(conclusions)

    def _induced(self) -> dict[tuple[str, str], dict]:
        return {self._key(r["conditions"], r["conclusions"]): r
                for r in self.repo.active_rules() + self.repo.provisional_rules()
                if str(r["variable"].get("origin", "")).startswith("induction")}

    def step(self, uid: int | None = None) -> list[int]:
        """Mine regularities. A new one is installed as a provisional rule; a known one is not
        reinstalled (that would undo its earned confidence) but has its evidence counted."""
        new_rule_ids = []
        known = self._induced()
        for cand in self.mine_regularities():
            if self._key(cand["conditions"], cand["conclusions"]) in known:
                continue
            # A pattern is a hypothesis, not a law: held below 'probable' until it earns promotion.
            rule_id = self.repo.add_rule(cand["conditions"], cand["conclusions"], cand["variable"],
                                         min(cand["confidence"], self.PROVISIONAL_CAP), uid, status="provisional")
            with self.repo.conn:
                self.repo.conn.execute("INSERT OR REPLACE INTO rule_induction_counts VALUES(?,?,?)",
                                       (rule_id, cand["variable"].get("support", 0),
                                        self._counterexamples(cand["conditions"], cand["conclusions"])))
            new_rule_ids.append(rule_id)
        self.recheck()
        return new_rule_ids

    def recheck(self) -> list[int]:
        """Update each induced rule from the evidence that changed since it was last counted:
        every new supporting instance is a confirmation, every new counterexample or lost
        support a disconfirmation. A member we know nothing else about is neither: unknown
        is not negative. Rules whose counts didn't move are left alone, so an unrelated
        retraction never wears them down."""
        mined = {self._key(c["conditions"], c["conclusions"]): c["variable"] for c in self.mine_regularities()}
        changed = []
        for key, rule in self._induced().items():
            row = self.repo.conn.execute("SELECT support, against FROM rule_induction_counts WHERE rule_id=?",
                                         (rule["id"],)).fetchone()
            old_support, old_against = (row[0], row[1]) if row else (rule["variable"].get("support", 0), 0)
            now = mined.get(key)
            # Below minimum support the pattern isn't mined at all: count that as its support gone.
            support = now.get("support", 0) if now else 0
            against = self._counterexamples(rule["conditions"], rule["conclusions"])
            confirms = max(0, support - old_support)
            disconfirms = max(0, old_support - support) + max(0, against - old_against)
            if not confirms and not disconfirms:
                continue
            for _ in range(confirms):
                self.update_delta(rule["id"], confirmed=True)
            for _ in range(disconfirms):
                self.update_delta(rule["id"], confirmed=False)
            with self.repo.conn:
                self.repo.conn.execute("INSERT OR REPLACE INTO rule_induction_counts VALUES(?,?,?)",
                                       (rule["id"], support, against))
            changed.append(rule["id"])
        return changed

    def _counterexamples(self, conditions: list, conclusions: list) -> int:
        """Entities meeting a one-condition rule that are explicitly said to lack its property."""
        if len(conditions) != 1 or len(conclusions) != 1 or conclusions[0]["relation"] != "property":
            return 0
        cond, props = conditions[0], conclusions[0]["props"]
        if cond["relation"] == "is_a" and cond.get("obj"):
            pred, obj = "instance_of", cond["obj"][1]
        elif cond["relation"] == "property" and cond.get("props"):
            pred, obj = "has_property", cond["props"][0]
        else:
            return 0
        return self.repo.conn.execute(f"""
            SELECT COUNT(DISTINCT a.subj_id) FROM assertions a
            JOIN assertions b ON b.subj_type = a.subj_type AND b.subj_id = a.subj_id
            WHERE a.status = 'active' AND a.polarity = 1 AND a.predicate = ? AND a.obj_id = ?
              AND b.status = 'active' AND b.polarity = 0 AND b.predicate = 'has_property'
              AND b.obj_id IN ({",".join("?" * len(props))})
        """, (pred, obj, *props)).fetchone()[0]

    def mine_regularities(self) -> list[dict]:
        """Mine statistical regularities across active assertions."""
        candidates = []
        candidates.extend(self._mine_class_properties())
        candidates.extend(self._mine_property_implications())
        candidates.extend(self._mine_multi_hop_relations())
        candidates.extend(self._mine_causal_candidates())
        return candidates

    def _mine_class_properties(self) -> list[dict]:
        """Find kind K where members consistently have property P."""
        # Query active instances and their properties
        rows = self.repo.conn.execute("""
            SELECT a.obj_id AS kind_id, b.obj_id AS prop_id, COUNT(DISTINCT a.subj_id) AS support
            FROM assertions a
            JOIN assertions b ON a.subj_id = b.subj_id AND a.subj_type = b.subj_type
            WHERE a.status = 'active' AND b.status = 'active'
              AND a.polarity = 1 AND b.polarity = 1
              AND a.predicate = 'instance_of' AND b.predicate = 'has_property'
              AND a.subj_type = 'e'
            GROUP BY a.obj_id, b.obj_id
            HAVING support >= ?
        """, (self.min_support,)).fetchall()

        # Total instances per kind
        kind_totals = dict(self.repo.conn.execute("""
            SELECT obj_id, COUNT(DISTINCT subj_id)
            FROM assertions
            WHERE status = 'active' AND polarity = 1 AND predicate = 'instance_of' AND subj_type = 'e'
            GROUP BY obj_id
        """).fetchall())

        candidates = []
        for r in rows:
            kind_id, prop_id, support = r["kind_id"], r["prop_id"], r["support"]
            total = kind_totals.get(kind_id, support)
            # Laplace smoothed confidence
            conf = (support + 1) / (total + 2)
            if conf >= self.min_confidence and support >= self.min_support:
                kind_lemma = self.repo.concept_lemma(kind_id)
                prop_lemma = self.repo.concept_lemma(prop_id)
                cand = {
                    "conditions": [
                        {"relation": "is_a", "subject": "x", "verb": None, "obj": ["c", kind_id], "props": [], "args": [], "polarity": True}
                    ],
                    "conclusions": [
                        {"relation": "property", "subject": "x", "verb": None, "obj": None, "props": [prop_id], "args": [], "polarity": True}
                    ],
                    "variable": {
                        "word": f"a {kind_lemma}",
                        "pronoun": "it",
                        "plural": False,
                        "typed": True,
                        "origin": "induction:class_property",
                        "support": support,
                        "total": total
                    },
                    "confidence": round(conf, 3)
                }
                candidates.append(cand)
        return candidates

    def _mine_property_implications(self) -> list[dict]:
        """Find property P1 -> property P2 implications across entities."""
        rows = self.repo.conn.execute("""
            SELECT a.obj_id AS p1, b.obj_id AS p2, COUNT(DISTINCT a.subj_id) AS joint_support
            FROM assertions a
            JOIN assertions b ON a.subj_id = b.subj_id AND a.subj_type = b.subj_type
            WHERE a.status = 'active' AND b.status = 'active'
              AND a.polarity = 1 AND b.polarity = 1
              AND a.predicate = 'has_property' AND b.predicate = 'has_property'
              AND a.obj_id != b.obj_id
            GROUP BY a.obj_id, b.obj_id
            HAVING joint_support >= ?
        """, (self.min_support,)).fetchall()

        prop_totals = dict(self.repo.conn.execute("""
            SELECT obj_id, COUNT(DISTINCT subj_id)
            FROM assertions
            WHERE status = 'active' AND polarity = 1 AND predicate = 'has_property'
            GROUP BY obj_id
        """).fetchall())

        candidates = []
        for r in rows:
            p1, p2, support = r["p1"], r["p2"], r["joint_support"]
            total = prop_totals.get(p1, support)
            conf = (support + 1) / (total + 2)
            if conf >= self.min_confidence and support >= self.min_support:
                p1_lemma = self.repo.concept_lemma(p1)
                p2_lemma = self.repo.concept_lemma(p2)
                cand = {
                    "conditions": [
                        {"relation": "property", "subject": "x", "verb": None, "obj": None, "props": [p1], "args": [], "polarity": True}
                    ],
                    "conclusions": [
                        {"relation": "property", "subject": "x", "verb": None, "obj": None, "props": [p2], "args": [], "polarity": True}
                    ],
                    "variable": {
                        "word": "someone",
                        "pronoun": "they",
                        "plural": False,
                        "typed": False,
                        "origin": "induction:property_property",
                        "support": support,
                        "total": total
                    },
                    "confidence": round(conf, 3)
                }
                candidates.append(cand)
        return candidates

    def _mine_multi_hop_relations(self) -> list[dict]:
        """Mine multi-variable relational composition: X rel1 Y and Y rel2 Z => X rel3 Z."""
        # Find frequent transitive relational paths across entities
        rows = self.repo.conn.execute("""
            SELECT a.predicate AS p1, b.predicate AS p2, c.predicate AS p3, COUNT(*) as support
            FROM assertions a
            JOIN assertions b ON a.obj_id = b.subj_id AND a.obj_type = b.subj_type
            JOIN assertions c ON a.subj_id = c.subj_id AND a.subj_type = c.subj_type AND b.obj_id = c.obj_id AND b.obj_type = c.obj_type
            WHERE a.status = 'active' AND b.status = 'active' AND c.status = 'active'
              AND a.polarity = 1 AND b.polarity = 1 AND c.polarity = 1
              AND a.predicate LIKE 'rel:%' AND b.predicate LIKE 'rel:%' AND c.predicate LIKE 'rel:%'
            GROUP BY a.predicate, b.predicate, c.predicate
            HAVING support >= ?
        """, (self.min_support,)).fetchall()

        candidates = []
        for r in rows:
            p1, p2, p3, support = r["p1"][4:], r["p2"][4:], r["p3"][4:], r["support"]
            cand = {
                "conditions": [
                    {"relation": "rel", "subject": "x", "verb": p1, "obj": "y", "props": [], "args": [], "polarity": True},
                    {"relation": "rel", "subject": "y", "verb": p2, "obj": "z", "props": [], "args": [], "polarity": True}
                ],
                "conclusions": [
                    {"relation": "rel", "subject": "x", "verb": p3, "obj": "z", "props": [], "args": [], "polarity": True}
                ],
                "variable": {
                    "vars": {
                        "x": {"word": "someone", "pronoun": "they"},
                        "y": {"word": "something", "pronoun": "it"},
                        "z": {"word": "something", "pronoun": "it"}
                    },
                    "word": "someone",
                    "pronoun": "they",
                    "plural": False,
                    "typed": False,
                    "origin": "induction:multi_hop",
                    "support": support
                },
                "confidence": 0.75
            }
            candidates.append(cand)
        return candidates

    def _mine_causal_candidates(self) -> list[dict]:
        """Elevate recurring causal claims from causal_claims table into general causal rules."""
        # Check if causal_claims table exists
        exists = self.repo.conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='causal_claims'").fetchone()
        if not exists:
            return []

        rows = self.repo.conn.execute("SELECT * FROM causal_claims WHERE status='claimed'").fetchall()
        # Find frequent cause predicate -> effect predicate pairs
        pairs = Counter()
        for row in rows:
            effect_ids = json.loads(row["effect_ids"])
            cause_ids = json.loads(row["cause_ids"])
            for eid in effect_ids:
                eff = self.repo.assertion(eid)
                for cid in cause_ids:
                    cau = self.repo.assertion(cid)
                    if eff and cau and eff["status"] == "active" and cau["status"] == "active":
                        eff_key = (eff["predicate"], eff["obj_type"], eff["obj_id"])
                        cau_key = (cau["predicate"], cau["obj_type"], cau["obj_id"])
                        pairs[(cau_key, eff_key)] += 1

        candidates = []
        for (cau_key, eff_key), support in pairs.items():
            if support >= self.min_support:
                cau_pred, cau_otype, cau_oid = cau_key
                eff_pred, eff_otype, eff_oid = eff_key
                # Build causal rule
                cond = {"relation": "property" if cau_pred == "has_property" else "is_a" if cau_pred in ("instance_of", "subclass_of") else "rel",
                        "subject": "x", "verb": cau_pred[4:] if cau_pred.startswith("rel:") else None,
                        "obj": [cau_otype, cau_oid] if cau_pred != "has_property" else None,
                        "props": [cau_oid] if cau_pred == "has_property" else [],
                        "args": [], "polarity": True}
                concl = {"relation": "property" if eff_pred == "has_property" else "is_a" if eff_pred in ("instance_of", "subclass_of") else "rel",
                         "subject": "x", "verb": eff_pred[4:] if eff_pred.startswith("rel:") else None,
                         "obj": [eff_otype, eff_oid] if eff_pred != "has_property" else None,
                         "props": [eff_oid] if eff_pred == "has_property" else [],
                         "args": [], "polarity": True, "causal": True}
                cand = {
                    "conditions": [cond],
                    "conclusions": [concl],
                    "variable": {
                        "word": "someone",
                        "pronoun": "they",
                        "plural": False,
                        "typed": False,
                        "origin": "induction:causal",
                        "support": support
                    },
                    "confidence": min(0.90, 0.5 + 0.1 * support)
                }
                candidates.append(cand)
        return candidates

    def update_delta(self, rule_id: int, confirmed: bool, evidence_id: int | None = None) -> float:
        """Delta-rule confidence update: w_{t+1} = w_t + lr * (target - w_t)."""
        rule = self.repo.rule(rule_id)
        if not rule or rule.get("status") not in ("active", "provisional"):
            return 0.0

        old_conf = float(rule.get("confidence", 1.0))
        target = 1.0 if confirmed else 0.0
        delta = self.lr * (target - old_conf)
        new_conf = round(max(0.0, min(1.0, old_conf + delta)), 4)

        with self.repo.conn:
            if new_conf < 0.35:
                # Disconfirmed below threshold: demote rule
                self.repo.conn.execute("UPDATE learned_rules SET status = 'demoted', confidence = ? WHERE id = ?",
                                       (new_conf, rule_id))
            elif rule["status"] == "provisional" and new_conf >= self.PROMOTE_AT:
                self.repo.conn.execute("UPDATE learned_rules SET status = 'active', confidence = ? WHERE id = ?",
                                       (new_conf, rule_id))
            else:
                self.repo.conn.execute("UPDATE learned_rules SET confidence = ? WHERE id = ?",
                                       (new_conf, rule_id))
            self.repo.conn.execute("""
                INSERT INTO rule_induction_log(rule_id, event, delta, old_confidence, new_confidence, evidence_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (rule_id, "confirm" if confirmed else "disconfirm", delta, old_conf, new_conf, evidence_id, time.time()))

        return new_conf

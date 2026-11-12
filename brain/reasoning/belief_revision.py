"""Intelligent Belief Revision and Conflict Clustering.

Key capabilities:
1. Justification / Dependency Tracking (JTMS-Lite):
   - When a premise is retracted or corrected, cascades down the dependency DAG.
   - If an assertion has independent support, recalibrates confidence; otherwise weakens/retracts it.
2. Inconsistency Cluster Detection:
   - Identifies contradiction clusters: direct polarity conflicts, mutually exclusive single-valued slots,
     and disjoint category memberships.
3. Epistemic Entrenchment & Conflict Resolution:
   - Compares provenance reliability (corrections > direct statements > inferences > inductive rules)
     and corroboration count.
   - If one account decisively dominates, retracts the weaker account with cascading cleanup.
   - If evidence is balanced, preserves the cluster under explicit epistemic tension without blind overwrite.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from db.repository import Repository
    from reasoning.engine import Engine


ORIGIN_WEIGHTS = {
    "correction": 0.95,
    "user_direct": 0.85,
    "observation": 0.80,
    "inference": 0.65,
    "induction": 0.60,
    "unspecified": 0.70,
}


class BeliefRevision:
    def __init__(self, repo: Repository, engine: Engine | None = None, induction=None) -> None:
        self.repo = repo
        self.engine = engine
        self.induction = induction
        self._ensure_tables()

    def _ensure_tables(self) -> None:
        self.repo.conn.executescript("""
            CREATE TABLE IF NOT EXISTS assertion_dependencies(
                derived_id INTEGER NOT NULL,
                premise_id INTEGER NOT NULL,
                rule_id INTEGER,
                PRIMARY KEY(derived_id, premise_id)
            );
            CREATE TABLE IF NOT EXISTS assertion_provenance(
                assertion_id INTEGER PRIMARY KEY, origin TEXT NOT NULL,
                source_utterance_id INTEGER, context TEXT);
            CREATE TABLE IF NOT EXISTS assertion_sources(
                assertion_id INTEGER NOT NULL, url TEXT NOT NULL, retrieved_at REAL,
                confidence REAL, status TEXT, PRIMARY KEY(assertion_id, url));
            CREATE TABLE IF NOT EXISTS conflict_clusters(
                id INTEGER PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'tension',
                topic TEXT,
                cluster_json TEXT NOT NULL,
                tension REAL NOT NULL DEFAULT 1.0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
        """)

    def record_dependency(self, derived_id: int, premise_ids: list[int], rule_id: int | None = None) -> None:
        """Record that derived_id depends on premises."""
        with self.repo.conn:
            for pid in set(premise_ids):
                if pid != derived_id:
                    self.repo.conn.execute("""
                        INSERT OR IGNORE INTO assertion_dependencies(derived_id, premise_id, rule_id)
                        VALUES (?, ?, ?)
                    """, (derived_id, pid, rule_id))

    def dependent_assertions(self, premise_id: int) -> list[int]:
        """Find all assertions directly or transitively dependent on premise_id."""
        visited = set()
        frontier = [premise_id]
        while frontier:
            curr = frontier.pop(0)
            rows = self.repo.conn.execute(
                "SELECT derived_id FROM assertion_dependencies WHERE premise_id = ?", (curr,)
            ).fetchall()
            for r in rows:
                did = r[0]
                if did not in visited:
                    visited.add(did)
                    frontier.append(did)
        return sorted(visited)

    def retract_and_cascade(self, root_id: int, uid: int | None, note: str) -> list[int]:
        """Retract root_id and cascade down the dependency graph, weakening or retracting unsupported inferences."""
        # 1. Retract the root assertion
        self.repo.retract(root_id, uid, note)
        affected = [root_id]

        # 2. Find downstream dependents
        dependents = self.dependent_assertions(root_id)
        for dep_id in dependents:
            dep_row = self.repo.assertion(dep_id)
            if not dep_row or dep_row["status"] != "active":
                continue

            # Check remaining active premises for dep_id
            premise_rows = self.repo.conn.execute("""
                SELECT p.id, p.status, p.confidence
                FROM assertion_dependencies d
                JOIN assertions p ON p.id = d.premise_id
                WHERE d.derived_id = ?
            """, (dep_id,)).fetchall()

            active_premises = [p for p in premise_rows if p["status"] == "active"]

            if not active_premises:
                # No active premises remain: retract the derived claim
                self.repo.retract(dep_id, uid, f"Cascaded retraction: premise #{root_id} was retracted ({note})")
                affected.append(dep_id)
            else:
                # Still has alternative active premises: weaken confidence
                new_conf = round(min(p["confidence"] for p in active_premises) * 0.85, 3)
                with self.repo.conn:
                    self.repo.conn.execute(
                        "UPDATE assertions SET confidence = ? WHERE id = ?", (new_conf, dep_id)
                    )
                affected.append(dep_id)

        # 3. Induced rules that leaned on it lose a step of confidence.
        if self.induction is not None:
            self.induction.recheck()
        return affected

    def arbitrate(self, old_id: int, new_id: int, uid: int | None, correction: bool, note: str) -> str:
        """A new claim contradicts an old one. Who said what decides it, not recency alone:
        - an explicit correction, or the same speaker changing their account, retires the old claim;
        - a different speaker retires it only if the new claim is decisively more credible;
        - otherwise both stay, recorded as a tension cluster to be settled by later evidence."""
        old_speaker, new_speaker = self.repo.source_speaker(old_id), self.repo.source_speaker(new_id)
        if correction or old_speaker == new_speaker:
            self.retract_and_cascade(old_id, uid, note)
            return "retract"
        if self.epistemic_entrenchment(new_id) - self.epistemic_entrenchment(old_id) >= 0.20:
            self.retract_and_cascade(old_id, uid, f"{note}; outweighed by #{new_id}")
            return "retract"
        self._hold([old_id, new_id], "speaker_disagreement")
        return "tension"

    def _hold(self, members: list[int], topic: str | None, tension: float = 1.0) -> None:
        key = json.dumps(sorted(members))
        if self.repo.conn.execute("SELECT 1 FROM conflict_clusters WHERE cluster_json=? AND status='tension'",
                                  (key,)).fetchone():
            return
        now = time.time()
        with self.repo.conn:
            self.repo.conn.execute("INSERT INTO conflict_clusters(status, topic, cluster_json, tension, created_at, updated_at) "
                                   "VALUES ('tension', ?, ?, ?, ?, ?)", (topic, key, tension, now, now))

    def settle(self) -> None:
        """Close tension clusters a member of which has since been retracted."""
        for row in self.repo.conn.execute("SELECT id, cluster_json FROM conflict_clusters WHERE status='tension'").fetchall():
            members = json.loads(row["cluster_json"])
            if sum(1 for m in members if (self.repo.assertion(m) or {"status": None})["status"] == "active") < 2:
                with self.repo.conn:
                    self.repo.conn.execute("UPDATE conflict_clusters SET status='settled', updated_at=? WHERE id=?",
                                           (time.time(), row["id"]))

    def tensions(self) -> list[list[int]]:
        return [json.loads(r[0]) for r in self.repo.conn.execute(
            "SELECT cluster_json FROM conflict_clusters WHERE status='tension' ORDER BY id")]

    def sweep(self, uid: int | None = None) -> list[dict]:
        """Find contradictions however they arrived (reading, research, induction) and resolve them.
        Category clashes are only held, never auto-retracted: 'dog' and 'pet' are not disjoint
        just because neither is an ancestor of the other."""
        results = []
        for cluster in self.detect_conflicts():
            if cluster["type"] == "disjoint_categories":
                self._hold(cluster["members"], "instance_of", cluster["tension"])
                continue
            if json.dumps(sorted(cluster["members"])) in {json.dumps(sorted(t)) for t in self.tensions()}:
                continue
            results.append(self.resolve_cluster(cluster, uid))
        self.settle()
        return results

    def detect_conflicts(self) -> list[dict]:
        """Scan active assertions for contradiction clusters."""
        clusters = []

        # 1. Direct polarity contradictions: same subject, predicate, object, opposite polarity
        rows = self.repo.conn.execute("""
            SELECT a.id as id1, b.id as id2, a.predicate, a.subj_id, a.obj_id
            FROM assertions a
            JOIN assertions b ON a.subj_type = b.subj_type AND a.subj_id = b.subj_id
                             AND a.predicate = b.predicate AND a.obj_type = b.obj_type
                             AND a.obj_id = b.obj_id AND a.polarity != b.polarity
            WHERE a.status = 'active' AND b.status = 'active' AND a.id < b.id
        """).fetchall()

        for r in rows:
            clusters.append({
                "type": "direct_polarity",
                "predicate": r["predicate"],
                "subject": r["subj_id"],
                "members": [r["id1"], r["id2"]],
                "tension": 1.0
            })

        # 2. Single-valued location/relation conflicts (e.g. lives in Columbus vs lives in Dayton)
        loc_rows = self.repo.conn.execute("""
            SELECT a.id as id1, b.id as id2, a.predicate, a.subj_id, a.obj_id as obj1, b.obj_id as obj2
            FROM assertions a
            JOIN assertions b ON a.subj_type = b.subj_type AND a.subj_id = b.subj_id
                             AND a.predicate = b.predicate AND a.polarity = 1 AND b.polarity = 1
            WHERE a.status = 'active' AND b.status = 'active' AND a.id < b.id
              AND a.predicate IN ('rel:live', 'rel:be_born', 'rel:die')
              AND a.obj_id != b.obj_id
        """).fetchall()

        for r in loc_rows:
            clusters.append({
                "type": "single_valued_slot",
                "predicate": r["predicate"],
                "subject": r["subj_id"],
                "members": [r["id1"], r["id2"]],
                "tension": 0.90
            })

        # 3. Disjoint category conflicts (e.g. Rex is a dog vs Rex is a cat)
        cat_rows = self.repo.conn.execute("""
            SELECT a.id as id1, b.id as id2, a.subj_id, a.obj_id as cat1, b.obj_id as cat2
            FROM assertions a
            JOIN assertions b ON a.subj_type = b.subj_type AND a.subj_id = b.subj_id
                             AND a.predicate = 'instance_of' AND b.predicate = 'instance_of'
                             AND a.polarity = 1 AND b.polarity = 1
            WHERE a.status = 'active' AND b.status = 'active' AND a.id < b.id
              AND a.obj_id != b.obj_id
        """).fetchall()

        if self.engine:
            for r in cat_rows:
                # Check if concepts are ancestors of each other (compatible) or disjoint
                a_anc = self.engine.ancestors(r["cat1"])
                b_anc = self.engine.ancestors(r["cat2"])
                if r["cat2"] not in a_anc and r["cat1"] not in b_anc:
                    clusters.append({
                        "type": "disjoint_categories",
                        "predicate": "instance_of",
                        "subject": r["subj_id"],
                        "members": [r["id1"], r["id2"]],
                        "tension": 0.85
                    })

        return clusters

    def epistemic_entrenchment(self, assertion_id: int) -> float:
        """Calculate the epistemic credibility of an assertion based on provenance, confidence, and corroboration."""
        row = self.repo.assertion(assertion_id)
        if not row:
            return 0.0

        conf = float(row["confidence"])
        # Check provenance origin if available
        prov = self.repo.conn.execute(
            "SELECT origin FROM assertion_provenance WHERE assertion_id = ?", (assertion_id,)
        ).fetchone()
        origin = prov[0] if prov else "unspecified"
        origin_weight = ORIGIN_WEIGHTS.get(origin, 0.70)

        # Corroborating sources count
        sources = self.repo.conn.execute(
            "SELECT COUNT(DISTINCT url) FROM assertion_sources WHERE assertion_id = ?", (assertion_id,)
        ).fetchone()[0]
        corroboration_bonus = min(0.20, sources * 0.05)

        return min(1.0, round(conf * origin_weight + corroboration_bonus, 3))

    def resolve_cluster(self, cluster: dict, uid: int | None = None) -> dict:
        """Resolve an inconsistency cluster by either retracting the dominated assertion or holding under tension."""
        members = cluster["members"]
        scores = [(aid, self.epistemic_entrenchment(aid)) for aid in members]
        scores.sort(key=lambda x: -x[1])

        best_id, best_score = scores[0]
        second_id, second_score = scores[1]
        diff = best_score - second_score

        if diff >= 0.20:
            # Clear dominance: retract dominated claims and cascade
            retracted = []
            for aid, _ in scores[1:]:
                retracted.extend(self.retract_and_cascade(aid, uid, f"Dominated by #{best_id} (credibility diff: {diff:.2f})"))
            return {
                "decision": "retract",
                "dominant_id": best_id,
                "retracted_ids": retracted,
                "tension": 0.0
            }
        else:
            # Balanced credibility: preserve under epistemic tension
            self._hold(members, cluster.get("predicate"), cluster.get("tension", 1.0))
            return {
                "decision": "keep_under_tension",
                "members": members,
                "tension": cluster.get("tension", 1.0),
                "explanation": f"Accounts conflict with comparable credibility ({best_score:.2f} vs {second_score:.2f})."
            }

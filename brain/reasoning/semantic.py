"""Amy's editable semantic network, layered over the read-only WordNet store.

WordNet remains the foundation: its synsets, definitions and hypernym/meronym links are
read only.  Nothing here ever writes to the WordNet database.  Instead this module keeps
Amy's own nodes and edges in the main memory database:

* every learned assertion is mirrored as an edge with provenance and evidence;
* WordNet hypernyms can be imported for a concept as ordinary ``subclass_of`` assertions,
  which the existing :mod:`reasoning.engine` already knows how to traverse;
* edges carry an evidence-based weight (origin reliability, repeated confirmation,
  contradiction, context) instead of an arbitrary score;
* multi-hop and inherited relationships are derived, with the exact path and confidence,
  into ``semantic_inferences``;
* missing relationships and contradictions become pressure-ranked gaps whose questions
  are composed from the relation itself, not a question bank.

The overlay is additive.  It does not replace concepts, assertions, learned rules,
``reasoning_conclusions`` or the thought worker.
"""

from __future__ import annotations

from collections import Counter, defaultdict, deque
from dataclasses import dataclass
import hashlib
import json
import math
import re
import time
from typing import Iterable

from db.repository import NONE_CONCEPT, Repository, Term
from nlp.lexicon import article
from nlp.morphology import third_person

# Where an edge came from.  WordNet is the dictionary; conversation is something a person
# said; observation is a read source; inference is Amy's own derivation; correction is a
# person explicitly replacing an earlier claim.
ORIGINS = ("wordnet", "conversation", "observation", "inference", "correction", "own-reasoning")

# A source's reliability is its starting point, not a verdict.  Evidence then moves the
# weight up or down.  These are deliberately explicit and inspectable.
RELIABILITY = {
    "wordnet": 0.92,
    "correction": 0.90,
    "observation": 0.82,
    "conversation": 0.78,
    "inference": 0.62,
    "own-reasoning": 0.62,
}
TRANSITIVE = {"subclass_of": 0.90, "part_of": 0.82, "located_in": 0.78, "causes": 0.65}
INHERITED = {"has_property", "rel:%"}
TAXONOMY = {"subclass_of", "instance_of"}
ABSTRACT_HEADS = {"entity", "physical entity", "object", "whole", "unit", "being", "organism",
                  "abstraction", "thing", "matter", "causal agent"}
LOCATIVE = {"in", "at", "on", "near", "from", "to", "inside", "outside", "under", "above", "behind"}
WH = {"in": "Where", "at": "Where", "on": "Where", "near": "Where", "from": "Where",
      "to": "Where", "with": "Who", "inside": "Where", "outside": "Where"}


def _json(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


def _key(*parts) -> str:
    return hashlib.sha256(_json(parts).encode("utf-8")).hexdigest()


def _clamp(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 4)


@dataclass
class Assessment:
    """What Amy understands about one prospective relationship."""
    status: str                       # known | inferred | partial | unknown | contradicted
    confidence: float = 0.0
    origin: str | None = None
    evidence: list[dict] | None = None
    path: list[int] | None = None
    explanation: str = ""
    gap: str | None = None

    def __bool__(self) -> bool:
        return self.status in ("known", "inferred")


class SemanticNetwork:
    def __init__(self, repo: Repository, wordnet=None, *, auto_seed: bool = True) -> None:
        self.repo = repo
        self.wordnet = wordnet
        self.auto_seed = auto_seed
        self._nodes: dict[Term, object] = {}
        self._seeded: set[int] = set()
        self._sense_cache: dict[str, tuple | None] = {}
        self._last_revision = -1
        self._last_gap_revision = -1
        self._ensure_support_tables()

    # --- storage helpers ---------------------------------------------------------

    def _ensure_support_tables(self) -> None:
        """Called on a repository that may not have reached the newer migrations yet."""
        self.repo.conn.executescript('''
            CREATE TABLE IF NOT EXISTS assertion_provenance(
                assertion_id INTEGER PRIMARY KEY, origin TEXT NOT NULL,
                source_utterance_id INTEGER, context TEXT);
            CREATE TABLE IF NOT EXISTS fact_sources(
                assertion_id INTEGER PRIMARY KEY, source TEXT, confidence REAL);
        ''')
        self.repo.conn.commit()

    def _state(self, key: str, default=None):
        row = self.repo.conn.execute("SELECT value FROM semantic_state WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def _set_state(self, key: str, value) -> None:
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO semantic_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, _json(value)))

    def revision(self) -> int:
        row = self.repo.conn.execute("SELECT COALESCE(MAX(id),0) FROM semantic_revisions").fetchone()
        return int(row[0])

    def _record(self, kind: str, detail: str, edge_id: int | None = None,
                assertion_id: int | None = None) -> None:
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO semantic_revisions(ts,kind,edge_id,assertion_id,detail) VALUES(?,?,?,?,?)",
                (time.time(), kind, edge_id, assertion_id, detail))

    # --- nodes --------------------------------------------------------------------

    def node(self, term: Term, create: bool = True):
        """The overlay node for a ('c', concept_id) or ('e', entity_id) term."""
        if term in self._nodes:
            return self._nodes[term]
        row = self.repo.conn.execute(
            "SELECT * FROM semantic_nodes WHERE term_type=? AND term_id=?",
            (term[0], term[1])).fetchone()
        if row is not None:
            self._nodes[term] = row
            return row
        # A new node changes what can be unfamiliar even before any edge exists.
        self._last_gap_revision = -1
        if not create:
            return None
        try:
            label = (self.repo.concept_lemma(term[1]) if term[0] == "c"
                     else self.repo.entity_row(term[1])["name"])
        except (AttributeError, IndexError, TypeError):
            return None
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT OR IGNORE INTO semantic_nodes(term_type,term_id,label) VALUES(?,?,?)",
                (term[0], term[1], label))
        row = self.repo.conn.execute(
            "SELECT * FROM semantic_nodes WHERE term_type=? AND term_id=?",
            (term[0], term[1])).fetchone()
        if row is not None:
            self._nodes[term] = row
        return row

    def term(self, node_id: int) -> Term:
        row = self.repo.conn.execute("SELECT * FROM semantic_nodes WHERE id=?", (node_id,)).fetchone()
        return (row["term_type"], row["term_id"])

    def label(self, node_id: int) -> str:
        row = self.repo.conn.execute("SELECT label FROM semantic_nodes WHERE id=?", (node_id,)).fetchone()
        return row["label"] if row else ""

    def node_row(self, node_id: int):
        return self.repo.conn.execute("SELECT * FROM semantic_nodes WHERE id=?", (node_id,)).fetchone()

    # --- WordNet foundation --------------------------------------------------------

    def _wordnet_sense(self, word: str, context: str = "") -> tuple | None:
        """(Sense, confidence) from the read-only store, or None.  Never writes there."""
        key = word.casefold()
        if key in self._sense_cache:
            return self._sense_cache[key]
        if self.wordnet is None or not getattr(self.wordnet, "available", False):
            self._sense_cache[key] = None
            return None
        selection = self.wordnet.select(word, context, pos="n")
        if selection.sense is not None:
            found = (selection.sense, selection.confidence)
        else:
            usual = self.wordnet.usual(word)
            found = (usual, 0.62) if usual is not None else None
        self._sense_cache[key] = found
        return found

    def wordnet_knows(self, word: str) -> bool:
        return self._wordnet_sense(word) is not None

    def ensure_concept(self, word: str, *, seed: bool = True) -> int | None:
        """Resolve a noun to a local concept, importing its WordNet ancestry when known.

        The concept table is only a vocabulary index; importing the ancestry as assertions
        makes the existing reasoner able to inherit generic facts (``animals need food`` ->
        ``dogs need food``) without changing the parser or engine.
        """
        lemma = (word or "").strip().lower()
        if not lemma:
            return None
        cid = self.repo.find_concept(lemma)
        if cid is None:
            cid = self.repo.concept(lemma)
        if seed:
            self.seed_concept(cid)
        return cid

    def seed_concept(self, concept_id: int, *, depth: int = 3, budget: int = 90) -> int:
        """Add this concept's WordNet hypernym chain to Amy's own overlay.

        The imported edges are ordinary ``subclass_of`` assertions, marked with WordNet
        provenance.  They can later be weakened or removed like any other Amy belief;
        the original WordNet row is never touched.
        """
        if concept_id in self._seeded:
            return 0
        node = self.node(("c", concept_id))
        if node is None:
            return 0
        if node["seeded_at"]:
            self._seeded.add(concept_id)
            return 0
        lemma = self.repo.concept_lemma(concept_id)
        found = self._wordnet_sense(lemma)
        if found is None:
            self._mark_seeded(node["id"])
            self._seeded.add(concept_id)
            return 0
        sense, sense_confidence = found
        with self.repo.conn:
            self.repo.conn.execute("UPDATE semantic_nodes SET wordnet_synset=? WHERE id=?",
                                   (sense.id, node["id"]))
        self._record("wordnet-synset", json.dumps({"concept": lemma, "synset": sense.id}))

        paths = self.wordnet.ancestors(sense.id, depth=depth, budget=budget)
        made = 0
        touched: set[int] = {concept_id}
        for ident, path in paths.items():
            if len(path) < 2:
                continue
            for child_synset, parent_synset in zip(path, path[1:]):
                child = self.wordnet.sense(child_synset)
                parent = self.wordnet.sense(parent_synset)
                if child is None or parent is None or parent.lemma in ABSTRACT_HEADS:
                    continue
                if child.lemma == parent.lemma:
                    continue
                child_id = concept_id if child_synset == sense.id else self.repo.concept(child.lemma)
                parent_id = self.repo.concept(parent.lemma)
                touched.update((child_id, parent_id))
                self._mark_wordnet(child_id, child_synset)
                self._mark_wordnet(parent_id, parent_synset)
                confidence = _clamp(sense_confidence * (0.94 ** max(0, len(path) - 2)))
                aid = self.repo.add_assertion(
                    ("c", child_id), "subclass_of", ("c", parent_id), True, None, confidence)
                self._remember_provenance(aid, "wordnet", None,
                                          json.dumps({"synset": child_synset,
                                                      "parent_synset": parent_synset,
                                                      "path": path}))
                if self.observe_assertion(aid, origin="wordnet") is not None:
                    made += 1

        # A few concrete relations make the graph useful without copying dictionary prose.
        for target, relation in [(s, "has_part") for s in self.wordnet.related(sense.id, ("mero_part",), limit=6)] + \
                                [(s, "part_of") for s in self.wordnet.related(sense.id, ("holo_part",), limit=6)]:
            if target.lemma in ABSTRACT_HEADS:
                continue
            target_id = self.repo.concept(target.lemma)
            self._mark_wordnet(target_id, target.id)
            self.link(("c", concept_id), relation, ("c", target_id), origin="wordnet",
                      confidence=_clamp(sense_confidence * 0.9),
                      evidence=[{"origin": "wordnet", "synset": sense.id,
                                 "target_synset": target.id, "confidence": sense_confidence}])
            made += 1

        for cid in touched:
            row = self.node(("c", cid))
            if row is not None:
                self._mark_seeded(row["id"])
        self._seeded.add(concept_id)
        self._record("wordnet-seed", json.dumps({"concept": lemma, "edges": made}))
        return made

    def _mark_seeded(self, node_id: int) -> None:
        with self.repo.conn:
            self.repo.conn.execute(
                "UPDATE semantic_nodes SET seeded_at=CURRENT_TIMESTAMP WHERE id=? AND seeded_at IS NULL",
                (node_id,))

    def _mark_wordnet(self, concept_id: int, synset: str | None) -> None:
        """Record that a concept came from a WordNet sense, so it is not 'unfamiliar'."""
        node = self.node(("c", concept_id))
        if node is None:
            return
        with self.repo.conn:
            self.repo.conn.execute(
                "UPDATE semantic_nodes SET wordnet_synset=COALESCE(wordnet_synset,?), "
                "seeded_at=COALESCE(seeded_at,CURRENT_TIMESTAMP) WHERE id=?",
                (synset, node["id"]))

    def _remember_provenance(self, assertion_id: int, origin: str,
                             utterance_id: int | None, context: str | None) -> None:
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT OR IGNORE INTO assertion_provenance(assertion_id,origin,source_utterance_id,context) "
                "VALUES(?,?,?,?)", (assertion_id, origin, utterance_id, context))

    # --- provenance from the existing fact store -----------------------------------

    @staticmethod
    def _origin_from_source(source: str | None) -> str:
        source = (source or "").casefold()
        if source.startswith("source:wordnet") or "dictionary" in source:
            return "wordnet"
        if source.startswith("source:"):
            return "observation"
        return "conversation"

    def _assertion_origin(self, assertion_id: int, row) -> str:
        prov = self.repo.conn.execute(
            "SELECT origin,context FROM assertion_provenance WHERE assertion_id=?",
            (assertion_id,)).fetchone()
        if prov is not None:
            origin = prov["origin"]
            if origin == "claimed":
                return "conversation"
            if origin == "researched":
                return "observation"
            if origin in ORIGINS:
                return origin
        fact = self.repo.conn.execute(
            "SELECT source FROM fact_sources WHERE assertion_id=?", (assertion_id,)).fetchone()
        if fact is not None:
            return self._origin_from_source(fact["source"])
        if row["source_utterance_id"] is None:
            return "own-reasoning"
        utter = self.repo.conn.execute(
            "SELECT speaker,text FROM utterances WHERE id=?", (row["source_utterance_id"],)).fetchone()
        if utter is not None:
            return self._origin_from_source(utter["speaker"])
        return "conversation"

    def _assertion_context(self, assertion_id: int, row) -> dict:
        context: dict = {}
        prov = self.repo.conn.execute(
            "SELECT context FROM assertion_provenance WHERE assertion_id=?", (assertion_id,)).fetchone()
        if prov is not None and prov["context"]:
            context["note"] = prov["context"]
        fact = self.repo.conn.execute(
            "SELECT source,confidence FROM fact_sources WHERE assertion_id=?", (assertion_id,)).fetchone()
        if fact is not None:
            context["source"] = fact["source"]
        if row["source_utterance_id"] is not None:
            utter = self.repo.conn.execute(
                "SELECT speaker,text,created_at FROM utterances WHERE id=?",
                (row["source_utterance_id"],)).fetchone()
            if utter is not None:
                context.update(speaker=utter["speaker"], heard=utter["text"][:280],
                               at=utter["created_at"])
        return context

    # --- edges ---------------------------------------------------------------------

    def _find_edge(self, subject_id: int, relation: str, object_id: int | None,
                   literal: str | None, polarity: int):
        if object_id is None:
            return self.repo.conn.execute(
                "SELECT * FROM semantic_edges WHERE subject_id=? AND relation=? AND object_id IS NULL "
                "AND COALESCE(literal,'')=? AND polarity=? AND status='active'",
                (subject_id, relation, literal or "", polarity)).fetchone()
        return self.repo.conn.execute(
            "SELECT * FROM semantic_edges WHERE subject_id=? AND relation=? AND object_id=? "
            "AND polarity=? AND status='active'",
            (subject_id, relation, object_id, polarity)).fetchone()

    def _add_evidence(self, edge_id: int, *, assertion_id=None, utterance_id=None,
                      source=None, origin="conversation", supports=1, confidence=1.0,
                      context=None) -> None:
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO semantic_evidence(edge_id,assertion_id,utterance_id,source,origin,"
                "supports,confidence,context_json) VALUES(?,?,?,?,?,?,?,?)",
                (edge_id, assertion_id, utterance_id, source, origin, int(bool(supports)),
                 float(confidence), _json(context or {})))

    def link(self, subject: Term, relation: str, obj: Term | None = None, *,
             literal: str | None = None, origin: str = "own-reasoning",
             confidence: float | None = None, evidence: Iterable[dict] = (),
             context: dict | None = None, polarity: bool = True, scope: str | None = None,
             materialize: bool = False) -> int | None:
        """Create or strengthen one relationship in Amy's own network.

        ``materialize`` also writes an ordinary assertion so the existing reasoner can
        use the relationship.  Conversation and WordNet imports do this; speculative
        inferences stay in the overlay only.
        """
        if origin not in ORIGINS:
            raise ValueError(f"unknown origin: {origin}")
        if obj is None and literal is None:
            raise ValueError("a relationship needs an object or a literal")
        assertion_id = None
        if materialize and literal is None and obj is not None:
            obj_term = obj if obj != ("c", self.repo.none_concept()) else ("c", self.repo.none_concept())
            base = confidence if confidence is not None else RELIABILITY.get(origin, 0.5)
            aid = self.repo.add_assertion(subject, relation, obj_term, polarity, None, base)
            self._remember_provenance(aid, origin, None, _json(context or {}))
            assertion_id = aid
        return self._link_terms(subject, relation, obj, literal=literal, origin=origin,
                                confidence=confidence, evidence=evidence, context=context,
                                polarity=polarity, scope=scope, assertion_id=assertion_id)

    def _link_terms(self, subject: Term, relation: str, obj: Term | None, *,
                    literal: str | None, origin: str, confidence: float | None,
                    evidence: Iterable[dict], context: dict | None, polarity: bool,
                    scope: str | None, assertion_id: int | None) -> int | None:
        snode = self.node(subject)
        if snode is None:
            return None
        onode = self.node(obj) if obj is not None else None
        if obj is not None and onode is None:
            return None
        row = self._find_edge(snode["id"], relation, onode["id"] if onode else None,
                              literal, int(bool(polarity)))
        evidence = list(evidence or ())
        base = confidence if confidence is not None else RELIABILITY.get(origin, 0.5)
        if row is None:
            with self.repo.conn:
                edge_id = self.repo.conn.execute(
                    "INSERT INTO semantic_edges(subject_id,relation,object_id,literal,polarity,"
                    "origin,confidence,scope,context_json,assertion_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (snode["id"], relation, onode["id"] if onode else None, literal,
                     int(bool(polarity)), origin, base,
                     scope or ("generic" if subject[0] == "c" else "instance"),
                     _json(context or {}), assertion_id)).lastrowid
            if evidence:
                for item in evidence:
                    self._add_evidence(edge_id, assertion_id=item.get("assertion_id", assertion_id),
                                       utterance_id=item.get("utterance_id"),
                                       source=item.get("source", origin),
                                       origin=item.get("origin", origin),
                                       supports=item.get("supports", 1),
                                       confidence=item.get("confidence", base),
                                       context=item.get("context", context))
            else:
                self._add_evidence(edge_id, assertion_id=assertion_id,
                                   origin=origin, confidence=base, context=context)
            self._record("edge-added", _json({"relation": relation, "origin": origin}), edge_id)
        else:
            edge_id = row["id"]
            if assertion_id is not None and row["assertion_id"] is None:
                with self.repo.conn:
                    self.repo.conn.execute("UPDATE semantic_edges SET assertion_id=? WHERE id=?",
                                           (assertion_id, edge_id))
            if evidence:
                for item in evidence:
                    self._add_evidence(edge_id, assertion_id=item.get("assertion_id", assertion_id),
                                       utterance_id=item.get("utterance_id"),
                                       source=item.get("source", origin),
                                       origin=item.get("origin", origin),
                                       supports=item.get("supports", 1),
                                       confidence=item.get("confidence", base),
                                       context=item.get("context", context))
            else:
                self._add_evidence(edge_id, assertion_id=assertion_id, origin=origin,
                                   confidence=base, context=context)
            self._record("edge-confirmed", _json({"relation": relation, "origin": origin}), edge_id)
        self._recompute(edge_id)
        return edge_id

    def _recompute(self, edge_id: int) -> float:
        edge = self.edge(edge_id)
        if edge is None:
            return 0.0
        evidence = self.repo.conn.execute(
            "SELECT * FROM semantic_evidence WHERE edge_id=?", (edge_id,)).fetchall()
        support = sum(e["confidence"] for e in evidence if e["supports"])
        against = sum(e["confidence"] for e in evidence if not e["supports"])
        base = RELIABILITY.get(edge["origin"], 0.5)
        # Repeated independent support approaches certainty but never pretends to reach it.
        # Opposing evidence divides the weight instead of silently cancelling it.
        confidence = (1.0 - (1.0 - base) * math.exp(-support)) / (1.0 + against)
        with self.repo.conn:
            self.repo.conn.execute(
                "UPDATE semantic_edges SET confidence=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (_clamp(confidence), edge_id))
        return _clamp(confidence)

    def edge(self, edge_id: int):
        return self.repo.conn.execute("SELECT * FROM semantic_edges WHERE id=?", (edge_id,)).fetchone()

    def edges(self, term: Term, relation: str | None = None, *, direction: str = "out",
              include_weak: bool = True) -> list:
        node = self.node(term, create=False)
        if node is None:
            return []
        status = "status != 'removed'" if include_weak else "status='active'"
        if direction == "out":
            sql, args = f"SELECT * FROM semantic_edges WHERE subject_id=? AND {status}", [node["id"]]
        elif direction == "in":
            sql, args = f"SELECT * FROM semantic_edges WHERE object_id=? AND {status}", [node["id"]]
        else:
            sql, args = (f"SELECT * FROM semantic_edges WHERE (subject_id=? OR object_id=?) AND {status}",
                         [node["id"], node["id"]])
        if relation:
            sql += " AND relation=?"
            args.append(relation)
        return self.repo.conn.execute(sql + " ORDER BY confidence DESC, id", args).fetchall()

    def ancestors(self, term: Term, depth: int = 5) -> dict[int, list[int]]:
        """Every node reachable upward by subclass_of, with the edge path to it."""
        node = self.node(term, create=False)
        if node is None:
            return {}
        paths: dict[int, list[int]] = {node["id"]: []}
        frontier = deque([node["id"]])
        while frontier:
            current = frontier.popleft()
            if len(paths[current]) >= depth:
                continue
            for row in self.repo.conn.execute(
                    "SELECT * FROM semantic_edges WHERE subject_id=? AND relation='subclass_of' "
                    "AND polarity=1 AND status='active'", (current,)):
                if row["object_id"] in paths:
                    continue
                paths[row["object_id"]] = paths[current] + [row["id"]]
                frontier.append(row["object_id"])
        return paths

    def strengthen(self, edge_id: int, *, confidence: float = 1.0, origin: str = "correction",
                   assertion_id: int | None = None, context: dict | None = None) -> float:
        self._add_evidence(edge_id, assertion_id=assertion_id, origin=origin,
                           supports=1, confidence=confidence, context=context)
        self._record("edge-strengthened", _json({"origin": origin}), edge_id)
        return self._recompute(edge_id)

    def weaken(self, edge_id: int, *, confidence: float = 1.0, origin: str = "correction",
               assertion_id: int | None = None, context: dict | None = None) -> float:
        self._add_evidence(edge_id, assertion_id=assertion_id, origin=origin,
                           supports=0, confidence=confidence, context=context)
        self._record("edge-weakened", _json({"origin": origin}), edge_id)
        value = self._recompute(edge_id)
        if value < 0.15:
            with self.repo.conn:
                self.repo.conn.execute("UPDATE semantic_edges SET status='weakened' WHERE id=?",
                                       (edge_id,))
        self.reconcile()
        return value

    def remove(self, edge_id: int, *, note: str = "removed from Amy's own network") -> bool:
        """Retire an edge and any assertion that materialises it.  WordNet is untouched."""
        edge = self.edge(edge_id)
        if edge is None or edge["status"] == "removed":
            return False
        aid = edge["assertion_id"]
        with self.repo.conn:
            self.repo.conn.execute("UPDATE semantic_edges SET status='removed', updated_at=CURRENT_TIMESTAMP "
                                   "WHERE id=?", (edge_id,))
        if aid is not None:
            row = self.repo.assertion(aid)
            if row is not None and row["status"] == "active":
                self.repo.retract(aid, None, note)
        self._record("edge-removed", note, edge_id, aid)
        self.reconcile()
        return True

    def provenance(self, edge_id: int) -> dict:
        edge = self.edge(edge_id)
        if edge is None:
            return {}
        evidence = [dict(r) for r in self.repo.conn.execute(
            "SELECT origin,supports,confidence,source,assertion_id,utterance_id,context_json "
            "FROM semantic_evidence WHERE edge_id=? ORDER BY id", (edge_id,))]
        return {
            "edge_id": edge_id,
            "subject": self.label(edge["subject_id"]),
            "relation": edge["relation"],
            "object": self.label(edge["object_id"]) if edge["object_id"] else edge["literal"],
            "origin": edge["origin"],
            "confidence": edge["confidence"],
            "assertion_id": edge["assertion_id"],
            "evidence": evidence,
        }

    # --- mirroring learned facts ----------------------------------------------------

    def _withdraw_assertion_edges(self, assertion_id: int) -> int:
        rows = self.repo.conn.execute(
            "SELECT id FROM semantic_edges WHERE assertion_id=? AND status != 'removed'",
            (assertion_id,)).fetchall()
        for row in rows:
            with self.repo.conn:
                self.repo.conn.execute(
                    "UPDATE semantic_edges SET status='removed', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (row["id"],))
            self._record("edge-withdrawn", "source assertion retired", row["id"], assertion_id)
        return len(rows)

    def observe_assertion(self, assertion_id: int, origin: str | None = None,
                          context: dict | None = None) -> int | None:
        row = self.repo.assertion(assertion_id)
        if row is None:
            return None
        if row["status"] != "active":
            self._withdraw_assertion_edges(assertion_id)
            return None
        existing = self.repo.conn.execute(
            "SELECT id FROM semantic_edges WHERE assertion_id=? AND status='active'",
            (assertion_id,)).fetchone()
        if existing is not None:
            return existing["id"]
        origin = origin or self._assertion_origin(assertion_id, row)
        ctx = context if context is not None else self._assertion_context(assertion_id, row)
        subject = (row["subj_type"], row["subj_id"])
        obj = (row["obj_type"], row["obj_id"])
        if obj == ("c", self.repo.none_concept()):
            literal = ""
        else:
            literal = None
        return self._link_terms(subject, row["predicate"], None if literal is not None else obj,
                                literal=literal, origin=origin, confidence=row["confidence"],
                                evidence=[{"assertion_id": assertion_id,
                                           "utterance_id": row["source_utterance_id"],
                                           "origin": origin,
                                           "confidence": row["confidence"],
                                           "context": ctx}],
                                context=ctx, polarity=bool(row["polarity"]), scope=None,
                                assertion_id=assertion_id)

    def sync(self, limit: int | None = None) -> dict:
        """Mirror new assertions, retire edges whose assertion was corrected, then re-infer."""
        cursor = int(self._state("assertion_cursor", 0) or 0)
        sql = "SELECT id FROM assertions WHERE id > ? ORDER BY id"
        args: list = [cursor]
        if limit:
            sql += " LIMIT ?"
            args.append(limit)
        ids = [r[0] for r in self.repo.conn.execute(sql, args)]
        observed = 0
        for aid in ids:
            if self.observe_assertion(aid) is not None:
                observed += 1
        if ids:
            self._set_state("assertion_cursor", ids[-1])
        withdrawn = 0
        for row in self.repo.conn.execute(
                "SELECT e.id FROM semantic_edges e JOIN assertions a ON a.id=e.assertion_id "
                "WHERE e.status='active' AND a.status != 'active'").fetchall():
            withdrawn += self._withdraw_assertion_edges(
                self.repo.conn.execute("SELECT assertion_id FROM semantic_edges WHERE id=?",
                                       (row["id"],)).fetchone()[0])
        inference_revision = self.revision()
        if inference_revision != self._last_revision and (observed or withdrawn):
            self.reconcile()
            self._last_revision = self.revision()
        return {"observed": observed, "withdrawn": withdrawn, "revision": self.revision()}

    # --- assessment ----------------------------------------------------------------

    def _direct(self, subject_id: int, relation: str, object_id: int | None,
                literal: str | None, polarity: int):
        if object_id is None:
            return self.repo.conn.execute(
                "SELECT * FROM semantic_edges WHERE subject_id=? AND relation=? AND object_id IS NULL "
                "AND COALESCE(literal,'')=? AND polarity=? AND status='active'",
                (subject_id, relation, literal or "", polarity)).fetchone()
        return self.repo.conn.execute(
            "SELECT * FROM semantic_edges WHERE subject_id=? AND relation=? AND object_id=? "
            "AND polarity=? AND status='active'",
            (subject_id, relation, object_id, polarity)).fetchone()

    def assess(self, subject: Term, relation: str, obj: Term | None = None, *,
               literal: str | None = None, context: dict | None = None) -> Assessment:
        """Known / inferred / partial / unknown / contradicted, with an explanation."""
        snode = self.node(subject, create=False)
        if snode is None:
            return Assessment("unknown", explanation=f"I have no node for {subject[0]}:{subject[1]}")
        onode = self.node(obj, create=False) if obj is not None else None
        if obj is not None and onode is None:
            return Assessment("partial", explanation="I know the subject but not the object")
        object_id = onode["id"] if onode else None
        yes = self._direct(snode["id"], relation, object_id, literal, 1)
        no = self._direct(snode["id"], relation, object_id, literal, 0)
        if yes is not None and no is not None:
            return Assessment("contradicted", min(yes["confidence"], no["confidence"]),
                              yes["origin"], self.provenance(yes["id"])["evidence"],
                              [yes["id"], no["id"]],
                              self._sentence(snode["id"], relation, object_id, literal, True) +
                              " is contradicted by an opposing claim.")
        if yes is not None:
            conf = self._contextual_confidence(yes["id"], context)
            return Assessment("known", conf, yes["origin"],
                              self.provenance(yes["id"])["evidence"], [yes["id"]],
                              self._sentence(snode["id"], relation, object_id, literal, True))
        if no is not None:
            conf = self._contextual_confidence(no["id"], context)
            return Assessment("known", conf, no["origin"],
                              self.provenance(no["id"])["evidence"], [no["id"]],
                              self._sentence(snode["id"], relation, object_id, literal, False))
        inferred = self._inference_for(snode["id"], relation, object_id, literal)
        if inferred is not None:
            return Assessment("inferred", inferred["confidence"], "own-reasoning",
                              json.loads(inferred["evidence_json"]),
                              [step["edge_id"] for step in json.loads(inferred["path_json"])
                               if step.get("edge_id")],
                              self.explain_inference(inferred["id"]))
        outgoing = self.edges(subject, include_weak=False)
        if outgoing:
            sibling_question = self._peer_question(snode["id"], relation, object_id)
            return Assessment("partial", explanation=(
                f"I know some things about {snode['label']}, but not this relationship."
                + (f" {sibling_question}" if sibling_question else "")),
                gap=sibling_question)
        return Assessment("unknown", explanation=f"I have no relationships for {snode['label']}.")

    def _contextual_confidence(self, edge_id: int, context: dict | None) -> float:
        edge = self.edge(edge_id)
        if edge is None:
            return 0.0
        if not context:
            return float(edge["confidence"])
        evidence = self.repo.conn.execute(
            "SELECT confidence,context_json FROM semantic_evidence WHERE edge_id=? AND supports=1",
            (edge_id,)).fetchall()
        if not evidence:
            return float(edge["confidence"])
        weights = []
        for row in evidence:
            try:
                stored = json.loads(row["context_json"] or "{}")
            except (TypeError, ValueError):
                stored = {}
            weights.append(row["confidence"] * self._context_match(stored, context))
        support = sum(weights)
        base = RELIABILITY.get(edge["origin"], 0.5)
        return _clamp(1.0 - (1.0 - base) * math.exp(-support))

    @staticmethod
    def _context_match(stored: dict, query: dict) -> float:
        if not stored or not query:
            return 1.0
        if stored.get("source") and query.get("source") and stored["source"] == query["source"]:
            return 1.0
        if stored.get("speaker") and query.get("speaker"):
            return 1.0 if stored["speaker"] == query["speaker"] else 0.8
        left = set(re.findall(r"[a-z]+", str(stored.get("heard", "")).lower()))
        right = set(re.findall(r"[a-z]+", str(query.get("topic", "")).lower()))
        if left and right:
            return 1.0 if left & right else 0.7
        return 0.9

    def _peer_question(self, node_id: int, relation: str, object_id: int | None) -> str | None:
        node = self.node_row(node_id)
        if node is None:
            return None
        parents = self.repo.conn.execute(
            "SELECT object_id FROM semantic_edges WHERE subject_id=? AND relation='subclass_of' "
            "AND polarity=1 AND status='active'", (node_id,)).fetchall()
        for parent in parents:
            siblings = [r[0] for r in self.repo.conn.execute(
                "SELECT subject_id FROM semantic_edges WHERE object_id=? AND relation='subclass_of' "
                "AND polarity=1 AND status='active' AND subject_id != ?",
                (parent["object_id"], node_id))]
            if any(self.edges(self.term(sib), relation, include_weak=False) for sib in siblings):
                return self._question(node["label"], relation,
                                      self.label(object_id) if object_id else None)
        return None

    # --- inference -----------------------------------------------------------------

    def _edge_step(self, edge) -> dict:
        return {"edge_id": edge["id"], "subject": self.label(edge["subject_id"]),
                "relation": edge["relation"],
                "object": self.label(edge["object_id"]) if edge["object_id"] else edge["literal"],
                "origin": edge["origin"], "confidence": edge["confidence"],
                "assertion_id": edge["assertion_id"]}

    def _ancestor_paths(self, node_id: int, depth: int = 4) -> dict[int, list]:
        """Every kind reachable upward from a node, with the edge rows used to get there."""
        paths: dict[int, list] = {node_id: []}
        frontier = deque([node_id])
        while frontier:
            current = frontier.popleft()
            if len(paths[current]) >= depth:
                continue
            for row in self.repo.conn.execute(
                    "SELECT * FROM semantic_edges WHERE subject_id=? AND relation='subclass_of' "
                    "AND polarity=1 AND status='active'", (current,)):
                if row["object_id"] in paths:
                    continue
                paths[row["object_id"]] = paths[current] + [row]
                frontier.append(row["object_id"])
        return paths

    def _inference_for(self, subject_id: int, relation: str, object_id: int | None,
                       literal: str | None):
        if object_id is None:
            return self.repo.conn.execute(
                "SELECT * FROM semantic_inferences WHERE subject_id=? AND relation=? AND object_id IS NULL "
                "AND COALESCE(literal,'')=? AND status IN ('supported','confirmed')",
                (subject_id, relation, literal or "")).fetchone()
        return self.repo.conn.execute(
            "SELECT * FROM semantic_inferences WHERE subject_id=? AND relation=? AND object_id=? "
            "AND status IN ('supported','confirmed')",
            (subject_id, relation, object_id)).fetchone()

    def _publish_inference(self, subject_id: int, relation: str, object_id: int | None,
                           literal: str | None, confidence: float, path: list[dict],
                           status: str = "supported") -> int:
        key = _key(["inference", subject_id, relation, object_id, literal])
        evidence = Counter(step["origin"] for step in path)
        payload = {"origins": dict(evidence),
                   "premises": [step["edge_id"] for step in path],
                   "assertions": [step.get("assertion_id") for step in path if step.get("assertion_id")]}
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO semantic_inferences(key,subject_id,relation,object_id,literal,confidence,"
                "status,origin,path_json,evidence_json,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET confidence=excluded.confidence,status=excluded.status,"
                "path_json=excluded.path_json,evidence_json=excluded.evidence_json,"
                "revision=excluded.revision,updated_at=CURRENT_TIMESTAMP",
                (key, subject_id, relation, object_id, literal, _clamp(confidence), status,
                 "own-reasoning", _json(path), _json(payload), self.revision()))
        row = self.repo.conn.execute("SELECT id FROM semantic_inferences WHERE key=?", (key,)).fetchone()
        return row[0]

    def infer(self, limit: int = 64, *, max_depth: int = 3) -> list[dict]:
        """Derive transitive and inherited relationships with a checkable path.

        Nothing is turned into a universal assertion here: conclusions stay provisional
        inference records until a person confirms them.
        """
        made: list[dict] = []
        seen: set[tuple] = set()
        budget = 400

        def publish(subject_id, relation, object_id, literal, confidence, path):
            nonlocal budget
            if budget <= 0 or len(made) >= limit:
                return
            budget -= 1
            key = (subject_id, relation, object_id, literal)
            if key in seen:
                return
            seen.add(key)
            direct = self._direct(subject_id, relation, object_id, literal, 1)
            if direct is not None:
                return
            opposing = self._direct(subject_id, relation, object_id, literal, 0)
            status = "conflicting" if opposing is not None else "supported"
            if opposing is not None:
                confidence *= 0.5
            inference_id = self._publish_inference(subject_id, relation, object_id, literal,
                                                   confidence, path, status)
            made.append({"id": inference_id, "subject": self.label(subject_id),
                         "relation": relation,
                         "object": self.label(object_id) if object_id else literal,
                         "confidence": _clamp(confidence), "status": status,
                         "path": path})

        # Inheritance first: an inherited relationship is more informative than the
        # transitive closure of the dictionary taxonomy, and a bounded exploration
        # should not spend its whole budget on category links.
        # Inheritance from kinds and instances, including kinds reached through several
        # taxonomy steps (dog -> domestic animal -> animal -> needs food).
        taxonomy = self.repo.conn.execute(
            "SELECT * FROM semantic_edges WHERE relation IN ('subclass_of','instance_of') "
            "AND polarity=1 AND status='active' AND object_id IS NOT NULL ORDER BY confidence DESC LIMIT 250"
        ).fetchall()
        for tax in taxonomy:
            for kind_id, up_path in self._ancestor_paths(tax["object_id"], depth=max_depth).items():
                for inherited in self.repo.conn.execute(
                        "SELECT * FROM semantic_edges WHERE subject_id=? AND polarity=1 AND status='active' "
                        "AND relation NOT IN ('subclass_of','instance_of') ORDER BY confidence DESC LIMIT 60",
                        (kind_id,)).fetchall():
                    if inherited["subject_id"] == tax["subject_id"]:
                        continue
                    path = ([self._edge_step(tax)] + [self._edge_step(e) for e in up_path]
                            + [self._edge_step(inherited)])
                    confidence = math.prod(step["confidence"] for step in path) * (0.85 ** max(1, len(path) - 1))
                    publish(tax["subject_id"], inherited["relation"], inherited["object_id"],
                            inherited["literal"], confidence, path)

        # Transitive relations (kept after inheritance so inherited facts are not starved).
        for relation, discount in TRANSITIVE.items():
            starts = self.repo.conn.execute(
                "SELECT * FROM semantic_edges WHERE relation=? AND polarity=1 AND status='active' "
                "AND object_id IS NOT NULL ORDER BY confidence DESC LIMIT 200", (relation,)).fetchall()
            for start in starts:
                frontier = deque([(start["object_id"], [self._edge_step(start)])])
                visited = {start["subject_id"], start["object_id"]}
                while frontier and budget > 0 and len(made) < limit:
                    current, path = frontier.popleft()
                    if len(path) >= max_depth:
                        continue
                    for nxt in self.repo.conn.execute(
                            "SELECT * FROM semantic_edges WHERE subject_id=? AND relation=? "
                            "AND polarity=1 AND status='active' AND object_id IS NOT NULL",
                            (current, relation)).fetchall():
                        if nxt["object_id"] in visited:
                            continue
                        next_path = path + [self._edge_step(nxt)]
                        visited.add(nxt["object_id"])
                        confidence = math.prod(step["confidence"] for step in next_path) * (discount ** (len(next_path) - 1))
                        publish(start["subject_id"], relation, nxt["object_id"], None,
                                confidence, next_path)
                        frontier.append((nxt["object_id"], next_path))

        self.reconcile()
        return made

    def reconcile(self) -> int:
        """Withdraw conclusions whose path no longer exists; refresh the rest."""
        withdrawn = 0
        for row in self.repo.conn.execute(
                "SELECT * FROM semantic_inferences WHERE status != 'withdrawn'").fetchall():
            path = json.loads(row["path_json"])
            edge_ids = [step.get("edge_id") for step in path]
            edges = [self.edge(eid) for eid in edge_ids if eid is not None]
            if not edges or any(e is None or e["status"] == "removed" for e in edges):
                with self.repo.conn:
                    self.repo.conn.execute(
                        "UPDATE semantic_inferences SET status='withdrawn',updated_at=CURRENT_TIMESTAMP "
                        "WHERE id=?", (row["id"],))
                withdrawn += 1
                continue
            opposing = self._direct(row["subject_id"], row["relation"], row["object_id"],
                                    row["literal"], 0)
            product = math.prod(e["confidence"] for e in edges)
            confidence = _clamp(product * (0.85 ** max(0, len(edges) - 1)))
            status = "conflicting" if opposing is not None else "supported"
            with self.repo.conn:
                self.repo.conn.execute(
                    "UPDATE semantic_inferences SET confidence=?,status=?,revision=?,"
                    "updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (confidence, status, self.revision(), row["id"]))
        if withdrawn:
            self._record("inferences-withdrawn", str(withdrawn))
        return withdrawn

    def explain_inference(self, inference_id: int) -> str:
        row = self.repo.conn.execute(
            "SELECT * FROM semantic_inferences WHERE id=?", (inference_id,)).fetchone()
        if row is None:
            return ""
        path = json.loads(row["path_json"])
        subject = self.label(row["subject_id"])
        obj = self.label(row["object_id"]) if row["object_id"] else row["literal"]
        link = self._relation_text(row["relation"])
        chain = " then ".join(
            f"{step['subject']} {self._relation_text(step['relation'])} {step['object']}"
            for step in path)
        confidence = f"{row['confidence']:.2f}"
        if row["status"] == "conflicting":
            return (f"{subject} {link} {obj} is only a tentative inference ({confidence}); "
                    f"other evidence opposes it. The path is: {chain}.")
        return (f"{subject} {link} {obj}, inferred with confidence {confidence} from: {chain}.")

    @staticmethod
    def _relation_text(relation: str) -> str:
        if relation.startswith("rel:"):
            return third_person(relation[4:])
        return {"subclass_of": "is a kind of", "instance_of": "is a",
                "has_property": "is", "part_of": "is part of", "has_part": "has part",
                "located_in": "is located in"}.get(
            relation, relation.replace("_", " "))

    def _sentence(self, subject_id: int, relation: str, object_id: int | None,
                  literal: str | None, polarity: bool) -> str:
        subject = self.label(subject_id)
        obj = self.label(object_id) if object_id else literal
        text = f"{subject} {self._relation_text(relation)} {obj}"
        return text if polarity else f"it is not true that {text}"

    # --- gaps, questions and pressure ----------------------------------------------

    def _question(self, subject: str, relation: str, obj: str | None = None) -> str:
        if relation == "has_property":
            return f"Is {subject} {obj}?" if obj else f"What is {subject} like?"
        if relation == "instance_of":
            return f"Is {subject} {article(obj)} {obj}?" if obj else f"What is {subject}?"
        if relation == "subclass_of":
            return f"Is {subject} a kind of {obj}?" if obj else f"What kind of thing is {subject}?"
        if relation == "part_of":
            return f"Is {subject} part of {obj}?" if obj else f"What is {subject} part of?"
        if relation == "has_part":
            return f"Does {subject} have {article(obj)} {obj}?" if obj else f"What does {subject} have?"
        if relation == "located_in":
            return f"Where is {subject}?"
        if relation.startswith("rel:"):
            verb = relation[4:]
            if verb in ("live", "reside"):
                return f"Where does {subject} live?"
            if verb in ("work",):
                return f"Where does {subject} work?"
            if obj:
                return f"Does {subject} {third_person(verb)} {obj}?"
            return f"What does {subject} {third_person(verb)}?"
        return f"What is the relationship between {subject} and {obj}?" if obj else f"What about {subject}?"

    def _gap(self, subject_id: int, relation: str, *, kind: str, object_id: int | None = None,
             question: str | None = None, pressure: float = 0.5,
             evidence: dict | None = None) -> dict:
        subject = self.label(subject_id)
        obj = self.label(object_id) if object_id else None
        question = question or self._question(subject, relation, obj)
        key = _key(["gap", kind, subject_id, relation, object_id])
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO semantic_gaps(key,subject_id,relation,object_id,kind,question,pressure,"
                "status,evidence_json,revision) VALUES(?,?,?,?,?,?,?,'open',?,?) "
                "ON CONFLICT(key) DO UPDATE SET question=excluded.question,pressure=excluded.pressure,"
                "status='open',evidence_json=excluded.evidence_json,revision=excluded.revision,"
                "updated_at=CURRENT_TIMESTAMP",
                (key, subject_id, relation, object_id, kind, question, _clamp(pressure),
                 _json(evidence or {}), self.revision()))
        row = self.repo.conn.execute("SELECT * FROM semantic_gaps WHERE key=?", (key,)).fetchone()
        return dict(row)

    def gaps(self, limit: int = 32) -> list[dict]:
        """Missing relationships, contradictions and unfamiliar concepts, ranked by pressure."""
        if self._last_gap_revision == self.revision() and self.repo.conn.execute(
                "SELECT COUNT(*) FROM semantic_gaps WHERE status='open'").fetchone()[0]:
            return [dict(r) for r in self.repo.conn.execute(
                "SELECT * FROM semantic_gaps WHERE status='open' ORDER BY pressure DESC, id DESC LIMIT ?",
                (limit,))]
        found: dict[str, dict] = {}
        # Contradictions first: they are the strongest demand on attention.
        contradicting = self.repo.conn.execute(
            "SELECT a.id AS yes_id,b.id AS no_id,a.subject_id,a.relation,a.object_id,a.literal "
            "FROM semantic_edges a JOIN semantic_edges b ON a.subject_id=b.subject_id "
            "AND a.relation=b.relation AND COALESCE(a.object_id,-1)=COALESCE(b.object_id,-1) "
            "AND COALESCE(a.literal,'')=COALESCE(b.literal,'') "
            "WHERE a.polarity=1 AND b.polarity=0 AND a.status='active' AND b.status='active' "
            "LIMIT 16").fetchall()
        for row in contradicting:
            gap = self._gap(row["subject_id"], row["relation"], kind="contradiction",
                            object_id=row["object_id"],
                            pressure=0.95,
                            evidence={"positive": row["yes_id"], "negative": row["no_id"]})
            found[gap["key"]] = gap

        # Relationships that siblings in the same category have and this node lacks.
        parents = self.repo.conn.execute(
            "SELECT subject_id,object_id FROM semantic_edges WHERE relation='subclass_of' "
            "AND polarity=1 AND status='active'").fetchall()
        children: dict[int, list[int]] = defaultdict(list)
        for row in parents:
            if row["subject_id"] not in children[row["object_id"]]:
                children[row["object_id"]].append(row["subject_id"])
        for parent, siblings in children.items():
            if len(siblings) < 2:
                continue
            holders: dict[tuple, set[int]] = defaultdict(set)
            for child in siblings:
                for edge in self.repo.conn.execute(
                        "SELECT * FROM semantic_edges WHERE subject_id=? AND polarity=1 AND status='active' "
                        "AND relation NOT IN ('subclass_of','instance_of')", (child,)):
                    holders[(edge["relation"], edge["object_id"], edge["literal"])].add(child)
            for (relation, object_id, literal), who in holders.items():
                if len(who) < 2 or len(who) == len(siblings):
                    continue
                for child in siblings:
                    if child in who:
                        continue
                    # A different value for the same relation is not a gap; it is a choice.
                    if self.repo.conn.execute(
                            "SELECT 1 FROM semantic_edges WHERE subject_id=? AND relation=? "
                            "AND status='active' LIMIT 1", (child, relation)).fetchone():
                        continue
                    shared = len(who) / max(1, len(siblings))
                    gap = self._gap(child, relation, kind="missing-relation", object_id=object_id,
                                    pressure=0.25 + 0.45 * shared,
                                    evidence={"siblings": sorted(who), "parent": parent,
                                              "literal": literal})
                    found[gap["key"]] = gap

        # Concepts with nothing known about them are unfamiliar rather than false.  Being
        # the object of a category claim is not yet knowing anything about the concept.
        for row in self.repo.conn.execute(
                "SELECT n.* FROM semantic_nodes n WHERE n.term_type='c' AND n.wordnet_synset IS NULL "
                "AND NOT EXISTS (SELECT 1 FROM semantic_edges e WHERE e.subject_id=n.id "
                "AND e.status='active') LIMIT 24").fetchall():
            gap = self._gap(row["id"], "instance_of", kind="unfamiliar-concept",
                            pressure=0.4,
                            evidence={"label": row["label"], "wordnet_synset": row["wordnet_synset"]})
            found[gap["key"]] = gap

        # Anything that no longer describes a live gap is resolved: a supplied relation,
        # a contradiction that has been settled, or a concept that is no longer unfamiliar.
        for row in self.repo.conn.execute("SELECT * FROM semantic_gaps WHERE status='open'").fetchall():
            if row["key"] not in found:
                with self.repo.conn:
                    self.repo.conn.execute(
                        "UPDATE semantic_gaps SET status='resolved',updated_at=CURRENT_TIMESTAMP WHERE id=?",
                        (row["id"],))
        self._last_gap_revision = self.revision()
        return sorted(found.values(), key=lambda g: (-g["pressure"], g["id"]))[:limit]

    def pressure(self) -> dict:
        # Open gaps are derived; make sure a contradiction that has been settled is no
        # longer counted just because this method was called before gaps().
        self.gaps()
        rows = self.repo.conn.execute(
            "SELECT kind, COUNT(*) n, COALESCE(SUM(pressure),0) total FROM semantic_gaps "
            "WHERE status='open' GROUP BY kind").fetchall()
        by_kind = {row["kind"]: row["n"] for row in rows}
        total = sum(row["total"] for row in rows)
        open_count = sum(by_kind.values())
        return {"open": open_count, "by_kind": by_kind,
                "pressure": _clamp(total / max(1.0, 3.0 + open_count)),
                "contradictions": by_kind.get("contradiction", 0),
                "unfamiliar": by_kind.get("unfamiliar-concept", 0)}

    def next_question(self, exclude: set[str] | None = None) -> dict | None:
        """The highest-pressure open gap whose question has not been asked recently."""
        exclude = exclude or set()
        for row in self.repo.conn.execute(
                "SELECT * FROM semantic_gaps WHERE status='open' ORDER BY pressure DESC, id DESC"):
            if row["question"] in exclude:
                continue
            return dict(row)
        return None

    # --- explanation ---------------------------------------------------------------

    def describe(self, term: Term, limit: int = 12) -> str:
        node = self.node(term, create=False)
        if node is None:
            return ""
        rows = self.edges(term, include_weak=False)[:limit]
        if not rows:
            return f"I have no relationships recorded for {node['label']}."
        facts = []
        origins = set()
        for edge in rows:
            facts.append(self._sentence(edge["subject_id"], edge["relation"],
                                        edge["object_id"], edge["literal"],
                                        bool(edge["polarity"])))
            origins.add(edge["origin"])
        return (f"{node['label'].capitalize()}: " + "; ".join(facts) +
                f". These come from {', '.join(sorted(origins))}.")

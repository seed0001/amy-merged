# Editable semantic memory

Amy's semantic memory is an overlay on the facts she already had. It does not replace the
parser, the reasoner, the assertion store, learned rules, or the thought worker. WordNet is
still the starting dictionary, but it is read as evidence: the installed WordNet database is
opened read-only and is never modified.

The overlay lives in the main memory database (`data/amy.db`) in these tables:

| Table | Purpose |
| --- | --- |
| `semantic_nodes` | A node for each concept (`term_type='c'`) or entity (`'e'`), with its label, WordNet synset, and whether its ancestry was seeded. |
| `semantic_edges` | Amy's editable relationships: subject, relation, object or literal, polarity, origin, confidence, scope, context, status, and the assertion that materialises it. |
| `semantic_evidence` | Every supporting or opposing observation for an edge: assertion, utterance, source, origin, weight, and context. |
| `semantic_inferences` | Derived relationships with their full path, confidence, status, and origins. These stay provisional until confirmed. |
| `semantic_gaps` | Missing relationships, contradictions, and unfamiliar concepts, ranked by pressure. Each has a question composed from the gap. |
| `semantic_revisions` | An append-only record of node, edge, inference, and WordNet-seeding changes. |
| `semantic_state` | Bookkeeping such as the assertion cursor used by `sync()`. |

The implementation is in `reasoning/semantic.py`; assertions continue to live in the existing
`assertions` table and are mirrored into the overlay.

## WordNet as the foundation

On first use of a concept, `SemanticNetwork.seed_concept()`:

1. selects a WordNet sense for the noun;
2. records the synset on the node;
3. copies the sense's hypernym chain into ordinary `subclass_of` assertions with
   `wordnet` provenance; and
4. adds a small number of concrete meronym relations (`has_part` / `part_of`).

Copying the chain into Amy's own assertions is what lets the existing `Engine` inherit
generic facts without changing the parser or reasoner. For example, after teaching
`Animals need food.` and `Rex is a dog.`, the chain `dog -> domestic animal -> animal`
supports `Rex needs food`.

Those copied assertions can be weakened or removed like any other belief. Removing one
retracts Amy's copy; WordNet is untouched.

Pure dictionary taxonomy is evidence, not a new discovery. `ReasoningCoordinator` skips
`is_a` conclusions whose proof depends on a WordNet `subclass_of` step, and the thought
worker publishes inherited `rel:*` / `has_property` conclusions only when the path has a
non-WordNet supporting step.

## Provenance

Every edge records an origin:

- `wordnet` — the local dictionary;
- `conversation` — something a person said;
- `observation` — a read source;
- `correction` — a person explicitly replacing an earlier claim;
- `inference` / `own-reasoning` — Amy's own derivation.

`provenance(edge_id)` returns the edge, its confidence, the materialised assertion, and every
evidence row. A learned assertion's origin comes first from `assertion_provenance`, then
`fact_sources`, then the speaking source, and finally from the fact that it has no source
utterance (own reasoning).

## Evidence and confidence

An edge starts from the reliability of its origin:

| Origin | Starting reliability |
| --- | --- |
| `wordnet` | 0.92 |
| `correction` | 0.90 |
| `observation` | 0.82 |
| `conversation` | 0.78 |
| `inference` / `own-reasoning` | 0.62 |

Repeated independent support approaches certainty without reaching it; opposing evidence
divides the weight:

```
support = sum(weight of supporting evidence)
against = sum(weight of opposing evidence)
confidence = (1 - (1 - origin_reliability) * exp(-support)) / (1 + against)
```

`strengthen(edge_id)` adds supporting evidence; `weaken(edge_id)` adds opposing evidence and
retires an edge below 0.15. `remove(edge_id)` retires the edge and any assertion that
materialises it.

Context is a query, not a rewrite. `assess(..., context={...})` discounts evidence whose
stored context does not match the speaker or topic; the stored edge confidence is unchanged.
This makes a fact learned in one conversation usable but less authoritative in another.

## Assessment, inference, and revision

`assess(subject, relation, object)` returns one of:

- `known` — a direct active edge, positive or negative;
- `inferred` — supported only by a recorded inference path;
- `partial` — the subject is known, but this relationship is not;
- `unknown` — nothing relevant is known;
- `contradicted` — positive and negative edges are both active.

`infer()` derives two kinds of conclusions and stores them with the exact edge path:

1. **Inheritance**: a kind or instance inherits its ancestors' non-taxonomy relationships
   (`dog -> animal`, `animal needs food`, therefore `dog needs food`).
2. **Transitivity**: relations declared transitive, beginning with `subclass_of`, `part_of`,
   `located_in`, and `causes`.

Confidence is the product of the path's edge confidences, with a depth discount. The path,
premises, and origin counts are stored in `semantic_inferences`. An inferred relationship is
not written into `assertions`; it stays provisional.

`reconcile()` withdraws an inference when any edge in its path is removed or when its source
assertion is retracted. A direct exception does not erase the general rule: it makes the
instance-level inference `conflicting`, and `assess()` reports the direct negative claim
instead of guessing.

## Gaps, questions, and pressure

`gaps()` derives current gaps from the graph:

- **contradiction** — active positive and opposing edges for the same relationship, pressure
  0.95;
- **missing relation** — a relationship that two or more siblings under the same category
  have and this node lacks, pressure scaled by how many siblings share it;
- **unfamiliar concept** — a concept with no active outgoing relationships and no WordNet
  synset.

Gaps that no longer describe a live condition are marked `resolved`. `pressure()` summarises
the open gaps by kind, and `next_question()` returns the highest-pressure unasked gap. The
question is composed from the relation itself (`Is bird fuzzy?`, `What is wug?`, `Where does
X live?`) rather than selected from a question bank.

`Curiosity` may ask one of these questions when its social/curiosity threshold allows it.
The answer is ordinary language and is learned by the normal parser. The same pressure feeds
the `semantic-gap` event in `SelfModel`, so unresolved knowledge raises alertness rather than
inventing an answer.

## Background thinking

`ThinkingEngine` owns a `SemanticNetwork` over its read-only memory snapshot. Each cycle:

1. mirrors new assertions;
2. runs a bounded `infer()`;
3. publishes inherited `rel:*` / `has_property` relationships as `semantic-inference`
   thought chains with their premises and path.

Pure taxonomy, partonomy, and WordNet-only paths are skipped so the worker does not narrate
dictionary links as discoveries. A published chain is validated against the live memory by
the existing `valid_chain()` check, and a later retraction invalidates a stale chain.

## Inspecting it

```python
from db.repository import Repository
from reasoning.semantic import SemanticNetwork

repo = Repository("data/amy.db")
network = SemanticNetwork(repo)          # uses the installed WordNet store
dog = repo.find_concept("dog")
food = repo.find_concept("food")

network.sync()
network.infer()
print(network.assess(("c", dog), "rel:need", ("c", food)))
print(network.provenance(network.edges(("c", dog), "rel:need")[0]["id"]))
print(network.gaps())
print(network.pressure())
```

`describe(term)` returns a short summary of a node's active relationships and their origins.

## Limits

- Inheritance is conservative: it does not assume every inherited relation is universal.
  Exceptions remain direct claims and mark the inferred instance as conflicting.
- Only relations listed as transitive are chained, and the search is depth- and budget-bounded.
- WordNet's meronym data can contain noisy or overly specific parts; those relations are
  used for inspection, not narrated as discoveries.
- The overlay does not add an LLM or any new external service. It is deterministic graph
  reasoning over the same SQLite memory.

"""WordNet-style graph over the phrase banks: nodes, weighted edges, and dynamics.

Nodes are phrases. Edges are typed and weighted:
- "relates": two phrases in the same topic whose meanings are compatible (same meaning, or
  listed as compatible in the banks).
- "follows": a phrase in one slot can be followed by a phrase in the next slot, in the same
  topic. This is what gives sentences their order.

Dynamics:
- activate(seeds): spreading activation. Energy starts at the seed nodes and flows along
  outgoing edges, scaled by edge weight and damped each hop. Phrases near the intent light
  up, so related phrases score higher without anyone listing them by hand.
- reinforce_path(path, reward): edges along a used sequence gain or lose weight.
- decay(rate): every edge drifts back toward its baseline, so old habits fade.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from dialogue.predictor import Banks, Phrase

MIN_W, MAX_W = 0.0, 5.0


@dataclass
class Edge:
    src: str
    dst: str
    kind: str
    weight: float
    baseline: float


class PhraseGraph:
    def __init__(self, banks: Banks, state_path: str | Path | None = None):
        self.banks = banks
        self.nodes: dict[str, Phrase] = {p.text: p for p in banks.phrases}
        self.out: dict[str, list[Edge]] = defaultdict(list)
        self.state_path = Path(state_path) if state_path else None
        self._build()
        if self.state_path and self.state_path.exists():
            self._load_weights()

    # ---- construction -----------------------------------------------------------

    def _add(self, src: str, dst: str, kind: str, weight: float) -> None:
        for e in self.out[src]:
            if e.dst == dst and e.kind == kind:
                return
        self.out[src].append(Edge(src, dst, kind, weight, weight))

    def _build(self) -> None:
        order = list(self.banks.optional) + list(self.banks.required)
        slot_rank = {s: i for i, s in enumerate(("opener", "subject", "predicate", "detail", "closer"))}
        phrases = list(self.nodes.values())
        for a in phrases:
            for b in phrases:
                if a.text == b.text or a.topic != b.topic:
                    continue
                if a.meaning == b.meaning or b.meaning in self.banks.compatible.get(a.meaning, []):
                    self._add(a.text, b.text, "relates", 0.5 if a.meaning == b.meaning else 0.3)
                if slot_rank.get(b.slot, -1) == slot_rank.get(a.slot, -1) + 1:
                    self._add(a.text, b.text, "follows", 0.3)

    # ---- dynamics ---------------------------------------------------------------

    def activate(self, seeds: dict[str, float], hops: int = 2, damping: float = 0.5) -> dict[str, float]:
        """Spreading activation. seeds maps node text to starting energy."""
        energy = defaultdict(float, seeds)
        frontier = dict(seeds)
        for _ in range(hops):
            nxt: dict[str, float] = defaultdict(float)
            for node, e in frontier.items():
                for edge in self.out.get(node, []):
                    nxt[edge.dst] += e * edge.weight * damping
            for node, e in nxt.items():
                energy[node] += e
            frontier = nxt
        return dict(energy)

    def reinforce_path(self, path: list[str], reward: float, lr: float = 0.2) -> None:
        """Strengthen (reward > 0) or weaken (reward < 0) the edges along a used sequence."""
        for a, b in zip(path, path[1:]):
            for edge in self.out.get(a, []):
                if edge.dst == b:
                    edge.weight = min(MAX_W, max(MIN_W, edge.weight + lr * (1 if reward > 0 else -1)))
        self.save()

    def decay(self, rate: float = 0.02) -> None:
        """Pull every edge back toward its baseline. Unused connections fade over time."""
        for edges in self.out.values():
            for e in edges:
                e.weight += rate * (e.baseline - e.weight)
        self.save()

    # ---- persistence ------------------------------------------------------------

    def save(self) -> None:
        if self.state_path is None:
            return
        data = {f"{e.src}\t{e.dst}\t{e.kind}": e.weight for edges in self.out.values() for e in edges}
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(data, indent=1), encoding="utf-8")

    def _load_weights(self) -> None:
        saved = json.loads(self.state_path.read_text(encoding="utf-8"))
        for edges in self.out.values():
            for e in edges:
                key = f"{e.src}\t{e.dst}\t{e.kind}"
                if key in saved:
                    e.weight = saved[key]

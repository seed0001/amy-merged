"""Predictive sentence builder: phrase banks, rule filters, and an averaged perceptron.

No LLM and no token generation. Every piece of a sentence is a whole phrase taken from a
word bank (data/phrase_banks.json). A sentence is built slot by slot (opener, subject,
predicate, detail, closer). For each slot:

1. Rules remove candidates that cannot fit: wrong topic, wrong meaning, already used in
   this sentence, or recently used (hard repeat limit).
2. A perceptron scores the survivors from learned weights over simple features (the phrase
   itself, how well its meaning matches the intent, what came before it, how recently it
   was used). The best-scoring phrase wins, or one is sampled from a softmax for variety.

The perceptron learns from two signals:
- train(context, gold_phrases): supervised, the standard structured perceptron update.
- reinforce(...): reward from the conversation (+1 accepted, -1 rejected), applied to the
  phrases that were actually used.
"""

from __future__ import annotations

import json
import math
import random
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_BANKS = Path(__file__).resolve().parent.parent / "data" / "phrase_banks.json"
DEFAULT_WEIGHTS = Path(__file__).resolve().parent.parent / "data" / "predictor_weights.json"

SLOT_ORDER = ("opener", "subject", "predicate", "detail", "closer")


@dataclass(frozen=True)
class Phrase:
    text: str
    slot: str
    topic: str
    meaning: str


@dataclass
class Context:
    """What the sentence is for. topic and meaning come from the caller's intent detection."""

    topic: str
    meaning: str
    mood: str = "neutral"
    slots: tuple[str, ...] = SLOT_ORDER  # slots to fill, in order


@dataclass
class Choice:
    phrase: Phrase
    features: dict[str, float]
    score: float


@dataclass
class Sentence:
    text: str
    choices: list[Choice] = field(default_factory=list)


class Banks:
    """Phrases indexed by (slot, topic). Loaded from the JSON word bank."""

    def __init__(self, phrases: list[Phrase], compatible: dict[str, list[str]],
                 required: tuple[str, ...], optional: tuple[str, ...]):
        self.phrases = list(dict.fromkeys(phrases))
        self.compatible = compatible
        self.required = required
        self.optional = optional
        self._index: dict[tuple[str, str], list[Phrase]] = {}
        for p in self.phrases:
            self._index.setdefault((p.slot, p.topic), []).append(p)

    @classmethod
    def load(cls, path: str | Path = DEFAULT_BANKS) -> "Banks":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        phrases = []
        for slot, topics in data["slots"].items():
            for topic, meanings in topics.items():
                for meaning, texts in meanings.items():
                    phrases.extend(Phrase(t, slot, topic, meaning) for t in texts)
        return cls(phrases, data.get("compatible", {}),
                   tuple(data.get("required_slots", ["subject", "predicate"])),
                   tuple(data.get("optional_slots", ["opener", "detail", "closer"])))

    def candidates(self, slot: str, ctx: Context) -> list[Phrase]:
        """Rule-based pre-filter: same topic (or topic-less general pool), and a meaning the
        intent allows. Exact meaning matches are kept by the perceptron's match feature."""
        pool = self._index.get((slot, ctx.topic), [])
        allowed = {ctx.meaning, *self.compatible.get(ctx.meaning, [])}
        return [p for p in pool if p.meaning in allowed]


class AveragedPerceptron:
    """Linear scorer with weight averaging, so one noisy update cannot swing the result."""

    def __init__(self, weights: dict[str, float] | None = None):
        self.w: dict[str, float] = dict(weights or {})
        self._u: dict[str, float] = {}  # accumulated (step * update), for averaging
        self._c = 1  # step counter

    def score(self, feats: dict[str, float]) -> float:
        return sum(self.w.get(k, 0.0) * v for k, v in feats.items())

    def _update(self, feats: dict[str, float], scale: float) -> None:
        for k, v in feats.items():
            self.w[k] = self.w.get(k, 0.0) + scale * v
            self._u[k] = self._u.get(k, 0.0) + self._c * scale * v

    def step(self) -> None:
        self._c += 1

    def averaged(self) -> dict[str, float]:
        return {k: v - self._u.get(k, 0.0) / self._c for k, v in self.w.items()}


class Predictor:
    def __init__(self, banks: Banks | None = None, *, history: int = 12,
                 repeat_limit: int = 6, temperature: float = 0.0,
                 weights_path: str | Path | None = DEFAULT_WEIGHTS, seed: int | None = None,
                 learning_rate: float = 1.0, graph=None, graph_path=None):
        self.banks = banks or Banks.load()
        from dialogue.phrase_graph import PhraseGraph  # local import: phrase_graph imports this module
        self.graph = graph or PhraseGraph(self.banks, state_path=graph_path)
        self._act: dict[str, float] = {}
        self.history: deque[str] = deque(maxlen=history)  # recent phrase texts, for repeat rules
        self.repeat_limit = repeat_limit
        self.temperature = temperature  # 0 = always best; >0 = softmax sampling
        self.lr = learning_rate
        self.rng = random.Random(seed)
        self.weights_path = Path(weights_path) if weights_path else None
        loaded = None
        if self.weights_path and self.weights_path.exists():
            loaded = json.loads(self.weights_path.read_text(encoding="utf-8"))
        self.model = AveragedPerceptron(loaded)

    # ---- features -------------------------------------------------------------

    def features(self, p: Phrase, ctx: Context, prev: Phrase | None) -> dict[str, float]:
        f = {
            f"phrase:{p.text}": 1.0,                       # identity bias for this exact phrase
            f"slot:{p.slot}:{p.meaning}": 1.0,
            f"mood:{ctx.mood}:{p.meaning}": 1.0,
        }
        if p.meaning == ctx.meaning:
            f["meaning_match"] = 1.0
        else:
            f["meaning_compatible"] = 1.0                  # allowed by the compatibility table
        if self._act:
            f["graph"] = self._act.get(p.text, 0.0)        # spreading activation from the intent
        if prev is not None:
            f[f"after:{prev.text}>{p.text}"] = 1.0         # what-follows-what coherence
        # Recency: stronger penalty the more recently it was used (one feature per phrase).
        if p.text in self.history:
            age = list(reversed(self.history)).index(p.text)
            f[f"recent:{p.text}"] = 1.0 / (age + 1)
        return f

    # ---- rules ----------------------------------------------------------------

    def _allowed(self, p: Phrase, used: set[str]) -> bool:
        if p.text in used:                                 # never repeat within one sentence
            return False
        return list(self.history).count(p.text) < self.repeat_limit

    # ---- prediction -----------------------------------------------------------

    def _pick(self, options: list[tuple[Phrase, dict[str, float], float]]) -> tuple[Phrase, dict[str, float], float]:
        if self.temperature <= 0 or len(options) == 1:
            return max(options, key=lambda o: o[2])
        top = max(s for _, _, s in options)
        weights = [math.exp((s - top) / self.temperature) for _, _, s in options]
        return self.rng.choices(options, weights=weights, k=1)[0]

    def predict(self, ctx: Context) -> Sentence:
        averaged = AveragedPerceptron(self.model.averaged())  # score with averaged weights
        seeds = {p.text: 1.0 for slot in ctx.slots for p in self.banks.candidates(slot, ctx)}
        self._act = self.graph.activate(seeds) if seeds else {}
        used: set[str] = set()
        prev: Phrase | None = None
        choices: list[Choice] = []
        parts: list[str] = []
        for slot in ctx.slots:
            options = []
            for p in self.banks.candidates(slot, ctx):
                if not self._allowed(p, used):
                    continue
                f = self.features(p, ctx, prev)
                options.append((p, f, averaged.score(f)))
            if not options:
                if slot in self.banks.required:
                    raise LookupError(f"no phrase for required slot {slot!r} "
                                      f"(topic={ctx.topic!r}, meaning={ctx.meaning!r})")
                continue
            p, f, s = self._pick(options)
            choices.append(Choice(p, f, s))
            parts.append(p.text)
            used.add(p.text)
            prev = p
        return Sentence(self._assemble(parts), choices)

    def predict_paragraph(self, contexts: list[Context]) -> str:
        sentences = []
        for ctx in contexts:
            s = self.predict(ctx)
            self.remember(s)
            sentences.append(s.text)
        return " ".join(sentences)

    @staticmethod
    def _assemble(parts: list[str]) -> str:
        text = " ".join(parts)
        return text[:1].upper() + text[1:] if text else text

    def remember(self, sentence: Sentence) -> None:
        for c in sentence.choices:
            self.history.append(c.phrase.text)

    # ---- learning -------------------------------------------------------------

    def train(self, ctx: Context, gold: list[str]) -> int:
        """Structured perceptron: for each slot where the prediction disagrees with the gold
        phrase, move weights toward the gold features and away from the predicted ones.
        gold is the list of correct phrase texts in slot order. Returns mistakes made."""
        mistakes = 0
        used: set[str] = set()
        prev: Phrase | None = None
        averaged = AveragedPerceptron(self.model.averaged())
        seeds = {p.text: 1.0 for slot in ctx.slots for p in self.banks.candidates(slot, ctx)}
        self._act = self.graph.activate(seeds) if seeds else {}
        for slot, gold_text in zip(ctx.slots, gold):
            options = []
            gold_phrase = None
            for p in self.banks.candidates(slot, ctx):
                if p.text in used:
                    continue
                f = self.features(p, ctx, prev)
                options.append((p, f, averaged.score(f)))
                if p.text == gold_text:
                    gold_phrase = (p, f)
            if gold_phrase is None:
                break  # gold phrase is not in the banks for this context; nothing to learn
            best = max(options, key=lambda o: o[2])
            if best[0].text != gold_text:
                mistakes += 1
                self.model._update(gold_phrase[1], self.lr)
                self.model._update(best[1], -self.lr)
            used.add(gold_text)
            prev = gold_phrase[0]
            self.model.step()
        self.graph.reinforce_path(gold[:len(used)], 1.0)
        self._save()
        return mistakes

    def reinforce(self, sentence: Sentence, reward: float) -> None:
        """Conversation feedback. reward > 0 means the sentence was accepted, < 0 rejected.
        Each phrase used is pushed toward (or away from) its features."""
        for c in sentence.choices:
            self.model._update(c.features, self.lr * (1.0 if reward > 0 else -1.0))
        self.model.step()
        self.graph.reinforce_path([c.phrase.text for c in sentence.choices], reward)
        self._save()

    def _save(self) -> None:
        if self.weights_path is None:
            return
        self.weights_path.parent.mkdir(parents=True, exist_ok=True)
        self.weights_path.write_text(json.dumps(self.model.averaged(), indent=1), encoding="utf-8")

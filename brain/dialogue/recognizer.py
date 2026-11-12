"""What kind of line is this? A small trained recognizer that runs in front of the parser.

The parser reads structure and fails on about half of what people really say. This reads any line: it turns the
line into numbers with the embedding model on this PC (bge-m3; it writes nothing, it only places lines with similar
meaning near each other), adds a few plain features anyone can read (ends with a question mark, says "you" ...),
and scores the line against each kind it has learned: praise, a request, a question for her, irritation, contempt,
humor, a line worth keeping as a fact, and so on. A line can be several kinds at once.

It answers one question only: what is the speaker doing. What the sentence claims is the parser's job, and whether
a claim is kept as knowledge is decided from both, never from this alone.

Everything it knows is in one readable file (recognizer.json, written by corpus/train.py): for each kind, one weight
per feature and how well it did on conversations it was never trained on. Nothing here is hidden: `read` returns,
for every kind, the score, how much of it came from the meaning of the line and how much from each plain feature.

No language model is involved, and no third-party package: the arithmetic is a few thousand multiplications.
"""

import json
import math
import os
import re
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

EMBED_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
MAX_CHARS = 2000

# Plain features, each one a fact about the line that a person can check by looking at it. The same function is
# used to train the recognizer and to read a line with it, so the two can never disagree about what a feature is.
FEATURE_NAMES = [
    "ends with a question mark", "ends with an exclamation mark", "trails off", "one to three words", "long (over 40 words)",
    "says you or your", "says I, me or my", "starts with a question word", "starts with a verb-like command word",
    "names her", "has a swear word", "has 'not' or n't", "has quote marks", "has 'if'", "has 'because' or 'so'",
]
_QUESTION_START = re.compile(r"^(?:so |and |but |well |okay |ok |hey |now )?(?:who|what|when|where|why|how|which|is|are|was|were|do|does|did|can|could|will|would|should|have|has)\b", re.I)
_COMMAND_START = re.compile(r"^(?:so |and |okay |ok |alright |all right |hey |now |please |go ahead and )*(?:tell|show|give|make|change|open|close|stop|start|play|put|turn|switch|find|look|check|try|say|ask|read|write|let|take|get|go|come|run|set|fix|add|remove|send|zoom)\b", re.I)
_SWEAR = re.compile(r"\b(?:fuck\w*|shit\w*|damn\w*|crap\w*|ass(?:hole)?s?|bitch\w*|hell|motherfuck\w*|bullshit|piss\w*)\b", re.I)


def features(text: str, self_name: str = "Amy") -> list[float]:
    words = re.findall(r"[A-Za-z']+", text)
    low = text.lower()
    stripped = text.rstrip()
    return [
        float(stripped.endswith("?")), float(stripped.endswith("!")), float(stripped.endswith(("...", "…", "-", ","))),
        float(len(words) <= 3), float(len(words) > 40),
        float(bool(re.search(r"\byou(?:r|'re|'ve|'ll|'d)?\b", low))), float(bool(re.search(r"\b(?:i|me|my|i'm|i've|i'll|i'd)\b", low))),
        float(bool(_QUESTION_START.match(text))), float(bool(_COMMAND_START.match(text))),
        float(bool(self_name and re.search(rf"\b{re.escape(self_name.lower())}\b", low))), float(bool(_SWEAR.search(text))),
        float(bool(re.search(r"\bnot\b|n't\b", low))), float('"' in text or "“" in text), float(bool(re.search(r"\bif\b", low))),
        float(bool(re.search(r"\b(?:because|so)\b", low))),
    ]


def embed(texts: list[str], model: str, host: str = EMBED_HOST, timeout: float = 30) -> list[list[float]]:
    """The embedding model's numbers for each line, at unit length. Raises saying what failed and the fix."""
    request = urllib.request.Request(f"{host}/api/embed", method="POST", headers={"Content-Type": "application/json"},
                                     data=json.dumps({"model": model, "input": [t[:MAX_CHARS] for t in texts]}).encode("utf-8"))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            vectors = json.load(response)["embeddings"]
    except Exception as error:
        raise RuntimeError(f"The embedding model {model} at {host} didn't answer ({error}), so the line can't be read "
                           f"for what kind it is. Fix: check Ollama is running and `ollama list` shows {model}.") from error
    out = []
    for v in vectors:
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        out.append([x / norm for x in v])
    return out


@dataclass
class Reading:
    """What she makes of one line: for each kind, how sure (0..1) and where that came from."""
    scores: dict[str, float]
    because: dict[str, dict] = field(default_factory=dict)  # kind -> {"meaning": x, "features": {name: x}, "base": x}

    def kinds(self, at_least: float = 0.5) -> list[str]:
        return sorted((k for k, v in self.scores.items() if v >= at_least), key=lambda k: -self.scores[k])

    def is_(self, kind: str, at_least: float = 0.5) -> bool:
        return self.scores.get(kind, 0.0) >= at_least


class Recognizer:
    def __init__(self, model: dict, embedder=None) -> None:
        self.model = model
        self.embed_model = model["embedding_model"]
        self.labels = model["labels"]            # kind -> {"weights": [...], "bias": b, "threshold": t, "held_out": {...}}
        self.dim = model["embedding_size"]
        self.embedder = embedder or (lambda texts: embed(texts, self.embed_model))

    @classmethod
    def load(cls, path: str | Path, embedder=None) -> "Recognizer":
        file = Path(path)
        if not file.exists():
            raise FileNotFoundError(f"No trained recognizer at {file}. Fix: run corpus/train.py, which writes it.")
        return cls(json.loads(file.read_text(encoding="utf-8")), embedder)

    def read(self, text: str, self_name: str = "Amy", vector: list[float] | None = None) -> Reading:
        vector = vector if vector is not None else self.embedder([text])[0]
        plain = features(text, self_name)
        scores, because = {}, {}
        for kind, spec in self.labels.items():
            w = spec["weights"]
            meaning = sum(a * b for a, b in zip(w[: self.dim], vector))
            parts = {name: w[self.dim + i] * value for i, (name, value) in enumerate(zip(FEATURE_NAMES, plain)) if value}
            total = meaning + sum(parts.values()) + spec["bias"]
            scores[kind] = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, total))))
            because[kind] = {"meaning": round(meaning, 3), "features": {k: round(v, 3) for k, v in parts.items()},
                             "base": round(spec["bias"], 3)}
        return Reading(scores, because)

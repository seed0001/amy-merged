"""Train the recognizer (brain/dialogue/recognizer.py) from the provisional labels, and test it honestly.

One simple layer per kind of line: a weight for each of the embedding's numbers and for each plain feature. The
labels are the old language model's reads (labels.py), so they are a starting point, not the truth. To see how far
they can be trusted, whole conversations are held out: every line of a (conversation, day) is either trained on or
tested on, never both, so a score here is about conversations the recognizer has never seen.

A kind with too few examples to test is left out and listed, not guessed at.

    python train.py [labels.jsonl] [embeddings.npy] [../brain/data/recognizer.json]
"""

import datetime
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "brain"))
from dialogue.recognizer import FEATURE_NAMES, features  # noqa: E402

LABELS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "labels.jsonl")
VECTORS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "embeddings.npy")
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, "..", "brain", "data", "recognizer.json")
MIN_POSITIVE_TRAIN, MIN_POSITIVE_TEST = 40, 10
HELD_OUT_SHARE = 0.2
LOW, HIGH = 0.35, 0.7
# The old model's reads that say what the speaker is doing. Its reads of how a line sits with her (resonance,
# novelty, depth, substance, repetition) depend on her state at the time, not on the line, so they are not learned here.
SPEAKER_ACTS = ["praise", "request", "question_for_her", "open_question", "addressed", "acknowledges", "affection", "humor",
                "irritant", "contempt", "yelling", "rebuff", "apology", "flirt", "opening_up", "topic_shift", "monologue",
                "left_open", "creation_liked", "winding_down", "elsewhere"]

index = [json.loads(line) for line in open(VECTORS.replace(".npy", "-index.jsonl"), encoding="utf-8")]
vectors = np.load(VECTORS)
assert len(index) == len(vectors), f"{len(index)} lines in the index but {len(vectors)} vectors: run embed.py again"
row_of = {(r["at"], r["speaker"], r["text"]): i for i, r in enumerate(index)}
labelled = [json.loads(line) for line in open(LABELS, encoding="utf-8")]
labelled = [(row_of[(r["at"], r["speaker"], r["text"])], r) for r in labelled if (r["at"], r["speaker"], r["text"]) in row_of]

plain = np.array([features(r["text"]) for r in index], dtype=np.float32)
X_all = np.hstack([vectors, plain])
# A session is one conversation in one clock hour. Almost every scored line is from one voice channel over four
# days, so holding out whole days left more to test on than to train on; an hour is still a stretch of talk the
# recognizer never saw any part of.
session = lambda ms: datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H")
group = lambda r: f"{r['conversation']}|{session(r['at'])}"
held_out = lambda r: int(hashlib.sha1(group(r).encode()).hexdigest(), 16) % 100 < HELD_OUT_SHARE * 100


def fit(X, y, steps=400, lr=0.5, l2=1e-3):
    """Logistic regression by plain gradient descent, the rarer side weighted up so it isn't drowned out."""
    w, b = np.zeros(X.shape[1], dtype=np.float64), 0.0
    weight = np.where(y == 1, len(y) / (2 * max(y.sum(), 1)), len(y) / (2 * max(len(y) - y.sum(), 1)))
    for _ in range(steps):
        p = 1 / (1 + np.exp(-(X @ w + b)))
        g = (p - y) * weight
        w -= lr * (X.T @ g / len(y) + l2 * w)
        b -= lr * g.mean()
    return w, b


def auc(scores, y):
    order = np.argsort(scores)
    ranks = np.empty(len(scores)); ranks[order] = np.arange(1, len(scores) + 1)
    pos, neg = y.sum(), len(y) - y.sum()
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg)) if pos and neg else float("nan")


def measure(scores, y, threshold):
    said = scores >= threshold
    tp, fp, fn = int((said & (y == 1)).sum()), int((said & (y == 0)).sum()), int((~said & (y == 1)).sum())
    precision, recall = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    return {"precision": round(precision, 3), "recall": round(recall, 3), "f1": round(2 * precision * recall / max(precision + recall, 1e-9), 3)}


model = {"trained": datetime.datetime.now().isoformat(timespec="seconds"), "embedding_model": os.environ.get("EMBED_MODEL", "bge-m3"),
         "embedding_size": int(vectors.shape[1]), "feature_names": FEATURE_NAMES, "labels": {}, "left_out": {},
         "note": "Trained on the old language model's reads of each line: provisional labels, not ground truth. "
                 "held_out figures are on whole conversations never trained on."}
print(f"{'kind':18s} {'train+':>7s} {'test+':>6s} {'AUC':>6s} {'prec':>6s} {'recall':>6s} {'F1':>6s}   strongest plain features")
# stored_fact is not trained: matching an old memory back to "the line before it" tags lines like "Can you hear me,
# Amy?" as the source of a fact. What is worth keeping has no usable label in the archives; it needs hand labels.
for kind in SPEAKER_ACTS:
    rows = [(i, r) for i, r in labelled if "intake" in r["sources"]]
    # A yes only where the old model was confident, a no only where it said nothing or little; its in-between
    # reads (0.4 to 0.6) were handed out loosely and are left out rather than guessed either way.
    rows = [(i, r) for i, r in rows if not (LOW < r["labels"].get(kind, 0.0) < HIGH)]
    y = np.array([1.0 if r["labels"].get(kind, 0.0) >= HIGH else 0.0 for _, r in rows])
    test = np.array([held_out(r) for _, r in rows])
    X = X_all[[i for i, _ in rows]].astype(np.float64)
    if y[~test].sum() < MIN_POSITIVE_TRAIN or y[test].sum() < MIN_POSITIVE_TEST:
        model["left_out"][kind] = f"{int(y[~test].sum())} examples to train on and {int(y[test].sum())} to test on: too few to trust"
        continue
    w, b = fit(X[~test], y[~test])
    train_scores, test_scores = 1 / (1 + np.exp(-(X[~test] @ w + b))), 1 / (1 + np.exp(-(X[test] @ w + b)))
    # The threshold that did best on the lines it was trained on; judged on the held-out conversations.
    threshold = max(np.arange(0.2, 0.9, 0.05), key=lambda t: measure(train_scores, y[~test], t)["f1"])
    held = {"lines": int(test.sum()), "positive": int(y[test].sum()), "auc": round(auc(test_scores, y[test]), 3), **measure(test_scores, y[test], threshold)}
    model["labels"][kind] = {"weights": [round(float(v), 5) for v in w], "bias": round(float(b), 5), "threshold": round(float(threshold), 2),
                             "trained_on": {"lines": int((~test).sum()), "positive": int(y[~test].sum())}, "held_out": held}
    top = sorted(zip(FEATURE_NAMES, w[vectors.shape[1]:]), key=lambda t: -abs(t[1]))[:3]
    print(f"{kind:18s} {int(y[~test].sum()):7d} {held['positive']:6d} {held['auc']:6.2f} {held['precision']:6.2f} {held['recall']:6.2f} {held['f1']:6.2f}   "
          + ", ".join(f"{name} {weight:+.2f}" for name, weight in top))

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(model, f)
print("\nleft out:", json.dumps(model["left_out"], indent=1) if model["left_out"] else "none")
print("wrote", os.path.abspath(OUT))

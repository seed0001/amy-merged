"""Turn every line people said in the corpus into the numbers the recognizer reads.

Uses the embedding model already on this PC (bge-m3 through Ollama). It is not a language model writing anything:
it maps a line to 1024 numbers so that lines with similar meaning land near each other. The vectors are saved in
the order of the corpus's user lines, unit length, beside a small index that says which line each row is.

A run can be stopped and started again: lines already embedded are kept.

    python embed.py [conversations.jsonl] [embeddings.npy]
"""

import json
import os
import sys
import time
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "conversations.jsonl")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "embeddings.npy")
HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
BATCH = 64
MAX_CHARS = 2000  # a line longer than this is read by its first 2000 characters


def embed(texts: list[str]) -> np.ndarray:
    request = urllib.request.Request(f"{HOST}/api/embed", method="POST", headers={"Content-Type": "application/json"},
                                     data=json.dumps({"model": MODEL, "input": texts}).encode("utf-8"))
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            vectors = np.array(json.load(response)["embeddings"], dtype=np.float32)
    except Exception as error:
        raise SystemExit(f"The embedding model {MODEL} at {HOST} didn't answer: {error}. "
                         f"Fix: check Ollama is running and `ollama list` shows {MODEL}.")
    return vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9)


lines = [r for r in (json.loads(line) for line in open(CORPUS, encoding="utf-8")) if r["role"] == "user"]
partial = OUT + ".partial.npy"
done = np.load(partial) if os.path.exists(partial) else None
start = 0 if done is None else len(done)
chunks = [] if done is None else [done]
print(f"{len(lines)} lines, {start} already embedded.", flush=True)
began = time.time()
for i in range(start, len(lines), BATCH):
    chunks.append(embed([r["text"][:MAX_CHARS] for r in lines[i:i + BATCH]]))
    if (i // BATCH) % 25 == 0:
        np.save(partial, np.concatenate(chunks))
        rate = (time.time() - began) / max(i + BATCH - start, 1)
        print(f"  {min(i + BATCH, len(lines))}/{len(lines)}  about {rate * (len(lines) - i - BATCH) / 60:.1f} min left", flush=True)
vectors = np.concatenate(chunks)
np.save(OUT, vectors)
with open(OUT.replace(".npy", "-index.jsonl"), "w", encoding="utf-8") as f:
    for r in lines:
        f.write(json.dumps({"at": r["at"], "conversation": r["conversation"], "speaker": r["speaker"], "text": r["text"]}, ensure_ascii=False) + "\n")
if os.path.exists(partial):
    os.remove(partial)
print(f"wrote {vectors.shape[0]} vectors of {vectors.shape[1]} numbers to {OUT}")

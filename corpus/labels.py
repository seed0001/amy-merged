"""Provisional labels for the recognizer, taken from what the old language model made of each line.

These are NOT ground truth (Owner's chat adviser, 2026-11-11: "use the old LLM scores as provisional labels...
audit a representative sample"). They are the starting point a small recognizer is trained from, checked on
held-out conversations and corrected by hand where the audit shows them wrong.

Two sources, both matched back to the corpus line they were about:
  - "intake" events in every archived activity.jsonl: the old model's 0..1 read of a line it heard (praise,
    request, question_for_her, irritant, contempt, humor ...). The event has no text: it is matched to the line the
    same speaker said in the same conversation just before it.
  - the memories table in every archived companion.db: a fact the old model chose to keep ("Owner said in the
    voice call: ..."). The line it came from is the nearest earlier line by that speaker. A line that led to a
    kept memory is labelled stored_fact; a line said while memories were being kept that led to none is not.

    python labels.py [C:\\Bots] [conversations.jsonl] [labels.jsonl]
"""

import bisect
import collections
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sys.argv[1] if len(sys.argv) > 1 else r"C:\Bots"
CORPUS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "conversations.jsonl")
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, "labels.jsonl")
SKIP_DIRS = {"node_modules", "browser-profile", ".git", "wordnet", "amy-merged", "__pycache__", "site-packages"}
INTAKE_WINDOW_MS = 120_000   # the read of a line lands within two minutes of the line
MEMORY_WINDOW_MS = 300_000   # a memory is written after the reply, within five minutes of the line
NOT_SIGNALS = {"time"}

corpus = [json.loads(line) for line in open(CORPUS, encoding="utf-8")]
lines = [r for r in corpus if r["role"] == "user"]
by_speaker = collections.defaultdict(list)  # speaker -> [(at, index into lines)]
for i, r in enumerate(lines):
    by_speaker[r["speaker"].casefold()].append((r["at"], i))
for v in by_speaker.values():
    v.sort()


def line_before(speaker: str, at: int, window: int, conversation: str | None = None) -> int | None:
    """The line this speaker said most recently before `at` (and within the window): what a read or a memory is about."""
    said = by_speaker.get(str(speaker or "").casefold())
    if not said:
        return None
    k = bisect.bisect_right(said, (at + 2000, 10**9)) - 1
    while k >= 0 and at - said[k][0] <= window:
        i = said[k][1]
        if conversation is None or lines[i]["conversation"] == conversation:
            return i
        k -= 1
    return None


signals: dict[int, dict] = {}      # line index -> the old model's read of it
memory_spans: list[tuple[int, int]] = []  # (first, last) time memories were being kept in an archive
stored: set[int] = set()
found = collections.Counter()
MEMORY_SPEAKER = re.compile(r"^(.{1,40}?) said in [^:]{1,60}: ")

for base, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.endswith("venv")]
    for name in files:
        full = os.path.join(base, name)
        if name == "activity.jsonl":
            with open(full, encoding="utf-8", errors="replace") as f:
                for raw in f:
                    if '"type":"intake"' not in raw:
                        continue
                    try:
                        e = json.loads(raw)
                    except ValueError:
                        continue
                    found["intake events"] += 1
                    i = line_before(e.get("speaker"), e.get("time", 0), INTAKE_WINDOW_MS, e.get("conversation"))
                    if i is None:
                        found["intake with no line to match"] += 1
                        continue
                    read = {k: float(v) for k, v in e.items() if isinstance(v, (int, float)) and k not in NOT_SIGNALS}
                    signals[i] = {**signals.get(i, {}), **read}
        elif name.endswith(".db"):
            try:
                conn = sqlite3.connect(f"file:{full}?mode=ro", uri=True)
                if not conn.execute("select 1 from sqlite_master where name='memories'").fetchone():
                    continue
                rows = conn.execute("select content, created_at from memories").fetchall()
            except sqlite3.Error:
                continue
            times = [at for _, at in rows if isinstance(at, int)]
            if times:
                memory_spans.append((min(times), max(times)))
            for content, at in rows:
                m = MEMORY_SPEAKER.match(str(content))
                if not m or not isinstance(at, int):
                    continue
                found["memories"] += 1
                i = line_before(m[1], at, MEMORY_WINDOW_MS)
                if i is None:
                    found["memories with no line to match"] += 1
                else:
                    stored.add(i)

in_memory_span = lambda at: any(a - MEMORY_WINDOW_MS <= at <= b for a, b in memory_spans)
written = collections.Counter()
with open(OUT, "w", encoding="utf-8") as out:
    for i, r in enumerate(lines):
        labels = dict(signals.get(i, {}))
        sources = ["intake"] if i in signals else []
        # Only lines said to a bot that was keeping memories at the time can say anything about what gets stored.
        if not r["is_bot"] and in_memory_span(r["at"]) and not r["heard_only"]:
            labels["stored_fact"] = 1.0 if i in stored else 0.0
            sources.append("memory")
        if not sources:
            continue
        out.write(json.dumps({"at": r["at"], "conversation": r["conversation"], "speaker": r["speaker"], "text": r["text"],
                              "labels": labels, "sources": sources}, ensure_ascii=False) + "\n")
        written["lines with any label"] += 1
        for s in sources:
            written[f"from {s}"] += 1
        if labels.get("stored_fact") == 1.0:
            written["stored_fact yes"] += 1

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
print(dict(found))
print(dict(written))
print("signal counts (read at 0.5 or more):")
counts = collections.Counter(k for read in signals.values() for k, v in read.items() if v >= 0.5)
print("  " + ", ".join(f"{k} {n}" for k, n in counts.most_common()))
print("wrote", OUT)

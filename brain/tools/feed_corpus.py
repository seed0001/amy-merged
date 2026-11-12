"""Feed archived conversations into her memory, and measure what she made of each line.

The corpus is corpus/conversations.jsonl (corpus/compile.py builds it from every archived new champ database):
one line per thing said, with who said it and when. Each line is given to her as that speaker, exactly as if it
were said to her now, so what she learns carries who told her. Her own old replies (written by a language model)
are never fed: only what people said.

For every line the result file records whether she could read it, what she learned from it and what she
couldn't make sense of, so the same run is the test of how well she understands the way her owner really talks.
A run can be stopped and started again: lines already in the result file are skipped.

    python tools/feed_corpus.py --corpus ../corpus/conversations.jsonl --db data/amy-corpus.db \
        --results ../corpus/results/run1.jsonl [--speaker Owner] [--limit 200] [--bots "Nova,Alex"]
"""

import argparse
import collections
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.chdir(Path(__file__).resolve().parent.parent)

from app.conversation import Conversation  # noqa: E402
from db.repository import Repository  # noqa: E402


def read_line(convo: Conversation, row: dict, bots: set[str]) -> dict:
    started = time.perf_counter()
    try:
        reply = convo.handle(row["text"], speaker=row["speaker"], speaker_id=row.get("user_id"),
                             is_bot=bool(row.get("is_bot")) or row["speaker"] in bots)
        trace = reply.trace or {}
        sentences = trace.get("sentences") or []
        missed = [s.get("parse_error") or s.get("error") for s in sentences if s.get("parse_error") or s.get("error")]
        learned = [st.get("text") for s in sentences for st in (s.get("stored") or []) if st.get("text")]
        return {"sentences": len(sentences), "missed": missed, "learned": learned, "intent": trace.get("intent"),
                "reply": reply.text[:300], "ms": round((time.perf_counter() - started) * 1000)}
    except Exception as error:  # one line she chokes on is a result, not the end of the run
        return {"sentences": 0, "missed": [], "learned": [], "intent": None, "reply": "",
                "crash": f"{type(error).__name__}: {error}"[:300], "ms": round((time.perf_counter() - started) * 1000)}


def verdict(result: dict) -> str:
    if result.get("crash"):
        return "crashed"
    if not result["sentences"]:
        return "handled"  # answered by a path that doesn't parse sentences (a greeting, a question about herself)
    if not result["missed"]:
        return "read"
    return "partly" if len(result["missed"]) < result["sentences"] else "not read"


def report(results_path: Path) -> None:
    rows = [json.loads(line) for line in results_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        print("No results yet.")
        return
    verdicts = collections.Counter(r["verdict"] for r in rows)
    facts = sum(len(r["learned"]) for r in rows)
    reasons = collections.Counter(reason for r in rows for reason in r["missed"])
    crashes = collections.Counter(r["crash"].split(":")[0] for r in rows if r.get("crash"))
    total = len(rows)
    print(f"\n{total} lines fed, {facts} facts learned, {sum(r['ms'] for r in rows) / 1000 / max(total, 1):.2f}s a line")
    for name in ("read", "handled", "partly", "not read", "crashed"):
        print(f"  {name:9s} {verdicts[name]:6d}  {100 * verdicts[name] / total:5.1f}%")
    print("Why she couldn't read a sentence (top 12):")
    for reason, n in reasons.most_common(12):
        print(f"  {n:5d}  {reason}")
    if crashes:
        print("Crashes:", dict(crashes))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--db", required=True, help="her memory file to feed (created if missing)")
    ap.add_argument("--results", required=True)
    ap.add_argument("--speaker", help="only this speaker's lines")
    ap.add_argument("--limit", type=int, help="stop after this many lines in this run")
    ap.add_argument("--bots", default="", help="comma-separated speaker names that are other bots")
    ap.add_argument("--report", action="store_true", help="only print the summary of the result file")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    results_path = Path(args.results).resolve()
    results_path.parent.mkdir(parents=True, exist_ok=True)
    if args.report:
        return report(results_path)

    bots = {name.strip() for name in args.bots.split(",") if name.strip()}
    rows = [json.loads(line) for line in Path(args.corpus).read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = [r for r in rows if r["role"] != "assistant" and (not args.speaker or r["speaker"] == args.speaker)]
    done = sum(1 for _ in results_path.open(encoding="utf-8")) if results_path.exists() else 0
    todo = rows[done:done + args.limit] if args.limit else rows[done:]
    print(f"{len(rows)} lines in the corpus for this run, {done} already fed, feeding {len(todo)} now.", flush=True)

    convo = Conversation(Repository(args.db), self_name=os.environ.get("HALMINI_NAME", "Amy"), curious=True, persona="amy")
    began = time.time()
    with results_path.open("a", encoding="utf-8") as out:
        for n, row in enumerate(todo, 1):
            result = read_line(convo, row, bots)
            result.update(verdict=verdict(result), at=row["at"], speaker=row["speaker"], text=row["text"])
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
            out.flush()
            if n % 50 == 0:
                rate = (time.time() - began) / n
                print(f"  {done + n}/{len(rows)}  {rate:.2f}s a line, about {rate * (len(todo) - n) / 60:.0f} min left", flush=True)
    report(results_path)


if __name__ == "__main__":
    main()

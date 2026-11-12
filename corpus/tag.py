"""A local model reads lines people said in the corpus and tags them on ten layers. The tags train her recognizer.

Owner, 2026-11-11: "run it through a local model that's pretty smart, and he's going to tag everything, whatever we
need on it... really go all out on this." The model works here, offline, as a labeller. It never runs inside her:
what she uses is the small recognizer trained from these tags, whose weights can be read. The tags are a model's
opinion: provisional, tested on held-out conversations and spot-checked.

The scheme is scheme.py (in words: TAG-SCHEME.md): ten layers, asked for in five short passes, because a small model
handed one big form gets lazy.

Lines are tagged in windows of consecutive lines, so the model sees the conversation around them. Windows are taken
in a fixed shuffled order and each window gets all five passes before the next begins, so a run stopped at any point
has fully tagged a fair sample of everything.

Resumable: a (line, pass) already in the tag file is skipped. The studio (studio.py) shows it happening and can pause it.

    python tag.py --model gemma4:12b --lines 5000 [--tags tags.jsonl] [--window 6] [--passes address_act,links]
"""

import argparse
import json
import os
import random
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from scheme import HEADER, PASSES, clean, schema_for  # noqa: E402

HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")


def windows(rows: list[dict], size: int) -> list[list[int]]:
    """Runs of consecutive lines said by people, within one conversation and a 20-minute gap, in a fixed shuffled order."""
    by_conversation: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        by_conversation.setdefault(r["conversation"], []).append(i)
    out = []
    for indices in by_conversation.values():
        run: list[int] = []
        last = None
        for i in indices:
            r = rows[i]
            if last is not None and r["at"] - last > 20 * 60_000 and run:
                out.append(run); run = []
            last = r["at"]
            if r["role"] == "user" and not r["is_bot"]:
                run.append(i)
                if len(run) == size:
                    out.append(run); run = []
        if run:
            out.append(run)
    random.Random(20261111).shuffle(out)
    return out


def prompt_for(rows: list[dict], window: list[int], bots: list[str], context: int = 6) -> str:
    first = window[0]
    conversation = rows[first]["conversation"]
    before = [i for i in range(max(0, first - 60), first) if rows[i]["conversation"] == conversation][-context:]
    wanted = set(window)
    lines = []
    for i in before + list(range(first, window[-1] + 1)):
        r = rows[i]
        if r["conversation"] != conversation:
            continue
        who = f"{r['speaker']}{' [bot]' if r['is_bot'] or r['role'] == 'assistant' else ''}"
        lines.append(f"TAG id={i} | {who}: {r['text'][:600]}" if i in wanted else f"CONTEXT id={i} | {who}: {r['text'][:300]}")
    # A bot that hasn't spoken nearby is still a bot when someone talks to it by name.
    return f"The AI companion bots are named: {', '.join(bots)}. Anyone else is a human.\n\n" + "\n".join(lines)


def ask(model: str, spec: dict, prompt: str, timeout: float = 900) -> list[dict]:
    body = {"model": model, "stream": False, "format": schema_for(spec), "think": False, "keep_alive": "30m",
            "options": {"temperature": 0, "num_ctx": 12288, "num_predict": 4000},
            "messages": [{"role": "system", "content": f"{HEADER}\n\n{spec['ask']}"}, {"role": "user", "content": prompt}]}
    request = urllib.request.Request(f"{HOST}/api/chat", method="POST", headers={"Content-Type": "application/json"},
                                     data=json.dumps(body).encode("utf-8"))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            answer = json.load(response)
    except Exception as error:
        raise RuntimeError(f"{model} at {HOST} didn't answer: {error}. Fix: check Ollama is running and `ollama list` shows {model}.") from error
    return json.loads(answer["message"]["content"]).get("lines", [])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True)
    ap.add_argument("--corpus", default=os.path.join(HERE, "conversations.jsonl"))
    ap.add_argument("--tags", default=os.path.join(HERE, "tags.jsonl"))
    ap.add_argument("--window", type=int, default=6)
    ap.add_argument("--lines", type=int, help="tag this many lines in all (a fair sample); default is every line")
    ap.add_argument("--passes", help="comma-separated pass names; default is all five")
    ap.add_argument("--group", type=int, default=20, help="windows that get one pass before the next pass starts")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    status_path = args.tags.replace(".jsonl", "-status.json")
    pause_path = args.tags.replace(".jsonl", ".pause")
    passes = [p for p in PASSES if not args.passes or p["name"] in args.passes.split(",")]

    rows = [json.loads(line) for line in open(args.corpus, encoding="utf-8")]
    done: set[tuple[int, str]] = set()
    if os.path.exists(args.tags):
        for line in open(args.tags, encoding="utf-8"):
            if line.strip():
                t = json.loads(line)
                done.add((t["id"], t["pass"]))
    plan, count = [], 0
    for w in windows(rows, args.window):
        if args.lines and count >= args.lines:
            break
        plan.append(w)
        count += len(w)
    total = count * len(passes)
    already = sum(1 for w in plan for i in w for p in passes if (i, p["name"]) in done)
    print(f"{count} lines x {len(passes)} passes = {total} tags to make; {already} already done; model {args.model}", flush=True)

    began, made, failed, spent = time.time(), 0, 0, 0.0
    per_pass = {p["name"]: sum(1 for w in plan for i in w if (i, p["name"]) in done) for p in passes}

    def status(state: str, note: str = "") -> None:
        rate = spent / made if made else None
        left = total - already - made
        with open(status_path + ".tmp", "w", encoding="utf-8") as f:
            json.dump({"state": state, "note": note, "model": args.model, "lines": count, "passes": [p["name"] for p in passes],
                       "per_pass": per_pass, "total": total, "done": already + made, "this_run": made, "failed_windows": failed,
                       "seconds_per_tag": rate, "eta_seconds": rate * left if rate else None, "started": began, "updated": time.time(),
                       "pid": os.getpid()}, f)
        os.replace(status_path + ".tmp", status_path)

    bots = sorted({r["speaker"] for r in rows if r["is_bot"] or r["role"] == "assistant"}, key=str.casefold)
    # A group of windows gets one pass, then the next pass, and so on, before the next group starts. The model keeps
    # a pass's long instructions loaded between calls that way (switching pass on every call made it re-read them each
    # time, about 32 seconds a line), and a stopped run is still complete up to its last finished group.
    groups = [plan[i:i + args.group] for i in range(0, len(plan), args.group)]
    status("starting")
    with open(args.tags, "a", encoding="utf-8") as out:
        for spec, window in ((spec, window) for group in groups for spec in passes for window in group):
            if True:
                todo = [i for i in window if (i, spec["name"]) not in done]
                if not todo:
                    continue
                while os.path.exists(pause_path):
                    status("paused", "Paused from the studio. Resume there to carry on.")
                    time.sleep(2)
                prompt = prompt_for(rows, window, bots)
                t0 = time.time()
                try:
                    by_id = {t.get("id"): t for t in ask(args.model, spec, prompt) if isinstance(t, dict)}
                except Exception as error:  # a window the model fails on is skipped and counted; a later run picks it up
                    failed += 1
                    status("running", f"{spec['name']}: a window failed and was skipped: {str(error)[:200]}")
                    print("  failed:", spec["name"], str(error)[:160], flush=True)
                    continue
                seconds = time.time() - t0
                got = [i for i in todo if i in by_id]
                for i in got:
                    r = rows[i]
                    out.write(json.dumps({"id": i, "pass": spec["name"], "at": r["at"], "conversation": r["conversation"], "speaker": r["speaker"],
                                          "text": r["text"], **clean(spec, by_id[i]), "model": args.model,
                                          "seconds": round(seconds / max(len(got), 1), 2)}, ensure_ascii=False) + "\n")
                    done.add((i, spec["name"]))
                out.flush()
                made += len(got)
                spent += seconds
                per_pass[spec["name"]] += len(got)
                if len(got) < len(todo):
                    failed += 1  # the model left lines out; they stay untagged for a later run
                status("running")
    status("finished", f"{made} tags made in this run.")
    print(f"made {made} tags in {time.time() - began:.0f}s ({spent / max(made, 1):.2f}s each), {failed} windows failed or came back short")


if __name__ == "__main__":
    main()

"""The tagging studio: a page to watch the local model tag the corpus, and to pause it.

    python studio.py [--port 8790] [--tags tags.jsonl]      then open http://localhost:8790

It only reads the tag file and the tagger's status file, and writes one thing: the pause marker the tagger checks
between calls. It never touches the corpus, her memory or a model.
"""

import argparse
import collections
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from scheme import PASSES  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8790)
ap.add_argument("--tags", default=os.path.join(HERE, "tags.jsonl"))
args = ap.parse_args()
STATUS = args.tags.replace(".jsonl", "-status.json")
PAUSE = args.tags.replace(".jsonl", ".pause")
PAGE = os.path.join(HERE, "studio.html")

cache = {"size": -1, "rows": []}


def tag_rows() -> list[dict]:
    """Every tag made so far. Re-read only when the file has grown."""
    if not os.path.exists(args.tags):
        return []
    size = os.path.getsize(args.tags)
    if size != cache["size"]:
        rows = []
        with open(args.tags, encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass  # the line being written right now
        cache.update(size=size, rows=rows)
    return cache["rows"]


def state() -> dict:
    rows = tag_rows()
    status = {}
    try:
        status = json.load(open(STATUS, encoding="utf-8"))
    except (OSError, ValueError):
        pass
    if status and status.get("state") in ("running", "starting") and time.time() - status.get("updated", 0) > 1200:
        status["state"] = "not responding"
        status["note"] = "The tagger hasn't reported for 20 minutes. It may have been closed. Start it again with start-tagging.bat; it carries on where it stopped."
    by_line: dict[int, dict] = {}
    order: list[int] = []
    for r in rows:
        line = by_line.setdefault(r["id"], {"id": r["id"], "speaker": r["speaker"], "text": r["text"], "at": r["at"], "passes": {}})
        line["passes"][r["pass"]] = {k: v for k, v in r.items() if k not in ("id", "pass", "at", "conversation", "speaker", "text", "model", "seconds")}
        order.append(r["id"])
    recent, seen = [], set()
    for i in reversed(order):
        if i not in seen:
            seen.add(i)
            recent.append(by_line[i])
        if len(recent) >= 40:
            break
    count = lambda values: collections.Counter(values).most_common(14)
    of = lambda name: [r for r in rows if r["pass"] == name]
    counts = {
        "What they're doing (acts)": count(a for r in of("address_act") for a in r.get("acts") or []),
        "Said to": count(r.get("to") for r in of("address_act")),
        "Feelings": count(f["feeling"] for r in of("feeling_stance_charge") for f in r.get("feelings") or []),
        "Charge": count(c["charge"] for r in of("feeling_stance_charge") for c in r.get("charge") or []),
        "Asks her mind to": count(c for r in of("call_form") for c in r.get("calls") or []),
        "Kind of fact": count(c["kind"] for r in of("subject_knowledge") for c in r.get("claims") or []),
        "How her last reply landed": count(r.get("last_reply") for r in of("links")),
        "Field": count(f for r in of("subject_knowledge") for f in r.get("field") or []),
    }
    claims = [{"speaker": r["speaker"], "said": r["text"][:160], **c} for r in of("subject_knowledge")[-60:] for c in r.get("claims") or []][-14:]
    return {"status": status, "paused": os.path.exists(PAUSE), "lines_touched": len(by_line),
            "lines_complete": sum(1 for line in by_line.values() if len(line["passes"]) == len(PASSES)),
            "passes": [{"name": p["name"], "layers": p["layers"]} for p in PASSES], "recent": recent,
            "counts": {k: [[str(name), n] for name, n in v if name is not None] for k, v in counts.items()}, "claims": claims[::-1]}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, kind: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.startswith("/api/state"):
            return self._send(200, json.dumps(state(), ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
        if self.path in ("/", "/index.html"):
            return self._send(200, open(PAGE, "rb").read(), "text/html; charset=utf-8")
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        if self.path == "/api/pause":
            open(PAUSE, "w").close()
        elif self.path == "/api/resume":
            if os.path.exists(PAUSE):
                os.remove(PAUSE)
        else:
            return self._send(404, b"not found", "text/plain")
        self._send(200, json.dumps({"paused": os.path.exists(PAUSE)}).encode(), "application/json")

    def log_message(self, *_) -> None:
        pass


if __name__ == "__main__":
    print(f"Tagging studio: http://localhost:{args.port}  (watching {args.tags})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()

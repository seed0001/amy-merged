"""The brain as a service: the body (Node) starts this process once and talks to it in JSON lines.

No Discord, no audio, no language model. One request per line on stdin, one answer per line on stdout:

    {"id": 1, "op": "hear", "text": "...", "speaker": "Owner", "speaker_id": "123", "is_bot": false}
    {"id": 1, "ok": true, "text": "...", "intent": "...", "learned": [...], "not_understood": [...],
     "feelings": {...}, "ms": 42}

    {"id": 2, "op": "ping"}   ->  {"id": 2, "ok": true, "name": "Amy", "db": "data/amy.db"}

The first line it prints is {"ready": true, ...} once the word database is loaded, so the body knows when she can
be spoken to. Anything the engine prints goes to stderr: stdout carries the protocol and nothing else. A failed
request answers {"ok": false, "error": what failed and why}; the process stays up.
"""

import json
import os
import sys
import time
import traceback

from app.config import load_config, load_dotenv
from app.conversation import Conversation
from db.repository import Repository


def summary(reply, repo=None) -> dict:
    """What the body needs from a turn: her words, what she took from the line, and how it landed."""
    trace = getattr(reply, "trace", None) or {}
    sentences = trace.get("sentences") or []
    learned = [stored.get("text") for s in sentences for stored in (s.get("stored") or []) if stored.get("text")]
    missed = [{"text": s.get("text"), "why": s.get("parse_error") or s.get("error")}
              for s in sentences if s.get("parse_error") or s.get("error")]
    expression = trace.get("expression") or {}
    # The things in her mind this turn touched: the two ends of every fact she stored and of every fact she used to
    # reach her answer. The body's mind view lights them up.
    fact_ids: set[int] = set()

    def walk(value) -> None:
        if isinstance(value, dict):
            for key, inner in value.items():
                if key == "assertion" and isinstance(inner, int):
                    fact_ids.add(inner)
                elif key == "steps" and isinstance(inner, list):
                    fact_ids.update(i for i in inner if isinstance(i, int))
                elif key in ("support", "against") and isinstance(inner, list) and all(isinstance(chain, list) for chain in inner):
                    # an answer's plan: each chain is the ids of the facts one proof stood on
                    fact_ids.update(i for chain in inner for i in chain if isinstance(i, int))
                else:
                    walk(inner)
        elif isinstance(value, list):
            for inner in value:
                walk(inner)

    walk({k: v for k, v in trace.items() if k in ("sentences", "proofs", "proof", "answer", "paragraph_plan")})
    touched: list[str] = []
    if repo is not None:
        for fact_id in sorted(fact_ids):
            row = repo.assertion(fact_id)
            if row is not None:
                touched += [f"{row['subj_type']}{row['subj_id']}", f"{row['obj_type']}{row['obj_id']}"]
    return {
        "touched": list(dict.fromkeys(touched)),
        "text": getattr(reply, "text", str(reply)),
        "intent": trace.get("intent"),
        "learned": learned,
        "not_understood": missed,
        "feelings": expression.get("emotions") or {},
        "tone": expression.get("tone"),
        "conflict": bool(trace.get("conflict")),
    }


RELATION_WORDS = {"instance_of": "is a", "subclass_of": "is a kind of", "has_property": "is"}


def mind_report(convo: Conversation) -> dict:
    """What she holds, for the body's mind view: every thing she knows of, every fact as a link between two of
    them with who told her and when, and every rule. Nothing is summarised or invented: each item is a row of
    her memory, worded by her own realizer."""
    from dialogue import realizer
    repo = convo.repo
    speakers = {row[0] for row in repo.conn.execute("SELECT DISTINCT speaker FROM utterances") if not row[0].startswith("source:")}
    none_id = repo.find_concept("__none__") if hasattr(repo, "find_concept") else None
    try:
        none_id = repo.none_concept()
    except Exception:
        pass
    things: dict[str, dict] = {}

    def thing(kind: str, ident: int) -> str | None:
        if kind == "c" and ident == none_id:
            return None  # "no object": the fact is about the subject alone
        key = f"{kind}{ident}"
        if key not in things:
            if kind == "e":
                row = repo.entity_row(ident)
                things[key] = {"key": key, "name": row["name"], "named": bool(row["proper"]), "at": row["created_at"],
                               "person": row["name"] in speakers, "self": ident == convo.self_id}
            else:
                things[key] = {"key": key, "name": repo.concept_lemma(ident), "named": False, "person": False, "self": False}
        return key

    facts = []
    for row in repo.all_assertions():
        subject, obj = thing(row["subj_type"], row["subj_id"]), thing(row["obj_type"], row["obj_id"])
        predicate = row["predicate"]
        relation = RELATION_WORDS.get(predicate) or predicate.removeprefix("rel:").replace("_", " ")
        try:
            text = realizer.realize_assertion(repo, row)
        except Exception:
            text = None
        facts.append({"id": row["id"], "from": subject, "to": obj, "relation": relation if row["polarity"] else f"not: {relation}",
                      "text": text, "denied": not row["polarity"], "confidence": row["confidence"],
                      "said_by": repo.source_speaker(row["id"]), "at": row["created_at"]})
    for row in repo.conn.execute("SELECT id FROM entities"):
        thing("e", row[0])  # someone she has met but holds no fact about yet still exists in her mind
    rules = []
    for rule in repo.active_rules() + repo.provisional_rules():
        try:
            text = realizer.rule_text(repo, rule)
        except Exception:
            text = None
        terms = []
        for pattern in rule["conditions"] + rule["conclusions"]:
            for spec in (pattern.get("subject"), pattern.get("obj")):
                if isinstance(spec, list) and spec and spec[0] in ("e", "c", "kind"):
                    key = thing("c" if spec[0] == "kind" else spec[0], spec[1])
                    if key:
                        terms.append(key)
        rules.append({"id": rule["id"], "text": text, "confidence": rule["confidence"], "status": rule["status"],
                      "terms": list(dict.fromkeys(terms))})
    return {"self": convo.self_name, "things": list(things.values()), "facts": facts, "rules": rules}


def serve(convo: Conversation, lines, out, name: str, db: str) -> None:
    def send(message: dict) -> None:
        out.write(json.dumps(message, ensure_ascii=False) + "\n")
        out.flush()

    send({"ready": True, "name": name, "db": db})
    for line in lines:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            if op == "ping":
                send({"id": request_id, "ok": True, "name": name, "db": db})
            elif op == "hear":
                text = str(request.get("text") or "").strip()
                if not text:
                    raise ValueError("hear needs text: the line that was said")
                started = time.perf_counter()
                reply = convo.handle(text, speaker=request.get("speaker") or None,
                                     speaker_id=request.get("speaker_id") or None,
                                     is_bot=bool(request.get("is_bot")))
                send({"id": request_id, "ok": True, **summary(reply, convo.repo),
                      "ms": round((time.perf_counter() - started) * 1000)})
            elif op == "mind":
                send({"id": request_id, "ok": True, **mind_report(convo)})
            else:
                raise ValueError(f"unknown op {op!r}: use hear, mind or ping")
        except Exception as error:  # the body is told what failed; the brain stays up for the next line
            traceback.print_exc(file=sys.stderr)
            send({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})


def main() -> None:
    protocol = sys.stdout
    if hasattr(protocol, "reconfigure"):
        protocol.reconfigure(encoding="utf-8")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout = sys.stderr  # nothing the engine prints may land in the protocol
    load_dotenv()
    config = load_config()
    name = os.environ.get("HALMINI_NAME", "Amy")
    convo = Conversation(Repository(config.db_path), self_name=name, max_depth=config.max_depth,
                         budget=config.inference_budget, curious=True, persona="amy")
    serve(convo, sys.stdin, protocol, name, config.db_path)


if __name__ == "__main__":
    main()

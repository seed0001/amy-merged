"""Paragraph interpretation and evidence-only prose plans.

Original clauses and their qualifications remain in the trace/history. Templates
order selected findings; they never infer a relationship between them.
"""
from dataclasses import asdict, dataclass, field, replace
import json
import re
from nlp.parser import parse_sentence, ParseError
from nlp.semantic_frames import Frame, NounPhrase, RuleFrame

from dialogue import realizer

SUMMARY = re.compile(r"^\W*(?:(?:please|can you|could you)\s+)?(?:what (?:have|had) we been (?:discussing|talking about|chatting about)|what (?:have|did) we (?:discuss|discussed|talk about|talked about)|(?:summarize|recap|sum up) (?:our|this|the)(?: full)? (?:discussion|conversation|chat)|what are we discussing)\W*$", re.I)


@dataclass
class Unit:
    text: str
    frames: list = field(default_factory=list)
    references: list = field(default_factory=list)
    gaps: list = field(default_factory=list)
    quoted: bool = False
    parse_error: str | None = None
    topic: str = ""


def sentences(text):
    # Sentence punctuation inside quotations belongs to the reported speech.
    chunks, start, quoted = [], 0, False
    for i, ch in enumerate(text):
        if ch in ('"', '“', '”'):
            quoted = not quoted
            tail = text[i+1:].lstrip()
            if not quoted and i and text[i-1] in '.?!' and tail[:1].isupper():
                chunks.append(text[start:i+1].strip())
                start = i+1
        if ch in '.?!' and not quoted and (i + 1 == len(text) or text[i+1].isspace()):
            chunks.append(text[start:i+1].strip())
            start = i + 1
    if text[start:].strip():
        chunks.append(text[start:].strip())
    return chunks


def interpret(c, text):
    pieces = sentences(text)
    if len(pieces) < 2 and not re.search('["“”]', text):
        return None
    units, people, things, last_claim = [], [], [], None
    for piece in pieces:
        unit = Unit(piece, quoted=bool(re.search('["“”]', piece)))
        units.append(unit)
        if unit.quoted:
            # The outer speaker is preserved in the utterance. Quoted "you" is
            # never treated as an assertion about the engine.
            unit.topic = "reported speech"
            continue
        try:
            parsed = parse_sentence(piece, c.lexicon(), names={c.self_name.lower()})
        except ParseError as exc:
            unit.parse_error = str(exc)
            unit.topic = "unresolved clause"
            continue
        if re.search(r"\bbecause\b", piece, re.I):
            # Meaning.learn resolves the actor/recipient within causal clauses
            # and preserves its provenance and uncertainty checks.
            unit.frames = parsed
            unit.topic = next((f.subject.surface for f in parsed if isinstance(f,Frame) and f.subject), "reported cause")
            continue
        previous_people, previous_things = list(people), list(things)
        current_people, current_things = [], []

        def bind(np, role="object"):
            if not isinstance(np, NounPhrase):
                return np
            if np.possessor:
                np = replace(np, possessor=bind(np.possessor, "subject"))
            if np.surface.lower() in ("that", "this") and np.pronoun:
                unit.references.append({"word":np.surface.lower(), "claim":last_claim})
                unit.gaps.append(f"Does '{np.surface.lower()}' refer to the preceding claim or to a particular thing?")
                return np
            if np.pronoun in ("he", "she", "they", "it", "that", "this"):
                # A name earlier in the same sentence wins ("Howard drove his truck").
                candidates = (current_things or previous_things) if np.pronoun == "it" else (current_people or previous_people)
                # Demonstratives may refer to a proposition, not a named person.
                if np.pronoun in ("that", "this"):
                    unit.references.append({"word": np.pronoun, "claim": last_claim})
                    unit.gaps.append(f"Does '{np.pronoun}' refer to the preceding claim or to a particular thing?")
                    return np
                unique = {n.surface.lower(): n for n in candidates}
                if len(unique) == 1:
                    target = next(iter(unique.values()))
                    unit.references.append({"word": np.pronoun, "referent": target.surface})
                    (current_things if np.pronoun == "it" else current_people).append(target)
                    return target
                unit.gaps.append(f"Who or what does '{np.pronoun}' refer to in “{piece}”?" )
                return np
            if np.proper and role in ("subject", "object"):
                current_people.append(np)
            elif not np.pronoun and np.determiner in ("a", "an", "the", "this", "that"):
                current_things.append(np)
            return np

        resolved = []
        for frame in parsed:
            if isinstance(frame, RuleFrame):
                resolved.append(frame)  # bound rule variables are not discourse pronouns
                continue
            if not isinstance(frame, Frame):
                continue
            resolved.append(replace(frame, subject=bind(frame.subject, "subject"), obj=bind(frame.obj),
                                    args=tuple((role, bind(value, "argument")) for role,value in frame.args)))
        unit.frames = resolved
        if current_people:
            people = current_people
        if current_things:
            things = current_things
        subject = next((f.subject for f in resolved if isinstance(f, Frame) and f.subject), None)
        unit.topic = subject.surface if subject else "conditional rule"
        last_claim = piece
    return units


def interpretation(units):
    return [{"text":u.text, "topic":u.topic,
             "role":"reported-speech" if u.quoted else "condition" if any(isinstance(f,RuleFrame) for f in u.frames)
                    else "question" if any(getattr(f,"act",None)=="ask" for f in u.frames) else "statement",
             "frames":[asdict(f) for f in u.frames],
             "references":u.references, "gaps":u.gaps, "quoted":u.quoted, "parse_error":u.parse_error}
            for u in units]


# Each structure has multiple shapes. Slots contain complete selected findings;
# connectors are available only for a corresponding evidence relationship.
TEMPLATES = {
    "cause-effect": ("{finding} {support}", "{finding}\n\n{support}"),
    "comparison": ("{finding} {support}", "{finding}\n\n{support}"),
    "chronology": ("{finding} {support}", "{finding}\n\n{support}"),
    "evidence-conclusion": ("{finding} {support}", "{finding}\n\n{support}"),
    "competing-interpretations": ("{finding}\n\n{support}", "{finding} {support}"),
    "progress": ("{finding} {support}", "{finding}\n\n{support}"),
}


def realize(c, plan):
    """Validate before realization; no free-form generated claims enter the plan."""
    claims = plan["claims"]
    seen = set()
    paragraphs = []
    for group in plan["groups"]:
        texts = []
        for index in group:
            claim = claims[index]
            key = re.sub(r"\s+", " ", claim["text"]).strip().casefold()
            if key in seen:
                continue
            if not claim.get("source"):
                raise ValueError("A paragraph finding needs a source")
            source = claim["source"]
            aids = ([source["assertion"]] if "assertion" in source else source.get("assertions", []))
            if any(c.repo.assertion(aid) is None or c.repo.assertion(aid)["status"] != "active" for aid in aids):
                raise ValueError("A selected finding has withdrawn or missing evidence")
            if "rule" in source and c.repo.rule(source["rule"])["status"] != "active":
                raise ValueError("A selected rule has been withdrawn")
            seen.add(key)
            texts.append(claim["text"])
        if texts:
            # Aggregate shared subjects only when each predicate has independent
            # evidence. Coordination says 'and', never an invented causal link.
            selected = [claims[i] for i in group if claims[i]["text"] in texts]
            if len(selected) > 1 and all(claim.get("coordination") for claim in selected):
                heads = {(claim["coordination"]["subject"], claim["coordination"]["qualifier"]) for claim in selected}
                if len(heads) == 1:
                    subject, qualifier = next(iter(heads))
                    predicates = list(dict.fromkeys(claim["coordination"]["predicate"] for claim in selected))
                    texts = [qualifier + subject + " " + realizer.join_clauses(predicates) + "."]
            paragraphs.append(" ".join(texts))
    clarifications = list(dict.fromkeys(plan.get("gaps", [])))
    if clarifications:
        paragraphs.append(clarifications[0])
    structure = plan.get("structure", "evidence-conclusion")
    variants = TEMPLATES[structure]
    uses = getattr(c, "_paragraph_shapes", {})
    shape_key = (c.state.speaker, structure)
    index = uses.get(shape_key, 0) % len(variants)
    uses[shape_key] = index + 1
    c._paragraph_shapes = uses
    plan["template"] = index
    plan["validation"] = {"ok":True, "unique_findings":len(seen), "clarifications":min(1,len(clarifications)),
                           "qualified_sources":True}
    if len(paragraphs) > 1 and not clarifications:
        return variants[index].format(finding=paragraphs[0], support="\n\n".join(paragraphs[1:])).strip()
    return "\n\n".join(paragraphs)


def compose(c, units, trace, learned, conflicts, answers, failed, dropped, questions):
    claims, groups, gaps = [], [], list(questions)
    asked = [item for item in trace["sentences"] if item.get("answers")]
    purpose = "answer" if asked else "acknowledge"
    if asked:
        for item in asked:
            group = []
            for answer in item["answers"]:
                # _answer already validates evidence and wording. Use its selected
                # answer and proof, never every other fact about the subject.
                text = answer["reply"]
                group.append(len(claims))
                claims.append({"text":text,"source":{"question":item["text"], "proofs":answer.get("proofs"),
                                         "assertions":[aid for path in answer.get("plan",{}).get("support",[])+answer.get("plan",{}).get("against",[]) for aid in path]},
                               "status":answer["status"]})
            groups.append(group)
    else:
        by_topic = {}
        for item, unit in zip(trace["sentences"], units):
            group = by_topic.setdefault(unit.topic, [])
            if unit.quoted:
                group.append(len(claims))
                claims.append({"text":"You reported: “"+unit.text+"”", "source":{"utterance":"current", "quoted":True}})
            if item.get("date_reply"):
                group.append(len(claims))
                claims.append({"text":item["date_reply"], "source":{"utterance":"current", "date":True}})
            graph = item.get("meaning", {})
            if graph.get("assertions"):
                effects = [realizer.realize_assertion(c.repo,c.repo.assertion(i)) for i in graph["assertions"]["effect"]]
                causes = [realizer.realize_assertion(c.repo,c.repo.assertion(i)) for i in graph["assertions"]["cause"]]
                if effects and causes:
                    group.append(len(claims))
                    claims.append({"text":"You reported that "+realizer.join_clauses(effects)+" because "+realizer.join_clauses(causes)+".",
                                   "source":{"utterance":"current","reported_cause":graph["assertions"]}})
            for stored in ([] if graph.get("assertions") else item.get("stored", [])):
                if "rule" in stored:
                    group.append(len(claims))
                    claims.append({"text":"Recorded the conditional rule: “"+unit.text+"”", "source":{"rule":stored["rule"]}})
                    continue
                row = c.repo.assertion(stored["assertion"])
                if row is None or row["status"] != "active" or not stored.get("validator",{}).get("ok"):
                    continue
                group.append(len(claims))
                qualifier = "You suggested: " if row["confidence"] < .75 else "Recorded: "
                subject = realizer.term_text(c.repo, row["subj_type"], row["subj_id"], definite=True)
                raw = stored["text"].rstrip(".")
                claim = {"text":qualifier+stored["text"], "source":{"assertion":row["id"]}}
                if raw.startswith(subject+" "):
                    claim["coordination"] = {"subject":subject,"predicate":raw[len(subject)+1:],"qualifier":qualifier}
                claims.append(claim)
            for rule_id in item.get("learned_rules", []):
                group.append(len(claims))
                claims.append({"text":"Recorded the conditional rule: “"+unit.text+"”", "source":{"rule":rule_id}})
            gaps.extend(unit.gaps)
        groups = [group for group in by_topic.values() if group]
        if dropped:
            claims.insert(0,{"text":"The correction withdraws: "+realizer.join_clauses(dropped)+".","source":{"correction":True}})
            groups = [[0]]+[[i+1 for i in g] for g in groups]
        if conflicts:
            claims.append({"text":"The reported claims conflict; both accounts remain in the record.","source":{"conflicts":conflicts}})
            groups.append([len(claims)-1])
    for unit in units:
        gaps.extend(unit.gaps)
    if failed and not gaps:
        gaps.append("What does this clause mean: “"+failed[0][0]+"”?")
    if not claims:
        if not gaps:
            gaps.append("Which claim or question should I address in this paragraph?")
        purpose = "clarify"
    structure = ("competing-interpretations" if conflicts else
                 "cause-effect" if any(i.get("meaning") for i in trace["sentences"]) else
                 "comparison" if re.search(r"\b(?:compare|comparison|difference|whereas)\b",trace.get("heard",""),re.I) else
                 "chronology" if re.search(r"\b(?:before|after|then|yesterday)\b",trace.get("heard",""),re.I) else "evidence-conclusion")
    plan = {"purpose":purpose, "structure":structure,
            "claims":claims, "groups":groups,"gaps":list(dict.fromkeys(gaps)),
            "coverage":[{"text":u.text,"parsed":bool(u.frames),"quoted":u.quoted,"gaps":u.gaps} for u in units]}
    prior = getattr(c, "_paragraph_findings", {})
    key = (c.state.speaker, purpose, tuple(sorted({u.topic for u in units})))
    signature = lambda claim: json.dumps({"text":claim["text"],"source":claim["source"]},sort_keys=True)
    current = {signature(claim) for claim in claims}
    old = prior.get(key)
    if old is not None:
        changed = {i for i,claim in enumerate(claims) if signature(claim) not in old[0]}
        plan["groups"] = [[i for i in group if i in changed] for group in groups]
        plan["gaps"] = [gap for gap in plan["gaps"] if gap not in old[1]]
    prior[key] = (current, set(gaps))
    c._paragraph_findings = prior
    text = realize(c, plan)
    return text or "No findings or unresolved references have changed.", plan


def summary_request(text):
    from dialogue.memory import SUMMARY_RE, tidy
    return bool(SUMMARY.fullmatch(tidy(text)) or SUMMARY_RE.fullmatch(tidy(text)))


def summarize(c, uid):
    from dialogue.memory import is_meta, ACK_RE
    rows = list(reversed(c.repo.turns(before_utterance=uid)))
    claims, by_topic, seen = [], {}, set()
    for row in rows:
        if row["role"] == "engine":
            if summary_request(row["prompt"]):
                continue
            saved = c.repo.conn.execute("SELECT trace_json FROM inference_traces WHERE utterance_id=? ORDER BY id DESC LIMIT 1",(row["utterance_id"],)).fetchone()
            if not saved:
                continue
            saved = json.loads(saved[0])
            for item in saved.get("sentences",[]):
                for answer in item.get("answers",[]):
                    if answer["status"] not in ("yes", "no", "conflicting"):
                        continue
                    key = ("engine",answer["reply"])
                    if key in seen:
                        continue
                    seen.add(key)
                    topic = next((f.get("subject",{}).get("surface") for f in item.get("frames",[]) if f.get("subject")), "discussion")
                    by_topic.setdefault(topic,[]).append(len(claims))
                    claims.append({"text":c.self_name+" answered: “"+answer["reply"]+"”",
                                   "source":{"turn":row["id"],"utterance":row["utterance_id"],"role":"engine"}})
            continue
        if is_meta(row["text"]) or summary_request(row["text"]) or ACK_RE.fullmatch(row["text"]):
            continue
        for clause in sentences(row["text"]):
            key = (row["speaker"], re.sub(r"\W+", " ",clause).strip().lower())
            if key in seen:
                continue
            seen.add(key)
            topic = "discussion"
            try:
                frames = parse_sentence(clause,c.lexicon())
                subject = next((f.subject for f in frames if isinstance(f,Frame) and f.subject),None)
                if subject:
                    topic = row["speaker"] if subject.pronoun == "i" else c.self_name if subject.pronoun == "you" else subject.surface
            except ParseError:
                pass
            # Exact excerpts preserve conditions, quotations, uncertainty and
            # historical corrections without turning a recap into factual learning.
            who = row["speaker"]
            act = "asked" if clause.endswith('?') else "corrected the account" if re.match(r"Correction\b",clause,re.I) else "reported"
            text = f"{who} {act}: “{clause}”"
            by_topic.setdefault(topic, []).append(len(claims))
            claims.append({"text":text,"source":{"turn":row["id"],"utterance":row["utterance_id"],"speaker":who}})
    previous = getattr(c,"_summary_findings",{})
    old = previous.get(c.state.speaker,set())
    keys = {json.dumps(claim,sort_keys=True) for claim in claims}
    changed = {i for i,claim in enumerate(claims) if json.dumps(claim,sort_keys=True) not in old}
    groups = [[i for i in group if i in changed] for group in by_topic.values()]
    previous[c.state.speaker] = keys
    c._summary_findings = previous
    plan = {"purpose":"summary", "structure":"progress" if old else "chronology", "claims":claims,
            "groups":[g for g in groups if g],"gaps":[]}
    text = realize(c,plan)
    if not claims:
        return "There is no substantive discussion to summarize yet.", plan
    if not text:
        return "No new discussion has been added since the previous summary.", plan
    return ("Since the previous summary: " if old else "Our discussion covered these reports and questions. ")+text,plan


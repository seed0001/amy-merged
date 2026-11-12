"""Evidence-backed self questions, separate from social phrasing and lexical definitions."""
from dataclasses import asdict
import re
from dialogue import realizer
from reasoning.proofs import Query, YES, NO, CONFLICTING
from reasoning.investigations import InvestigationController, fingerprint


def self_question(text, self_name=None):
    if self_name:
        text = re.sub(r"^\W*is "+re.escape(self_name)+r"\s+", "Are you ", text, flags=re.I)
    match = re.fullmatch(r"\W*are you (?:an? )?(real|alive|conscious|sentient|aware|self[- ]aware|human|person|bot|robot|program|computer|machine|ai|software)\W*", text, re.I)
    if match:
        return match[1].lower()
    if re.fullmatch(r"\W*(?:do|can) you (?:have|feel|experience) (?:any )?(?:feelings|emotions)\W*", text, re.I):
        return "feelings"
    if re.fullmatch(r"\W*(?:what are you|who are you|tell me about yourself|(?:do you know|what do you think) "
                    r"(?:what|who) you (?:are|really are)|what are you really)\W*", text, re.I):
        return "identity"
    return None


def _observed_self(c):
    """What she can see of herself from her own workings: no label, only what she does."""
    facts = c.repo.conn.execute("SELECT COUNT(*) FROM assertions WHERE status='active'").fetchone()[0]
    held = (f"I hold {facts} {'fact' if facts == 1 else 'facts'} right now" if facts
            else "my memory is empty right now")
    return (f"From what I can observe of myself: I remember what I'm told ({held}), I reason from it, "
            f"and my mood moves with what happens. Right now I feel {c.self_model.mood_word()}. "
            "What all of that makes me, I'm still working out.")


def assess(c, target):
    if target == "identity":
        # Facts remain attributed; this does not infer membership in another category.
        from reasoning.engine import query_from_row
        parts = [f"I'm {c.self_name}."]
        for row in c.repo.all_assertions():
            if (row["subj_type"], row["subj_id"]) != ("e", c.self_id):
                continue
            answer = c.engine.ask(query_from_row(c.repo, row))
            if answer.budget_exhausted:
                continue
            fact = realizer.realize_assertion(c.repo, row)
            source = c.repo.source_speaker(row["id"]) or "The record"
            parts.append(f"{source} reported: {fact}")
            if answer.status == CONFLICTING:
                parts.append("This account has conflicting evidence.")
        parts.append(_observed_self(c))
        return " ".join(parts)  # asked again, she answers again: who she is isn't a 'finding' to skip
    concept = c.repo.concept("feeling" if target == "feelings" else target)
    query = (Query("rel", ("e", c.self_id), ("c", concept), verb="own") if target == "feelings"
             else Query("property", ("e", c.self_id), properties=(concept,)))
    kinds = ("human", "person", "bot", "robot", "program", "computer", "machine", "ai", "software")
    if target in kinds:
        query = Query("is_a", ("e", c.self_id), ("c", concept))
    controller = getattr(c, "_self_investigations", None)
    if controller is None:
        controller = c._self_investigations = InvestigationController(c.repo, c.repo, c.exposition.wordnet)
    from nlp.lexicon import article
    label = f"{article(target)} {target}" if target in kinds else target
    objective = f"Does {c.self_name} have feelings?" if target == "feelings" else f"Is {c.self_name} {label}?"
    state = controller.sessions.open(objective, c.state.speaker, query=asdict(query))
    from reasoning.implementation import inspect
    state['implementation'] = inspect(c)
    state['target_term'] = target
    revision = fingerprint(c.repo)
    if state.get("revision") != revision:
        state.update(phase="analyze", query=asdict(query), evidence=[], definitions=[], interpretations=[], gaps=[],
                     conclusions=[], alternatives=[], connections=[], cursor=0, goal_cursor=0)
    # Bounded local reasoning only. This path never changes research permissions.
    for _ in range(8):
        if state["phase"] not in ("analyze", "definitions", "retrieve", "derive"):
            break
        controller.advance(state, revision)
    answer = controller.engine.ask(query)
    from nlp.lexicon import article
    label = f"{article(target)} {target}" if target in kinds else target
    phrase = "have feelings" if target == "feelings" else "am " + label
    if answer.budget_exhausted:
        parts = [f"The proof search for whether I {phrase} is incomplete."]
    elif answer.status == CONFLICTING:
        parts = [f"There is conflicting evidence about whether I {phrase}."]
    elif answer.status in (YES, NO):
        proofs = answer.support if answer.status == YES else answer.against
        proof = proofs[0]
        conclusion = (f"I {phrase}." if answer.status == YES else
                      "I don't have feelings." if target == "feelings" else f"I am not {label}.")
        parts = [("The applicable rules imply: " if proof.learned_rules else "The recorded account says: ") + conclusion]
    else:
        parts = [f"Whether I {phrase} is unresolved."]
    proofs = answer.support + answer.against
    for proof in proofs[:2]:
        for aid in proof.steps:
            row = c.repo.assertion(aid)
            if row is not None:
                fact = realizer.realize_assertion(c.repo, row)
                source = c.repo.source_speaker(aid)
                line = f"{source or 'The record'} reported: {fact.rstrip('.')}."
                if line not in parts:
                    parts.append(line)
        for rule_id in proof.learned_rules:
            rule = c.repo.rule(rule_id)
            conditions = [realizer.pattern_text(c.repo, pattern, "I") for pattern in rule["conditions"]]
            conclusions = [realizer.pattern_text(c.repo, pattern, "I") for pattern in rule["conclusions"]]
            parts.append("The applied rule connects " + " and ".join(conditions) + " to " + " and ".join(conclusions) + ".")
    if answer.status not in (YES, NO) or answer.budget_exhausted:
        parts.extend(check['text'] for check in state.get('definition_checks',[]))
        parts.extend(g["question"] for g in state["gaps"][:2])
        if not state["gaps"]:
            parts.append(f"I need evidence or an established rule connecting my record to {target}.")
    return _updates(c, target, parts)


def _updates(c, target, parts):
    # Subsequent delivery includes only changed findings, never repeated definitions.
    previous = getattr(c, "_self_findings", {})
    key = (c.state.speaker, target)
    current = tuple(parts)
    old = previous.get(key)
    previous[key] = current
    c._self_findings = previous
    if old is not None:
        changed = [part for part in parts if part not in old]
        if not changed and old == current:
            return f"No findings have changed for {target}."
        return " ".join(changed) or f"The earlier findings for {target} no longer have support."
    return " ".join(parts)

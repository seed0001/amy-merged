"""Resolve investigation follow-ups before generic conversation routing."""
import re
from reasoning.investigations import question_query


def objective_for(c, phrase, sessions=None):
    phrase = phrase.strip(" .!?")
    if phrase.lower() not in ("that", "it", "this", "the question", "that question", "this question"):
        return phrase, question_query(c.repo,phrase)
    previous = c.state.last_trace or {}
    heard = previous.get("heard", "")
    match = re.fullmatch(r"\W*are you (.+?)\W*",heard,re.I)
    if match:
        objective = f"Is {c.self_name} {match[1].rstrip('?.!')}?"
        return objective, question_query(c.repo,objective)
    if re.match(r"\W*is ",heard,re.I) and heard.endswith('?'):
        return heard, question_query(c.repo,heard)
    if sessions:
        prior = sessions.latest(c.state.speaker)
        if prior and prior['objective'].lower().strip(' .?!') not in ('that','it','this'):
            return prior['objective'], prior.get('query')
    controller = getattr(c,'_self_investigations',None)
    prior = controller.sessions.latest(c.state.speaker) if controller else None
    if prior:
        return prior['objective'],prior.get('query')
    return None,None


def followup(c,text):
    composition = re.fullmatch(r"\W*what (?:are you|is "+re.escape(c.self_name)+r") made (?:of|from)\W*",text,re.I)
    if composition:
        from reasoning.implementation import inspect
        observations = inspect(c)
        by_id = {item['id']:item for item in observations}
        components = by_id['components']['value']
        return ("My software components are "+", ".join(components)+". My recorded memory uses SQLite. "
                "These describe my composition; my process runs on a host, which is a separate object.",
                {'intent':'implementation-composition','implementation':observations})
    if not re.fullmatch(r"\W*what (?:are you|is "+re.escape(c.self_name)+r") missing(?: (?:now|still|for (?:that|this)))?\W*",text,re.I):
        return None
    bridge = getattr(c,'thinking',None)
    if bridge:
        result = bridge.respond(c,text)
        if result:
            return result[0],{'intent':'thinking','thinking':result[1]}
    controller = getattr(c,'_self_investigations',None)
    state = controller.sessions.latest(c.state.speaker) if controller else None
    if not state:
        return "Which question are you asking about?",{'intent':'investigation-gap'}
    gaps = state.get('gaps',[])
    return ("For “"+state['objective']+"”, "+(gaps[0]['question'] if gaps else "no unresolved evidence gap is currently recorded."),
            {'intent':'investigation-gap','investigation':state})

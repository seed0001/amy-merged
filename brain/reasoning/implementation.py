"""Read-only observations of the application; never philosophical premises."""
import os
import platform
import sys
import time


def inspect(convo):
    repo = convo.repo
    databases = [dict(name=row[1], path=row[2] or ":memory:") for row in repo.conn.execute("PRAGMA database_list")]
    observations = []
    def add(key, relation, value, source):
        observations.append(dict(id=key, subject=convo.self_name, relation=relation, value=value,
                                 source=source, status="observed", observed_at=time.time()))
    add("name", "configured_name", convo.self_name, "Conversation.self_name")
    add("process", "executes_in", {"pid":os.getpid(), "interpreter":sys.executable,
                                      "language":"Python", "version":platform.python_version()}, "os.getpid / sys.executable")
    add("host", "runs_on", {"system":platform.system(), "release":platform.release(),
                                "architecture":platform.machine()}, "platform runtime inspection")
    components = []
    for attr in ("engine", "repo", "resolver", "learner", "exposition", "recall", "drive"):
        value = getattr(convo,attr,None)
        if value is not None:
            components.append(type(value).__module__+"."+type(value).__name__)
    add("components", "implemented_using", components, "live Conversation component objects")
    add("memory", "stores_memory_in", {"engine":"SQLite", "databases":databases}, "Repository.conn / PRAGMA database_list")
    add("inputs", "accepts", ["text via Conversation.handle", "speaker label"], "Conversation.handle signature")
    actions = [label for attr,label in (("handle","process text"),("digest","read supplied text")) if callable(getattr(convo,attr,None))]
    if callable(getattr(convo.engine,"ask",None)):actions.append("query facts and rules")
    if callable(getattr(convo.recall,"answer",None)):actions.append("retrieve conversation history")
    add("actions", "can_execute", actions, "callable application methods; not a claim that an external service is connected")
    return observations


def definition_checks(state):
    """Connect a selected sense to observations without treating resemblance as identity."""
    import re
    observations = {item["id"]:item for item in state.get("implementation",[])}
    if not observations:return []
    query = state.get("query") or {}
    target = state.get("target_term")
    choices = [d for d in state.get("definitions",[]) if not target or d["term"]==target]
    if not choices:return []
    selected = choices[0]
    text = selected["definition"]
    checks = []
    for pattern, keys, connection in (
        (r"process|comput|calculat|program|instruction|data", ("process","components","actions"),
         "The running interpreter and reasoning methods support executing software instructions and processing structured input."),
        (r"stor|memory|record", ("memory",), "The repository provides SQLite storage for recorded information."),
        (r"input|output|information|data", ("inputs","actions"), "The text entry point accepts input and produces reply text."),
        (r"machine|device|electronic|hardware", ("host","process"),
         "The inspected process runs on a host machine. This is a runs-on relationship, not evidence that the process and host are the same object."),
    ):
        if re.search(pattern,text,re.I) and all(key in observations for key in keys):
            checks.append(dict(sense=selected.get("sense"), term=selected["term"], definition=text,
                               observations=list(keys), text=connection, status="supported-relationship"))
    return checks

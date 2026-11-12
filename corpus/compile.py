"""Every conversation any of the bots under C:\\Bots ever had or overheard, in one time-ordered corpus.

Owner, 2026-11-11: "include everybody, all my friends, anybody on Discord that was in there talking to them or that
they picked up on the conversation. All of the conversations that have been had should be ran through."

Read from, wherever they are found under the root (archives, wipe backups and exports included):
  - companion.db / badass.db   messages        the new champ family: Amy, James, Alex, Howard (Gramps), Nova, the badass
  - amy.db / adam.db           history         the voice bots (Amy-Voice, VoiceBot), heard-only lines included
  - amy.db / halmini.db ...    utterances      the Python bots (what people said to them)
  - .companions-conversations.db  conversation_events   every line the crew heard in a call, answered or not
  - activity.jsonl             "heard" events  lines a bot heard, including ones it ignored

The same line usually sits in several of these (a backup, an export, an activity log). A line by the same speaker
with the same words within three minutes is kept once. Nothing is opened for writing.

    python compile.py [C:\\Bots] [conversations.jsonl]
"""

import collections
import datetime
import json
import os
import shutil
import sqlite3
import sys
import tempfile

ROOT = sys.argv[1] if len(sys.argv) > 1 else r"C:\Bots"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "conversations.jsonl")
SKIP_DIRS = {"node_modules", "browser-profile", ".git", "wordnet", "amy-merged", "__pycache__", "site-packages"}
WINDOW_MS = 180_000

# Whose archive a file is, from the folder it sits in: the name its own replies were said under.
ARCHIVE_BOT = [("the crew\\new champ", "James"), ("the crew\\the badass", "the badass"), ("the crew", "James"),
               ("new champ", "Amy"), ("exports\\new-champ", "Amy"), ("Alex", "Alex"), ("Gramps", "Howard"),
               ("Nova", "Nova"), ("the badass", "the badass"), ("Amy-Voice", "Amy"), ("VoiceBot", "Adam"),
               ("HalMini", "Hal"), ("Amy - Copy", "Amy"), ("Amy", "Amy")]


def archive_of(path: str) -> tuple[str, str]:
    rel = os.path.relpath(path, ROOT)
    for prefix, bot in ARCHIVE_BOT:
        if rel.lower().startswith(prefix.lower()):
            return rel, bot
    return rel, "a bot"


def connect(path: str):
    """Read-only. A backup with a write-ahead log but no index beside it can't be opened in place: read a copy."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.execute("select count(*) from sqlite_master").fetchone()
        return conn
    except sqlite3.Error:
        tmp = tempfile.mkdtemp(prefix="corpus-")
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(path + suffix):
                shutil.copy2(path + suffix, os.path.join(tmp, "db" + suffix))
        return sqlite3.connect(os.path.join(tmp, "db"))


def to_ms(value) -> int | None:
    if isinstance(value, (int, float)):
        return int(value if value > 1e11 else value * 1000)
    try:
        text = str(value).replace("T", " ").replace("Z", "")[:19]
        return int(datetime.datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
    except (ValueError, TypeError):
        return None


rows: list[dict] = []
counts = collections.Counter()


def add(at, conversation, role, user_id, speaker, text, archive, kind, heard_only=False, peer=False):
    text = " ".join(str(text or "").split())
    at = to_ms(at)
    if not text or at is None:
        return
    rows.append({"at": at, "conversation": str(conversation or ""), "role": role, "user_id": str(user_id) if user_id else None,
                 "speaker": speaker, "text": text, "archive": archive, "kind": kind, "heard_only": bool(heard_only), "peer": bool(peer)})
    counts[kind] += 1


def read_db(path: str) -> None:
    archive, bot = archive_of(path)
    try:
        conn = connect(path)
        tables = {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}
        cols = lambda t: {r[1] for r in conn.execute(f"pragma table_info([{t}])")}
        if "messages" in tables:
            c = cols("messages")
            conv = "conversation" if "conversation" in c else "convo"
            at = "created_at" if "created_at" in c else "at"
            for conversation, role, uid, name, content, when in conn.execute(
                    f"select {conv}, role, user_id, name, content, {at} from messages"):
                if role in ("user", "assistant"):
                    add(when, conversation, role, uid, name or (bot if role == "assistant" else None), content, archive, "messages")
        if "history" in tables and {"key", "role", "text"} <= cols("history"):
            for when, key, role, name, text, heard_only in conn.execute("select at, key, role, name, text, heard_only from history"):
                if role in ("user", "assistant"):
                    add(when, key, role, None, name or (bot if role == "assistant" else None), text, archive, "history", heard_only)
        if "utterances" in tables:
            for speaker, text, when in conn.execute("select speaker, text, created_at from utterances"):
                add(when, "python-bot", "user", None, speaker, text, archive, "utterances")
        if "conversation_events" in tables:
            for conversation, speaker, when, payload in conn.execute("select conversation, speaker, at, payload from conversation_events"):
                try:
                    event = json.loads(payload)
                except ValueError:
                    continue
                add(when, conversation, "user", speaker, None, event.get("text"), archive, "call-events", peer=event.get("peer"))
    except sqlite3.Error as error:
        print(f"  could not read {archive}: {error}")


def read_activity(path: str) -> None:
    archive, _ = archive_of(path)
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"type":"heard"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            add(e.get("time"), e.get("conversation"), "user", e.get("userId"), e.get("speaker"), e.get("text"), archive,
                "heard-log", heard_only=e.get("ignored"))


for base, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.endswith("venv")]
    for name in files:
        full = os.path.join(base, name)
        if name.endswith(".db"):
            read_db(full)
        elif name == "activity.jsonl":
            read_activity(full)

# Names for lines that only carry an id (call events), from every line that carries both.
names = collections.defaultdict(collections.Counter)
for r in rows:
    if r["user_id"] and r["speaker"]:
        names[r["user_id"]][r["speaker"]] += 1
for r in rows:
    if not r["speaker"]:
        r["speaker"] = names[r["user_id"]].most_common(1)[0][0] if names.get(r["user_id"]) else f"someone ({r['user_id'] or 'unknown'})"

# Who is a bot: anyone whose words were ever a bot's own reply, or who a call marked as a peer bot.
bot_names = {r["speaker"].casefold() for r in rows if r["role"] == "assistant" and r["speaker"]}
bot_ids = {r["user_id"] for r in rows if r["peer"] and r["user_id"]}
for r in rows:
    r["is_bot"] = r["role"] == "assistant" or r["user_id"] in bot_ids or r["speaker"].casefold() in bot_names
    del r["peer"]

# One copy of each line: the same speaker, the same words, within three minutes. A line someone was answered on
# wins over the same line merely overheard.
rows.sort(key=lambda r: (r["at"], r["heard_only"]))
kept, last_seen = [], {}
for r in rows:
    key = (r["role"], r["user_id"] or r["speaker"].casefold(), r["text"].casefold())
    by_name = (r["role"], r["speaker"].casefold(), r["text"].casefold())
    previous = max(last_seen.get(key, -10**18), last_seen.get(by_name, -10**18))
    if r["at"] - previous <= WINDOW_MS:
        continue
    last_seen[key] = last_seen[by_name] = r["at"]
    kept.append(r)

with open(OUT, "w", encoding="utf-8") as f:
    for r in kept:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # names with characters the Windows console can't print
day = lambda ms: datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")
people = [r for r in kept if r["role"] == "user" and not r["is_bot"]]
print(f"found {len(rows)} lines in all sources {dict(counts)}")
print(f"kept {len(kept)} after removing repeats: {day(kept[0]['at'])} to {day(kept[-1]['at'])}")
print(f"  said by people: {len(people)}   said by other bots: {sum(1 for r in kept if r['role'] == 'user' and r['is_bot'])}"
      f"   bots' own replies (not fed): {sum(1 for r in kept if r['role'] == 'assistant')}")
print(f"  overheard only (never answered): {sum(1 for r in kept if r['heard_only'])}")
print("people, by lines:")
for name, n in collections.Counter(r["speaker"] for r in people).most_common(25):
    print(f"  {n:6d}  {name}")
print("other bots, by lines:", dict(collections.Counter(r["speaker"] for r in kept if r["role"] == "user" and r["is_bot"]).most_common(12)))
print("wrote", OUT)

"""Write a clean copy of this workspace that is safe to publish: no keys, no IDs, no private records.

Only files git tracks are copied, so nothing in data/, .env, the corpus or the models can come along. Then:

  Left out entirely
    - reports/ (transcripts and reviews of real conversations), .claude/ (machine-specific launch files),
      runtime files the running bot writes beside the workspace, large binary assets, this handoff note.
  Replaced in every text file
    - anything shaped like a key or token                      -> [REDACTED]
    - Discord IDs (17 to 20 digit numbers)                      -> a made-up number of the same length, the same
      one every time, so code and tests that compare IDs still agree with each other
    - the Windows user folder                                   -> a neutral one
    - people's Discord names                                    -> friend_1, friend_2 ... (the same one every time)
    - the Discord server's name                                 -> "the server"
  Added
    - body/.env.example: every setting in body/.env with its explanation and no value

People's names are not written in this file. They are read from the local corpus (corpus/conversations.jsonl,
which is never published): every human speaker in it is a name to replace. Names passed with --keep are left
alone (the owner's first name, which the code's comments use to say who asked for what).

Afterwards the copy is scanned, and the run fails if anything key-shaped, any real Discord ID or any replaced name
is still in it.

    python export-clean.py <output folder> [--keep Name ...] [--server "Server Name"]
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SKIP = re.compile(r"(^|/)(reports|\.claude|\.agents)/|^\.companions|^HANDOFF|^body/live-viewer/assets/|\.(zip|db|db-wal|db-shm|pem|key|pfx|p12|safetensors|gguf|onnx|npy)$", re.I)
SECRETS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:sk|sk-or|sk-proj|sk-ant|gsk|tvly|hf|gh[pousr])[-_][A-Za-z0-9_-]{16,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}"),
    re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}"),  # Discord bot token
]
DISCORD_ID = re.compile(r"(?<![\w.])\d{17,20}(?![\w.])")
USER_DIR = re.compile(r"((?:[A-Za-z]:|/c)[\\/]+Users[\\/]+)[^\\/\"'\s]+")
# Speakers that are not people's names: the dashboard, stand-ins, and the coding tool whose work-done notes arrive
# under its product name.
NOT_PEOPLE = {"owner", "dashboard", "someone", "user", "guest", "claude code"}


def fake_id(match: re.Match) -> str:
    digits = match.group(0)
    made = str(int(hashlib.sha256(digits.encode()).hexdigest(), 16))[: len(digits) - 1]
    return "9" + made  # same length, same every time, and never a real ID


def people_names(keep: set[str]) -> list[str]:
    corpus = os.path.join(ROOT, "corpus", "conversations.jsonl")
    if not os.path.exists(corpus):
        sys.exit(f"No corpus at {corpus}, so there is no list of people's names to replace. "
                 f"Fix: run corpus/compile.py first, or publish from the machine that has it.")
    names: dict[str, int] = {}
    bots = set()
    with open(corpus, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r.get("is_bot") or r.get("role") == "assistant":
                bots.add(r["speaker"].casefold())
            else:
                names[r["speaker"]] = names.get(r["speaker"], 0) + 1
    out = []
    for name in names:
        low = name.casefold()
        if low in bots or low in NOT_PEOPLE or low in keep or len(name) < 4 or name.startswith(("source:", "someone (")):
            continue
        if not re.search(r"[A-Za-z]{3}", name):
            continue
        out.append(name)
    return sorted(out, key=lambda n: (-len(n), n.casefold()))  # longest first, so a name inside a longer one is safe


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--keep", nargs="*", default=[], help="people's names to leave as they are")
    ap.add_argument("--server", action="append", default=[], help="a Discord server name to replace with 'the server'")
    ap.add_argument("--name", action="append", default=[], help="another person's name to replace (a real name that appears in a comment)")
    ap.add_argument("--owner", action="append", default=[], help="the owner's own name, replaced with 'Owner' everywhere")
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"{out} is not empty. Fix: give a new folder, so nothing old is published by accident.")
    os.makedirs(out, exist_ok=True)

    names = people_names({k.casefold() for k in [*args.keep, *args.owner]})
    names = sorted({*names, *(n for n in args.name if n.strip())}, key=lambda n: (-len(n), n.casefold()))
    alias = {name.casefold(): f"friend_{i + 1}" for i, name in enumerate(sorted(names, key=str.casefold))}
    name_re = re.compile(r"(?<![A-Za-z0-9_])(" + "|".join(re.escape(n) for n in names) + r")(?![A-Za-z0-9_])", re.I) if names else None
    server_re = [re.compile(re.escape(s), re.I) for s in args.server]
    # Underscores don't shield it: a name inside an identifier (spot_name) is replaced too, the same way everywhere.
    owner_re = re.compile(r"(?<![A-Za-z0-9])(" + "|".join(re.escape(o) for o in args.owner) + r")(?![A-Za-z0-9])") if args.owner else None
    owner_low_re = re.compile(r"(?<![A-Za-z0-9])(" + "|".join(re.escape(o.lower()) for o in args.owner) + r")(?![A-Za-z0-9])") if args.owner else None

    counts = {"files": 0, "left out": 0, "keys": 0, "ids": 0, "user folders": 0, "names": 0, "server": 0, "owner": 0}

    def scrub(text: str) -> str:
        for pattern in SECRETS:
            text, n = pattern.subn("[REDACTED]", text); counts["keys"] += n
        text, n = DISCORD_ID.subn(fake_id, text); counts["ids"] += n
        text, n = USER_DIR.subn(lambda m: m.group(1) + "user", text); counts["user folders"] += n
        if name_re:
            text, n = name_re.subn(lambda m: alias[m.group(1).casefold()], text); counts["names"] += n
        for pattern in server_re:
            text, n = pattern.subn("the server", text); counts["server"] += n
        if owner_re:  # "Name" -> "Owner", and the all-lower-case form (in ids, keys and wake words) -> "owner"
            text, n = owner_re.subn("Owner", text); counts["owner"] += n
            text, n = owner_low_re.subn("owner", text); counts["owner"] += n
        return text

    tracked = subprocess.run(["git", "-C", ROOT, "ls-files"], capture_output=True, text=True, check=True).stdout.split("\n")
    for rel in filter(None, tracked):
        src = os.path.join(ROOT, rel)
        if SKIP.search(rel) or not os.path.isfile(src):
            counts["left out"] += 1
            continue
        dst = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        data = open(src, "rb").read()
        if b"\0" in data[:8000]:
            shutil.copyfile(src, dst)
        else:
            with open(dst, "w", encoding="utf-8", newline="") as f:
                f.write(scrub(data.decode("utf-8", "replace")))
        counts["files"] += 1

    # The settings file, with every explanation and no values.
    env = os.path.join(ROOT, "body", ".env")
    if os.path.exists(env):
        lines = []
        for line in open(env, encoding="utf-8", errors="replace").read().splitlines():
            m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
            lines.append(f"{m.group(1)}=" if m else line)
        with open(os.path.join(out, "body", ".env.example"), "w", encoding="utf-8", newline="\n") as f:
            f.write(scrub("\n".join(lines)) + "\n")
        counts["files"] += 1

    # Check the copy: nothing key-shaped, no ID that was in the original, no name that should be gone.
    real_ids = set()
    for rel in filter(None, tracked):
        src = os.path.join(ROOT, rel)
        if os.path.isfile(src):
            data = open(src, "rb").read()
            if b"\0" not in data[:8000]:
                real_ids.update(DISCORD_ID.findall(data.decode("utf-8", "replace")))
    problems = []
    for base, _, files in os.walk(out):
        for name in files:
            path = os.path.join(base, name)
            data = open(path, "rb").read()
            if b"\0" in data[:8000]:
                continue
            text = data.decode("utf-8", "replace")
            rel = os.path.relpath(path, out)
            if any(p.search(text) for p in SECRETS):
                problems.append(f"{rel}: something key-shaped")
            if real_ids & set(DISCORD_ID.findall(text)):
                problems.append(f"{rel}: a real Discord ID")
            if name_re and name_re.search(text):
                problems.append(f"{rel}: a person's name")
            if owner_re and (owner_re.search(text) or re.search("|".join(re.escape(o) for o in args.owner), text, re.I)):
                problems.append(f"{rel}: the owner's name")
            if re.search(r"Users[\\/]+(?!user\b)[A-Za-z0-9_.-]+[\\/]", text) and "Users/<" not in text:
                found = re.search(r"Users[\\/]+(?!user\b)([A-Za-z0-9_.-]+)", text).group(1)
                if found.lower() not in ("public", "default", "you", "name", "me"):
                    problems.append(f"{rel}: a user folder ({found})")
    print(json.dumps(counts))
    print(f"{len(names)} people's names replaced with friend_N")
    if problems:
        print("NOT CLEAN:")
        for p in problems[:30]:
            print("  ", p)
        sys.exit(1)
    print("clean:", out)


if __name__ == "__main__":
    main()

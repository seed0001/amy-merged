"""What Amy reads and keeps on her own: news feeds, web lookups, her journal, and her projects.

Ported from the voice bot (src/news.js, src/web.js, src/journal.js, the projects in src/tools.js).
Standard library only, no API keys, no language model. What she reads is also taught to her engine
(see interfaces/life_actor.py), the same way she learns from people: through her own parser.
"""

from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"


def _decode(text: str) -> str:
    text = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", str(text or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _get(url: str, data: bytes | None = None, timeout: float = 15.0, headers: dict | None = None) -> str:
    request = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https endpoints
        return response.read().decode("utf-8", errors="replace")


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


# ---- news ----------------------------------------------------------------------------------------

def parse_feed(xml: str) -> list[dict]:
    """RSS 2.0 and Atom, no dependencies."""
    blocks = re.findall(r"<item[\s>][\s\S]*?</item>", xml, re.I) or re.findall(r"<entry[\s>][\s\S]*?</entry>", xml, re.I)

    def tag(block, name):
        m = re.search(rf"<{name}(?:\s[^>]*)?>([\s\S]*?)</{name}>", block, re.I)
        return m.group(1) if m else None

    items = []
    for block in blocks:
        link = _decode(tag(block, "link") or "")
        if not link:
            m = re.search(r'<link[^>]*href="([^"]+)"', block, re.I)
            link = m.group(1) if m else _decode(tag(block, "guid") or "")
        title = _decode(tag(block, "title") or "")
        summary = _decode(tag(block, "description") or tag(block, "summary") or tag(block, "content") or "")
        summary = re.sub(r"^Article URL:.*$", "", summary, flags=re.S)[:300]
        if title and link:
            items.append({"title": title, "summary": summary, "link": link})
    return items


class News:
    KEEP_DAYS = 4
    PER_FEED = 3

    def __init__(self, feeds_file: Path = ROOT / "feeds.json", store: Path = DATA / "news.json"):
        self.feeds_file = Path(feeds_file)
        self.path = Path(store)
        self.store = _read_json(self.path, {"items": [], "read": []})
        self.store.setdefault("items", [])
        self.store.setdefault("read", [])

    def feeds(self) -> list[dict]:
        feeds = _read_json(self.feeds_file, [])
        return [f for f in feeds if isinstance(f, dict) and f.get("url")]

    def refresh(self, fetch=_get) -> list[dict]:
        """Fetch every feed; returns the stories she actually read this time (newest few per feed)."""
        known = {i["link"] for i in self.store["items"]}
        fresh, read = [], []
        now = time.time()
        for feed in self.feeds():
            try:
                items = [i for i in parse_feed(fetch(feed["url"])) if i["link"] not in known]
            except Exception:  # noqa: BLE001 - one dead feed must not stop the rest
                continue
            for item in items:
                item.update(feed=feed.get("name", ""), category=feed.get("category", "news"), at=now)
            fresh += items
            read += items[: self.PER_FEED]
        cutoff = now - self.KEEP_DAYS * 86400
        self.store["items"] = [i for i in fresh + self.store["items"] if i.get("at", now) >= cutoff][:800]
        self.store["read"] = (self.store["read"] + read)[-30:]
        self.store["last_refresh"] = now
        _write_json(self.path, self.store)
        return read

    def recent_reads(self, n: int = 4) -> list[dict]:
        return list(reversed(self.store["read"][-12:]))[:n]


# ---- the web -------------------------------------------------------------------------------------

class Web:
    def __init__(self, store: Path = DATA / "searches.json"):
        self.path = Path(store)
        self.searches = _read_json(self.path, [])

    def search(self, query: str, max_results: int = 5, fetch=_get) -> list[dict]:
        page = fetch("https://lite.duckduckgo.com/lite/", data=urllib.parse.urlencode({"q": query}).encode(),
                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        links = re.findall(r"<a[^>]*href=\"([^\"]+)\"[^>]*class='result-link'>([\s\S]*?)</a>", page)
        snippets = re.findall(r"<td class='result-snippet'>([\s\S]*?)</td>", page)
        return [{"url": url, "title": _decode(title), "snippet": _decode(snippets[i]) if i < len(snippets) else ""}
                for i, (url, title) in enumerate(links[:max_results])]

    def wikipedia(self, subject: str, fetch=_get) -> dict | None:
        found = json.loads(fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch="
                                 + urllib.parse.quote(subject), headers={"User-Agent": "AmyCompanion/1.0"}))
        hits = found.get("query", {}).get("search", [])
        if not hits:
            return None
        title = hits[0]["title"]
        page = json.loads(fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title),
                                headers={"User-Agent": "AmyCompanion/1.0"}))
        return {"title": title, "summary": page.get("extract", "")} if page.get("extract") else None

    def research(self, query: str, why: str = "curious", fetch=_get) -> str:
        """Look it up and keep a record; returns the plain finding ('' when nothing came up)."""
        wiki = None
        results: list[dict] = []
        try:
            wiki = self.wikipedia(query, fetch=fetch)
        except Exception:  # noqa: BLE001
            wiki = None
        if not wiki:
            try:
                results = self.search(query, fetch=fetch)
            except Exception:  # noqa: BLE001
                results = []
        finding = wiki["summary"] if wiki else " ".join(r["snippet"] for r in results[:2] if r["snippet"])
        finding = re.sub(r"\s+", " ", finding).strip()[:1200]
        if finding:
            self.searches.append({"query": query, "finding": finding, "why": why, "at": time.time(),
                                  "source": f"Wikipedia: {wiki['title']}" if wiki else "web"})
            self.searches = self.searches[-60:]
            _write_json(self.path, self.searches)
        return finding

    def recent(self, n: int = 5) -> list[dict]:
        return list(reversed(self.searches[-n:]))


# ---- journal -------------------------------------------------------------------------------------

class Journal:
    def __init__(self, path: Path = DATA / "journal.md"):
        self.path = Path(path)

    def write(self, text: str, label: str | None = None) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        when = datetime.now().strftime("%A, %B %d, %I:%M %p")
        heading = f"{when}{f' ({label})' if label else ''}"
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(f"\n## {heading}\n\n{text.strip()}\n")

    def entries(self) -> list[dict]:
        if not self.path.exists():
            return []
        blocks = self.path.read_text(encoding="utf-8").split("\n## ")[1:]
        out = []
        for block in blocks:
            when, _, text = block.partition("\n")
            out.append({"when": when.strip(), "text": text.strip()})
        return out

    def latest(self) -> str:
        entries = self.entries()
        return entries[-1]["text"] if entries else ""


# ---- projects ------------------------------------------------------------------------------------

class Projects:
    """Things she's learning about over days. Kept in self_state under `projects`."""

    KEY = "projects"

    def __init__(self, repo):
        self.repo = repo

    def all(self) -> list[dict]:
        row = self.repo.conn.execute("SELECT value FROM self_state WHERE key = ?", (self.KEY,)).fetchone()
        try:
            return json.loads(row[0]) if row else []
        except ValueError:
            return []

    def _save(self, projects: list[dict]) -> None:
        with self.repo.conn:
            self.repo.conn.execute(
                "INSERT INTO self_state(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
                (self.KEY, json.dumps(projects)))

    def active(self) -> list[dict]:
        return [p for p in self.all() if p.get("status") == "active"]

    def start(self, title: str, goal: str) -> dict:
        projects = self.all()
        for p in projects:
            if p["title"].lower() == title.lower():
                return p
        project = {"title": title, "goal": goal, "status": "active", "notes": [], "created": time.time(),
                   "updated": time.time()}
        projects.append(project)
        self._save(projects)
        return project

    def note(self, title: str, note: str, done: bool = False) -> None:
        projects = self.all()
        for p in projects:
            if p["title"] == title:
                p["notes"] = (p["notes"] + [{"at": time.time(), "note": note}])[-40:]
                p["updated"] = time.time()
                if done:
                    p["status"] = "done"
        self._save(projects)


class Reading:
    """Everything she reads and keeps, in one place."""

    def __init__(self, repo):
        self.news = News()
        self.web = Web()
        self.journal = Journal()
        self.projects = Projects(repo)

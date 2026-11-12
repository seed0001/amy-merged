import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    db_path: str
    max_depth: int
    inference_budget: int


_FROM_FILE: dict[str, str] = {}  # keys this process took from .env, so a reload can update or drop them


def load_dotenv(path: str | Path = ".env") -> set[str]:
    """Minimal .env reader (KEY=VALUE lines); real environment variables win. Called again, it applies
    edits to the file (a cleared key goes back to its default) and returns the keys that changed."""
    file = Path(path)
    found: dict[str, str] = {}
    if file.exists():
        for line in file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            found[key.strip()] = value.strip().strip('"').strip("'")
    changed = set()
    for key, value in found.items():
        if key in _FROM_FILE or key not in os.environ:
            if os.environ.get(key) != value:
                changed.add(key)
            os.environ[key] = value
            _FROM_FILE[key] = value
    for key in set(_FROM_FILE) - set(found):
        os.environ.pop(key, None)
        del _FROM_FILE[key]
        changed.add(key)
    return changed


def load_config() -> Config:
    db_path = os.environ.get("HALMINI_DB", "data/halmini.db")
    if db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    return Config(
        db_path=db_path,
        max_depth=int(os.environ.get("HALMINI_MAX_DEPTH", "16")),
        inference_budget=int(os.environ.get("HALMINI_INFERENCE_BUDGET", "5000")),
    )

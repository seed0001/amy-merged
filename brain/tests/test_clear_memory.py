import sqlite3
from pathlib import Path

from app.conversation import Conversation
from db.repository import Repository
from interfaces import dashboard


def test_clear_memory_wipes_learning_backs_up_and_starts_fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(dashboard, "ROOT", tmp_path)
    db = tmp_path / "amy.db"
    repo = Repository(str(db))
    c = Conversation(repo, self_name="Adam")
    c.handle("Jen lives in Denver.", speaker="Owner")
    c.handle("Rex is a dog.", speaker="Owner")
    generation = repo.memory_id
    repo.close()
    sqlite3.connect(tmp_path / "amy.thoughts.db").execute("CREATE TABLE thought_meta(key TEXT, value TEXT)").connection.commit()

    out = dashboard.clear_memory(str(db))

    assert out["ok"] and out["rows_removed"] > 0 and len(out["backups"]) == 2
    old = sqlite3.connect(tmp_path / out["backups"][0])
    assert old.execute("SELECT COUNT(*) FROM assertions").fetchone()[0] > 0  # undoable
    repo = Repository(str(db))
    try:
        assert repo.all_assertions() == [] and repo.turns() == []
        assert repo.memory_id != generation
        assert repo.conn.execute("SELECT COUNT(*) FROM rules").fetchone()[0] > 0  # built-in logic stays
        c = Conversation(repo, self_name="Adam")
        assert "Denver" not in c.handle("Where does Jen live?", speaker="Owner").text
    finally:
        repo.close()

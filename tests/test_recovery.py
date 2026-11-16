from __future__ import annotations

import sqlite3

import pytest

from serverhub.cli import main
from serverhub.db import Database, repo
from tests.conftest import SECRET


def test_cli_round_trip_restores_a_live_snapshot_after_clean_shutdown(tmp_path, monkeypatch):
    monkeypatch.setenv("SERVERHUB_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SERVERHUB_SECRET_KEY", SECRET)
    live = tmp_path / "serverhub.db"
    snapshot = tmp_path / "snapshot with spaces.db"
    db = Database(live)
    try:
        db.call(repo.create_user, "old@example.org", "kept", "test-hash", "admin")
        assert main(["backup", str(snapshot)]) == 0
        assert main(["verify-backup", str(snapshot)]) == 0
        db.call(repo.create_user, "new@example.org", "later", "test-hash", "user")
        with pytest.raises(SystemExit, match="Stop the server cleanly"):
            main(["restore", str(snapshot)])
    finally:
        db.close()

    assert main(["restore", str(snapshot)]) == 0
    restored = Database(live)
    try:
        assert [user["username"] for user in restored.call(repo.list_users)] == ["kept"]
    finally:
        restored.close()


def test_failed_restore_preserves_the_current_database(tmp_path, monkeypatch):
    monkeypatch.setenv("SERVERHUB_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SERVERHUB_SECRET_KEY", SECRET)
    live = tmp_path / "serverhub.db"
    db = Database(live)
    db.close()
    before = live.read_bytes()
    bad = tmp_path / "invalid.db"
    bad.write_text("not a database")
    with pytest.raises(SystemExit, match="Restore failed"):
        main(["restore", str(bad)])
    assert live.read_bytes() == before

    with sqlite3.connect(bad := tmp_path / "unrelated.db") as conn:
        conn.execute("CREATE TABLE unrelated (id INTEGER)")
    conn.close()
    with pytest.raises(SystemExit, match="not a Server Hub backup"):
        main(["verify-backup", str(bad)])

from __future__ import annotations

import os
import sqlite3
from contextlib import closing

import pytest

from serverhub.cli import main
from serverhub.db import Database, backup_to, monitor_webhooks, monitoring, repo, restore_backup
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


def test_restore_keeps_history_and_does_not_replay_queued_webhooks(tmp_path):
    live = tmp_path / "serverhub.db"
    snapshot = tmp_path / "monitoring.db"
    with closing(Database(live)) as db:
        user = db.call(repo.create_user, "admin@example.test", "admin", "hash", "admin")
        service = db.call(
            repo.insert_owned,
            "services",
            user["id"],
            {"name": "Service", "url": "https://service.example", "icon": "box"},
            10,
        )
        db.call(monitoring.set_global_enabled, True)
        db.call(monitoring.set_service_enabled, user["id"], service["id"], True, 60)
        db.call(monitor_webhooks.configure, "encrypted-destination")
        epoch, targets = db.call(monitoring.due_targets, 60)
        for slot, state in [(60, "down"), (120, "down"), (180, "down"), (240, "up")]:
            db.call(
                monitoring.record_result,
                epoch,
                targets[0],
                slot,
                {
                    "state": state,
                    "checked_at": None,
                    "http_status": None,
                    "latency_ms": None,
                },
            )
        (down_id,) = db.call(monitor_webhooks.due_ids, 240)
        attempt = db.call(monitor_webhooks.claim, down_id, 240)
        assert attempt is not None
        db.call(monitor_webhooks.finish, attempt, 240, None)
        backup_to(live, snapshot)

    assert restore_backup(snapshot, live) == 3
    with closing(Database(live)) as restored:
        assert restored.call(monitor_webhooks.due_ids, 245) == []
        assert restored.call(monitor_webhooks.read_config)["last_delivery"]["status"] == "delivered"
        assert (
            restored.call(lambda c: c.execute("SELECT count(*) FROM monitor_samples").fetchone()[0])
            == 4
        )
    with closing(sqlite3.connect(snapshot)) as original:
        assert original.execute(
            "SELECT status FROM monitor_deliveries WHERE kind = 'recovered'"
        ).fetchone() == ("pending",)


@pytest.mark.parametrize(
    "alteration", ["DROP TABLE sessions", "ALTER TABLE services DROP COLUMN icon"]
)
def test_incomplete_snapshot_is_rejected_before_replacing_live_db(
    tmp_path, monkeypatch, alteration
):
    monkeypatch.setenv("SERVERHUB_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SERVERHUB_SECRET_KEY", SECRET)
    live = tmp_path / "serverhub.db"
    snapshot = tmp_path / "incomplete.db"
    Database(live).close()
    before = live.read_bytes()
    assert main(["backup", str(snapshot)]) == 0
    with closing(sqlite3.connect(snapshot)) as conn:
        conn.execute(alteration)
    with pytest.raises(SystemExit, match="incomplete schema"):
        main(["verify-backup", str(snapshot)])
    with pytest.raises(SystemExit, match="incomplete schema"):
        main(["restore", str(snapshot)])
    assert live.read_bytes() == before


def test_forced_backup_rejects_a_hard_link_to_the_live_database(tmp_path, monkeypatch):
    monkeypatch.setenv("SERVERHUB_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SERVERHUB_SECRET_KEY", SECRET)
    live = tmp_path / "serverhub.db"
    Database(live).close()
    alias = tmp_path / "alias.db"
    os.link(live, alias)

    def fail_if_opened(*args, **kwargs):
        pytest.fail("Backup must reject the destination before opening either connection")

    monkeypatch.setattr(sqlite3, "connect", fail_if_opened)
    with pytest.raises(SystemExit, match="separate from the live database"):
        main(["backup", str(alias), "--force"])

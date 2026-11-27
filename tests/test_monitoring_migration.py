from __future__ import annotations

from contextlib import closing

import pytest

from serverhub import db
from serverhub.db import Database, repo, transaction

SERVICE = {"name": "Kept service", "url": "https://service.example", "icon": "box"}


def seed_legacy_rows(conn):
    user = repo.create_user(conn, "kept@example.org", "kept", "password-hash", "admin")
    uid = user["id"]
    repo.set_totp_pending(conn, uid, "encrypted-secret", 120)
    assert repo.enable_totp(conn, uid, "encrypted-secret", 100, ["recovery-code-hash"])
    repo.put_settings(conn, uid, {"title": "Kept dashboard"})
    repo.put_layout(conn, uid, {"tiles": [{"id": "bookmarks", "size": "small"}]})
    repo.insert_owned(
        conn,
        "bookmarks",
        uid,
        {"name": "Kept bookmark", "url": "https://bookmarks.example", "color": "#fafafa"},
        10,
    )
    return uid, repo.insert_owned(conn, "services", uid, SERVICE, 10)["id"]


def legacy_rows(conn):
    return (
        conn.execute("SELECT * FROM users").fetchall(),
        conn.execute("SELECT * FROM recovery_codes").fetchall(),
        conn.execute("SELECT * FROM user_settings").fetchall(),
        conn.execute("SELECT * FROM user_layouts").fetchall(),
        conn.execute("SELECT * FROM services").fetchall(),
        conn.execute("SELECT * FROM bookmarks").fetchall(),
    )


def test_upgrade_v22_and_restore_preupgrade_snapshot(tmp_path, monkeypatch):
    live = tmp_path / "serverhub.db"
    snapshot = tmp_path / "before-upgrade.db"
    migrations = db._migrations()
    with monkeypatch.context() as old_build:
        old_build.setattr(db, "_migrations", lambda: migrations[:2])
        with closing(Database(live)) as legacy:
            legacy.call(seed_legacy_rows)
            before = legacy.call(legacy_rows)
            db.backup_to(live, snapshot)
        assert db.verify_backup(snapshot) == 2

    with closing(Database(live)) as upgraded:
        assert upgraded.call(legacy_rows) == before
        with closing(db.connect(live)) as conn:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == len(migrations)
            assert conn.execute("SELECT COUNT(*) FROM service_monitors").fetchone()[0] == 0
            assert conn.execute("PRAGMA foreign_key_check").fetchall() == []

    with monkeypatch.context() as old_build:
        old_build.setattr(db, "_migrations", lambda: migrations[:2])
        with closing(db.connect(live)) as conn, pytest.raises(RuntimeError, match="newer than"):
            db.migrate(conn)

    assert db.restore_backup(snapshot, live) == 2
    monkeypatch.setattr(db, "_migrations", lambda: migrations[:2])
    with closing(Database(live)) as rolled_back:
        assert rolled_back.call(legacy_rows) == before


def seed_monitor(conn, service_id):
    conn.execute(
        "INSERT INTO service_monitors"
        " (service_id, enabled, generation, started_at, last_slot, down_streak, first_down_at)"
        " VALUES (?, 1, 'original-generation', 60, 180, 3, 60)",
        (service_id,),
    )
    conn.execute(
        "INSERT INTO monitor_samples (service_id, slot, state) VALUES (?, 180, 'down')",
        (service_id,),
    )
    conn.execute(
        "INSERT INTO monitor_incidents (id, service_id, started_at) VALUES ('open', ?, 60)",
        (service_id,),
    )
    conn.execute(
        "INSERT INTO monitor_incidents (id, service_id, started_at, ended_at, end_reason)"
        " VALUES ('closed', ?, 0, 50, 'recovered')",
        (service_id,),
    )
    conn.executemany(
        "INSERT INTO monitor_deliveries"
        " (id, service_id, incident_id, webhook_revision, kind, occurred_at, next_attempt, status)"
        " VALUES (?, ?, ?, 'webhook', 'down', 60, 60, ?)",
        [("queued", service_id, "open", "pending"), ("sent", service_id, "closed", "delivered")],
    )


@pytest.fixture
def monitored_service(tmp_path):
    with closing(db.connect(tmp_path / "serverhub.db")) as conn:
        db.migrate(conn)
        uid, sid = seed_legacy_rows(conn)
        seed_monitor(conn, sid)
        yield conn, uid, sid


def test_service_check_change_pauses_monitor_and_keeps_history(monitored_service):
    conn, uid, sid = monitored_service
    repo.update_owned(conn, "services", uid, sid, {"url": SERVICE["url"], "check_enabled": 1})
    original = conn.execute("SELECT * FROM service_monitors").fetchone()
    assert (original["enabled"], original["generation"]) == (1, "original-generation")

    with transaction(conn):
        repo.merge_owned(conn, "services", uid, [], [(sid, {"check_enabled": 0})])
    monitor = conn.execute("SELECT * FROM service_monitors").fetchone()
    assert monitor["enabled"] == 0
    assert monitor["generation"] != original["generation"]
    assert monitor["down_streak"] == 0
    assert monitor["first_down_at"] is None
    incident = conn.execute("SELECT * FROM monitor_incidents WHERE id = 'open'").fetchone()
    assert incident["ended_at"] >= incident["started_at"]
    assert incident["end_reason"] == "paused"
    assert conn.execute("SELECT state FROM monitor_samples").fetchone()[0] == "down"
    assert [row[0] for row in conn.execute("SELECT id FROM monitor_deliveries")] == ["sent"]

    repo.update_owned(conn, "services", uid, sid, {"check_enabled": 1})
    resumed = conn.execute("SELECT * FROM service_monitors").fetchone()
    assert resumed["enabled"] == 0
    assert resumed["generation"] != monitor["generation"]


@pytest.mark.parametrize("change", ["address", "remove", "replace"])
def test_service_target_replacement_removes_monitor_and_children(monitored_service, change):
    conn, uid, sid = monitored_service
    if change == "address":
        repo.update_owned(conn, "services", uid, sid, {"url": "https://new.example"})
    elif change == "remove":
        repo.delete_owned(conn, "services", uid, sid)
    else:
        repo.replace_user_data(conn, uid, {}, [SERVICE], [])
        assert repo.list_owned(conn, "services", uid)[0]["id"] != sid

    assert conn.execute("SELECT * FROM service_monitors").fetchall() == []
    assert conn.execute("SELECT * FROM monitor_samples").fetchall() == []
    assert conn.execute("SELECT * FROM monitor_incidents").fetchall() == []
    assert conn.execute("SELECT * FROM monitor_deliveries").fetchall() == []

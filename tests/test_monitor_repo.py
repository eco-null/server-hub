from contextlib import closing

import pytest

from serverhub.db import Database, monitoring, repo
from serverhub.integrations.status import unknown

SLOT = 1_800_000_000
UP = {"state": "up", "checked_at": "2027-01-15T08:00:00Z", "http_status": 200, "latency_ms": 9}
DOWN = {**UP, "state": "down", "http_status": 503}


@pytest.fixture
def db(tmp_path):
    with closing(Database(tmp_path / "serverhub.db")) as database:
        yield database.call


def make_user(db, name):
    return db(repo.create_user, f"{name}@example.org", name, "test-hash", "user")["id"]


def make_service(db, owner, index=0, *, checks=True):
    return db(
        repo.insert_owned,
        "services",
        owner,
        {
            "name": f"Service {index}",
            "url": f"https://service-{index}.example.org/",
            "icon": "box",
            "check_enabled": int(checks),
        },
        100,
    )


def enable_target(db):
    owner = make_user(db, "owner")
    service = make_service(db, owner)
    assert db(monitoring.set_global_enabled, True) is True
    assert db(monitoring.set_service_enabled, owner, service["id"], True, SLOT) is True
    epoch, targets = db(monitoring.due_targets, SLOT)
    assert epoch is not None
    assert len(targets) == 1
    target = targets[0]
    assert (target.service_id, target.user_id, target.url) == (
        service["id"],
        owner,
        service["url"],
    )
    return epoch, target


def rows(db, query, params=()):
    return db(lambda conn: [tuple(row) for row in conn.execute(query, params)])


def test_minute_slot_floors_to_utc_minute():
    assert monitoring.minute_slot(SLOT) == SLOT
    assert monitoring.minute_slot(SLOT + 59) == SLOT
    assert monitoring.minute_slot(SLOT + 60) == SLOT + 60


def test_monitoring_default_off_and_owned_service_with_checks_only(db):
    owner = make_user(db, "owner")
    other = make_user(db, "other")
    service = make_service(db, owner)
    unchecked = make_service(db, owner, 1, checks=False)
    assert db(monitoring.global_enabled) is False
    assert db(monitoring.due_targets, SLOT) == (None, [])
    with pytest.raises(ValueError, match=r"^monitoring_disabled$"):
        db(monitoring.set_service_enabled, owner, service["id"], True, SLOT)
    assert db(monitoring.set_service_enabled, owner, service["id"], False, SLOT) is False

    assert db(monitoring.set_global_enabled, True) is True
    assert db(monitoring.global_enabled) is True
    assert db(monitoring.set_service_enabled, other, service["id"], True, SLOT) is None
    assert db(monitoring.set_service_enabled, owner, "missing", True, SLOT) is None
    with pytest.raises(ValueError, match=r"^checks_disabled$"):
        db(monitoring.set_service_enabled, owner, unchecked["id"], True, SLOT)

    assert db(monitoring.set_service_enabled, owner, service["id"], True, SLOT) is True
    assert db(monitoring.latest_statuses, owner, SLOT) == {service["id"]: unknown()}
    assert db(monitoring.latest_statuses, other, SLOT) == {}


def test_per_owner_and_installation_quotas_release_paused_slots(db):
    assert (monitoring.MAX_USER_MONITORS, monitoring.MAX_MONITORS) == (10, 50)
    db(monitoring.set_global_enabled, True)
    enabled = []
    owner_count = monitoring.MAX_MONITORS // monitoring.MAX_USER_MONITORS
    for i in range(owner_count):
        owner = make_user(db, f"owner-{i}")
        for j in range(monitoring.MAX_USER_MONITORS):
            service = make_service(db, owner, j)
            assert db(monitoring.set_service_enabled, owner, service["id"], True, SLOT) is True
            enabled.append((owner, service["id"]))
        if i == 0:
            extra = make_service(db, owner, monitoring.MAX_USER_MONITORS)
            with pytest.raises(ValueError, match=r"^owner_limit$"):
                db(monitoring.set_service_enabled, owner, extra["id"], True, SLOT)

    extra_owner = make_user(db, "extra-owner")
    extra = make_service(db, extra_owner)
    with pytest.raises(ValueError, match=r"^monitor_limit$"):
        db(monitoring.set_service_enabled, extra_owner, extra["id"], True, SLOT)

    owner, service_id = enabled[0]
    assert db(monitoring.set_service_enabled, owner, service_id, True, SLOT) is True
    assert db(monitoring.set_service_enabled, owner, service_id, False, SLOT) is False
    assert db(monitoring.set_service_enabled, extra_owner, extra["id"], True, SLOT) is True


@pytest.mark.parametrize("change", ["checks", "url", "global"])
def test_inflight_result_cannot_cross_monitor_generation_or_global_epoch(db, change):
    epoch, target = enable_target(db)
    sid, owner = target.service_id, target.user_id
    if change == "checks":
        db(repo.update_owned, "services", owner, sid, {"check_enabled": 0})
        db(repo.update_owned, "services", owner, sid, {"check_enabled": 1})
    elif change == "url":
        db(repo.update_owned, "services", owner, sid, {"url": "https://new.example.org"})
        db(repo.update_owned, "services", owner, sid, {"url": target.url})
    else:
        assert db(monitoring.set_global_enabled, False) is False
        assert db(monitoring.latest_statuses, owner, SLOT) == {}
        assert db(monitoring.record_result, epoch, target, SLOT, DOWN) is False
        assert db(monitoring.set_global_enabled, True) is True

    assert db(monitoring.set_service_enabled, owner, sid, True, SLOT) is True
    assert db(monitoring.record_result, epoch, target, SLOT, DOWN) is False
    assert rows(db, "SELECT slot FROM monitor_samples") == []
    next_epoch, targets = db(monitoring.due_targets, SLOT)
    assert next_epoch is not None and len(targets) == 1
    if change == "global":
        assert next_epoch != epoch
    else:
        assert targets[0].generation != target.generation
    assert db(monitoring.record_result, next_epoch, targets[0], SLOT, UP) is True
    assert db(monitoring.latest_statuses, owner, SLOT) == {sid: UP}


def test_duplicate_and_out_of_order_slots_do_not_replace_history(db):
    epoch, target = enable_target(db)
    slot = SLOT + 60
    assert db(monitoring.record_result, epoch, target, slot, UP) is True
    assert db(monitoring.record_result, epoch, target, slot, DOWN) is False
    assert db(monitoring.record_result, epoch, target, SLOT, DOWN) is False
    assert rows(db, "SELECT slot, state FROM monitor_samples") == [(slot, "up")]
    assert rows(db, "SELECT id FROM monitor_incidents") == []
    assert db(monitoring.latest_statuses, target.user_id, slot) == {target.service_id: UP}


def test_latest_status_expires_but_service_remains_monitored(db):
    epoch, target = enable_target(db)
    assert db(monitoring.due_targets, SLOT - 60)[1] == []
    assert db(monitoring.record_result, epoch, target, SLOT, UP) is True
    assert db(monitoring.due_targets, SLOT)[1] == []
    assert db(monitoring.due_targets, SLOT + 60)[1] == [target]
    assert db(monitoring.latest_statuses, target.user_id, SLOT + 60) == {target.service_id: UP}
    assert db(monitoring.latest_statuses, target.user_id, SLOT + 120) == {
        target.service_id: unknown(),
    }


def test_incident_ignores_unknown_and_requires_contiguous_failures(db):
    epoch, target = enable_target(db)

    for offset, result in [(0, DOWN), (60, unknown()), (120, DOWN), (240, DOWN), (300, DOWN)]:
        assert db(monitoring.record_result, epoch, target, SLOT + offset, result) is True
    assert rows(db, "SELECT started_at FROM monitor_incidents") == []

    assert db(monitoring.record_result, epoch, target, SLOT + 360, DOWN) is True
    assert db(monitoring.record_result, epoch, target, SLOT + 420, unknown()) is True
    assert db(monitoring.record_result, epoch, target, SLOT + 540, DOWN) is True
    assert rows(db, "SELECT started_at, ended_at FROM monitor_incidents") == [(SLOT + 240, None)]

    assert db(monitoring.record_result, epoch, target, SLOT + 600, UP) is True
    assert db(monitoring.record_result, epoch, target, SLOT + 660, UP) is True
    assert rows(db, "SELECT started_at, ended_at, end_reason FROM monitor_incidents") == [
        (SLOT + 240, SLOT + 600, "recovered"),
    ]


@pytest.mark.parametrize("turn_global_off", [False, True])
def test_service_pause_preserves_measurements_and_closes_incident(db, turn_global_off):
    epoch, target = enable_target(db)
    for offset in (0, 60, 120):
        assert db(monitoring.record_result, epoch, target, SLOT + offset, DOWN) is True

    sid, owner = target.service_id, target.user_id
    if turn_global_off:
        db(monitoring.set_global_enabled, False)
    assert db(monitoring.set_service_enabled, owner, sid, False, SLOT + 140) is False
    if turn_global_off:
        db(monitoring.set_global_enabled, True)
    assert db(monitoring.due_targets, SLOT + 180)[1] == []
    assert db(monitoring.latest_statuses, owner, SLOT + 180) == {}
    assert db(monitoring.record_result, epoch, target, SLOT + 180, UP) is False
    assert rows(db, "SELECT COUNT(*) FROM monitor_samples") == [(3,)]
    assert rows(db, "SELECT started_at, end_reason FROM monitor_incidents") == [(SLOT, "paused")]


def test_retention_cutoff_keeps_open_and_recent_incidents_and_cascades_old_delivery(db):
    _, target = enable_target(db)
    sid = target.service_id
    cutoff = SLOT + monitoring.RETENTION_SECONDS

    def seed_history(conn):
        conn.executemany(
            "INSERT INTO monitor_samples (service_id, slot, state) VALUES (?, ?, 'down')",
            [(sid, cutoff - 60), (sid, cutoff), (sid, cutoff + 60)],
        )
        conn.executemany(
            "INSERT INTO monitor_incidents (id, service_id, started_at, ended_at, end_reason)"
            " VALUES (?, ?, ?, ?, ?)",
            [
                ("old", sid, cutoff - 120, cutoff - 60, "recovered"),
                ("threshold", sid, cutoff - 60, cutoff, "recovered"),
                ("recent", sid, cutoff - 60, cutoff + 60, "recovered"),
                ("open", sid, cutoff - 60, None, None),
            ],
        )
        conn.executemany(
            "INSERT INTO monitor_deliveries"
            " (id, service_id, incident_id, webhook_revision, kind, occurred_at, next_attempt)"
            " VALUES (?, ?, ?, 'test-revision', 'down', ?, ?)",
            [
                ("old-incident-delivery", sid, "old", cutoff + 60, cutoff + 60),
                ("old-delivery", sid, "open", cutoff - 60, cutoff - 60),
                ("threshold-delivery", sid, "threshold", cutoff, cutoff),
            ],
        )

    db(seed_history)
    assert db(monitoring.prune, cutoff) is False
    assert rows(db, "SELECT slot FROM monitor_samples ORDER BY slot") == [
        (cutoff,),
        (cutoff + 60,),
    ]
    assert rows(db, "SELECT id FROM monitor_incidents ORDER BY id") == [
        ("open",),
        ("recent",),
        ("threshold",),
    ]
    assert rows(db, "SELECT id FROM monitor_deliveries") == [("threshold-delivery",)]


def test_pruning_is_batched_and_resumable(db):
    _, target = enable_target(db)
    cutoff = SLOT + monitoring.RETENTION_SECONDS

    def seed_samples(conn):
        conn.executemany(
            "INSERT INTO monitor_samples (service_id, slot, state) VALUES (?, ?, 'down')",
            [(target.service_id, cutoff - 60 * i) for i in range(monitoring.PRUNE_BATCH + 2)],
        )

    db(seed_samples)
    assert db(monitoring.prune, cutoff) is True
    assert rows(db, "SELECT COUNT(*) FROM monitor_samples") == [(2,)]
    assert db(monitoring.prune, cutoff) is False
    assert rows(db, "SELECT slot FROM monitor_samples") == [(cutoff,)]

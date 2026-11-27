from contextlib import closing
from uuid import uuid4

import pytest

from serverhub.db import Database, monitor_webhooks, monitoring, transaction
from tests.test_monitor_repo import SLOT, enable_target, rows


@pytest.fixture
def monitored(tmp_path):
    with closing(Database(tmp_path / "serverhub.db")) as database:
        db = database.call
        _, target = enable_target(db)
        yield db, target


def enqueue(db, service_id, events=(("down", SLOT),)):
    incident_id = uuid4().hex
    ended_at = max(at for _, at in events)

    def write(conn):
        with transaction(conn):
            conn.execute(
                "INSERT INTO monitor_incidents VALUES (?, ?, ?, ?, 'recovered')",
                (incident_id, service_id, SLOT, ended_at),
            )
            for kind, occurred_at in events:
                monitor_webhooks.enqueue(conn, service_id, incident_id, kind, occurred_at)

    db(write)
    return incident_id


def test_config_is_write_only_and_does_not_replay_history(monitored):
    db, target = monitored
    assert db(monitor_webhooks.read_config) == {"configured": False, "last_delivery": None}
    enqueue(db, target.service_id)
    assert db(monitor_webhooks.configure, "destination-ciphertext") == {
        "configured": True,
        "last_delivery": None,
    }
    assert db(monitor_webhooks.due_ids, SLOT) == []

    enqueue(db, target.service_id)
    enqueue(db, target.service_id)
    first_id, second_id = db(monitor_webhooks.due_ids, SLOT)
    first = db(monitor_webhooks.claim, first_id, SLOT)
    assert first.url_enc == "destination-ciphertext"
    assert "destination-ciphertext" not in repr(first)
    db(monitor_webhooks.finish, first, SLOT, None)
    second = db(monitor_webhooks.claim, second_id, SLOT)
    assert db(monitor_webhooks.read_config)["last_delivery"] == {
        "status": "pending",
        "kind": "down",
        "occurred_at": SLOT,
        "attempts": 1,
        "last_error": None,
    }
    assert db(monitor_webhooks.configure, "replacement-ciphertext") == {
        "configured": True,
        "last_delivery": None,
    }
    db(monitor_webhooks.finish, second, SLOT, None)
    assert db(monitor_webhooks.due_ids, SLOT + 100) == []
    assert rows(db, "SELECT id, status FROM monitor_deliveries") == [(first_id, "delivered")]
    assert db(monitor_webhooks.remove) == {"configured": False, "last_delivery": None}


def test_enqueue_is_atomic_with_incident_and_idempotent(monitored):
    db, target = monitored
    db(monitor_webhooks.configure, "ciphertext")

    def abort(conn):
        with transaction(conn):
            conn.execute(
                "INSERT INTO monitor_incidents (id, service_id, started_at) VALUES (?, ?, ?)",
                ("rollback", target.service_id, SLOT),
            )
            monitor_webhooks.enqueue(conn, target.service_id, "rollback", "down", SLOT)
            raise RuntimeError("abort incident")

    with pytest.raises(RuntimeError, match="abort incident"):
        db(abort)
    assert rows(db, "SELECT id FROM monitor_incidents") == []
    assert db(monitor_webhooks.due_ids, SLOT) == []
    incident_id = enqueue(db, target.service_id, (("down", SLOT), ("down", SLOT)))
    assert rows(db, "SELECT incident_id, kind FROM monitor_deliveries") == [(incident_id, "down")]


def test_retry_keeps_event_id_and_recovery_waits_for_prior_event(monitored):
    db, target = monitored
    db(monitor_webhooks.configure, "ciphertext")
    incident_id = enqueue(db, target.service_id, (("down", SLOT), ("recovered", SLOT)))
    (down_id,) = db(monitor_webhooks.due_ids, SLOT)
    expected = SLOT
    for attempt, delay in enumerate((*monitor_webhooks.RETRY_DELAYS, None), 1):
        assert db(monitor_webhooks.due_ids, expected) == [down_id]
        delivery = db(monitor_webhooks.claim, down_id, expected)
        assert delivery.id == down_id and delivery.attempts == attempt
        assert (delivery.kind, delivery.service_id, delivery.incident_id) == (
            "down",
            target.service_id,
            incident_id,
        )
        assert delivery.service_name == "Service 0"
        assert db(monitor_webhooks.claim, down_id, expected) is None
        db(monitor_webhooks.finish, delivery, expected, "http_503")
        if delay is not None:
            expected += delay
            assert db(monitor_webhooks.due_ids, expected - 1) == []

    (recovered_id,) = db(monitor_webhooks.due_ids, expected)
    assert recovered_id != down_id
    recovery = db(monitor_webhooks.claim, recovered_id, expected)
    assert recovery.kind == "recovered"
    db(monitor_webhooks.finish, recovery, expected, None)
    assert rows(db, "SELECT status, last_error FROM monitor_deliveries ORDER BY kind") == [
        ("failed", "http_503"),
        ("delivered", None),
    ]


def test_expired_lease_reclaims_and_stale_finish_cannot_change_it(monitored):
    db, target = monitored
    db(monitor_webhooks.configure, "ciphertext")
    enqueue(db, target.service_id)
    (event_id,) = db(monitor_webhooks.due_ids, SLOT)
    initial = db(monitor_webhooks.claim, event_id, SLOT)
    expiry = SLOT + monitor_webhooks.LEASE_SECONDS
    db(monitor_webhooks.finish, initial, expiry, None)
    next_attempt = db(monitor_webhooks.claim, event_id, expiry)
    assert next_attempt.attempts == 2
    db(monitor_webhooks.finish, initial, SLOT + 5, None)
    assert rows(db, "SELECT status, attempts FROM monitor_deliveries") == [("pending", 2)]
    db(monitor_webhooks.finish, next_attempt, expiry, None)
    assert rows(db, "SELECT status, attempts FROM monitor_deliveries") == [("delivered", 2)]


@pytest.mark.parametrize("tries", [0, monitor_webhooks.MAX_ATTEMPTS])
def test_expiry_stops_unattempted_events_and_abandoned_final_leases(monitored, tries):
    db, target = monitored
    db(monitor_webhooks.configure, "ciphertext")
    enqueue(db, target.service_id)
    (event_id,) = db(monitor_webhooks.due_ids, SLOT)
    now = SLOT
    for attempt in range(tries):
        assert db(monitor_webhooks.claim, event_id, now).attempts == attempt + 1
        now += monitor_webhooks.LEASE_SECONDS
    if not tries:
        now = SLOT + monitor_webhooks.MAX_EVENT_AGE
        assert db(monitor_webhooks.claim, event_id, now) is None
    assert db(monitor_webhooks.due_ids, now) == []
    assert db(monitor_webhooks.read_config)["last_delivery"] == {
        "status": "failed",
        "kind": "down",
        "occurred_at": SLOT,
        "attempts": tries,
        "last_error": "expired",
    }


def test_due_batch_is_bounded_and_pause_cancels_leased_and_pending(monitored):
    db, target = monitored
    db(monitor_webhooks.configure, "ciphertext")
    for _ in range(monitor_webhooks.BATCH_SIZE + 1):
        enqueue(db, target.service_id)
    due = db(monitor_webhooks.due_ids, SLOT)
    assert len(due) == monitor_webhooks.BATCH_SIZE
    leased = db(monitor_webhooks.claim, due[0], SLOT)
    assert (
        db(monitoring.set_service_enabled, target.user_id, target.service_id, False, SLOT) is False
    )
    db(monitor_webhooks.finish, leased, SLOT, None)
    assert db(monitor_webhooks.due_ids, SLOT) == []
    assert rows(db, "SELECT id FROM monitor_deliveries") == []

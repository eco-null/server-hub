"""Exercise the worker through the durable outbox without making external requests."""

import logging

import anyio
import httpx
import pytest

from serverhub.auth.crypto import Keys
from serverhub.db import Database, monitor_webhooks, monitoring, repo, transaction
from serverhub.integrations import monitor_webhooks as worker_module
from serverhub.integrations.fetcher import FetchError, FetchResult, SafeFetcher
from serverhub.integrations.monitor_webhooks import (
    MAX_CONCURRENT_SENDS,
    WEBHOOK_IDENTITY,
    WebhookWorker,
)

pytestmark = pytest.mark.anyio
DESTINATION = "https://receiver.example.test/secret-hook?token=fixture-only"


class Clock:
    now = 240.0

    def __call__(self):
        return self.now


class Fetcher:
    def __init__(self, responder):
        self._responder = responder
        self.calls = []

    async def request(self, method, url, **options):
        self.calls.append((method, url, options))
        return await self._responder(options["json"])


@pytest.fixture
def outbox(tmp_path):
    db = Database(tmp_path / "webhooks.db")
    keys = Keys("webhook-worker-test-key-only")
    user_id = db.call(repo.create_user, "fixture@example.test", "fixture", "unused", "user")["id"]
    db.call(monitoring.set_global_enabled, True)
    db.call(monitor_webhooks.configure, keys.encrypt(DESTINATION))
    try:
        yield db, keys, user_id
    finally:
        db.close()


def queue(outbox, clock, name):
    db, _keys, user_id = outbox
    service = db.call(
        repo.insert_owned,
        "services",
        user_id,
        {"name": name, "url": f"https://{name}.example.test", "icon": "box"},
        500,
    )
    service_id = service["id"]
    incident_id = f"{name}-incident"
    now = int(clock())
    db.call(monitoring.set_service_enabled, user_id, service_id, True, now)

    def _write(conn):
        with transaction(conn):
            conn.execute(
                "INSERT INTO monitor_incidents (id, service_id, started_at) VALUES (?, ?, ?)",
                (incident_id, service_id, now),
            )
            monitor_webhooks.enqueue(conn, service_id, incident_id, "down", now)
            return conn.execute(
                "SELECT id FROM monitor_deliveries WHERE incident_id = ?", (incident_id,)
            ).fetchone()["id"]

    return service_id, incident_id, db.call(_write)


def delivery_status(db, event_id):
    return db.call(
        lambda conn: dict(
            conn.execute(
                "SELECT status, attempts, next_attempt, last_error FROM monitor_deliveries"
                " WHERE id = ?",
                (event_id,),
            ).fetchone()
        )
    )


def response(status):
    return FetchResult(status, httpx.Headers(), b"")


async def test_tick_posts_a_minimal_event_with_stable_idempotency_key(outbox):
    clock = Clock()
    db, keys, _user_id = outbox

    async def ok(_body):
        return response(204)

    fetcher = Fetcher(ok)
    worker = WebhookWorker(db, fetcher, keys, clock=clock)
    await worker.tick()
    assert fetcher.calls == []

    service_id, incident_id, event_id = queue(outbox, clock, "tracked")
    await worker.tick()
    await worker.tick()

    assert fetcher.calls == [
        (
            "POST",
            DESTINATION,
            {
                "user_id": WEBHOOK_IDENTITY,
                "json": {
                    "id": event_id,
                    "event": "down",
                    "occurred_at": 240,
                    "service": {"id": service_id, "name": "tracked"},
                    "incident_id": incident_id,
                },
                "headers": {"Idempotency-Key": event_id},
                "read_body": False,
                "sensitive_url": True,
            },
        )
    ]
    assert delivery_status(db, event_id) == {
        "status": "delivered",
        "attempts": 1,
        "next_attempt": 240,
        "last_error": None,
    }


@pytest.mark.parametrize(
    ("failure", "last_error"),
    [
        (301, "http_301"),
        (503, "http_503"),
        (FetchError("tls"), "tls"),
        (FetchError(DESTINATION), "protocol"),
        (RuntimeError(DESTINATION), "internal"),
    ],
)
async def test_failed_attempt_is_sanitized_and_retries_the_same_event(
    outbox, failure, last_error, caplog
):
    clock = Clock()
    db, keys, _user_id = outbox
    _, _, event_id = queue(outbox, clock, "tracked")
    results = iter((failure, 200))

    async def eventually_ok(_body):
        result = next(results)
        if isinstance(result, Exception):
            raise result
        return response(result)

    fetcher = Fetcher(eventually_ok)
    worker = WebhookWorker(db, fetcher, keys, clock=clock)
    with caplog.at_level(logging.DEBUG):
        await worker.tick()
    assert DESTINATION not in caplog.text
    assert delivery_status(db, event_id) == {
        "status": "pending",
        "attempts": 1,
        "next_attempt": 255,
        "last_error": last_error,
    }

    clock.now = 254.0
    await worker.tick()
    assert len(fetcher.calls) == 1
    clock.now = 255.0
    await worker.tick()
    assert fetcher.calls == [fetcher.calls[0], fetcher.calls[0]]
    assert delivery_status(db, event_id)["status"] == "delivered"


async def test_corrupt_ciphertext_never_reaches_the_fetcher(outbox):
    clock = Clock()
    db, keys, _user_id = outbox
    db.call(monitor_webhooks.configure, "invalid encrypted destination")
    _, _, event_id = queue(outbox, clock, "tracked")

    async def ok(_body):
        return response(200)

    fetcher = Fetcher(ok)
    await WebhookWorker(db, fetcher, keys, clock=clock).tick()
    assert fetcher.calls == []
    assert delivery_status(db, event_id)["last_error"] == "invalid_destination"


async def test_real_fetcher_keeps_its_destination_policy_for_webhooks(outbox):
    clock = Clock()
    db, keys, _user_id = outbox
    db.call(monitor_webhooks.configure, keys.encrypt("https://127.0.0.1:1/fixture"))
    _, _, event_id = queue(outbox, clock, "tracked")
    fetcher = SafeFetcher(allow_private=True)
    try:
        await WebhookWorker(db, fetcher, keys, clock=clock).tick()
    finally:
        await fetcher.aclose()
    assert delivery_status(db, event_id)["last_error"] == "blocked"


async def test_timeout_includes_waiting_inside_the_fetcher(outbox, monkeypatch):
    clock = Clock()
    db, keys, _user_id = outbox
    _, _, event_id = queue(outbox, clock, "tracked")
    monkeypatch.setattr(worker_module, "SEND_TIMEOUT_SECONDS", 0.025)

    async def blocked(_body):
        await anyio.sleep_forever()

    with anyio.fail_after(2):
        await WebhookWorker(db, Fetcher(blocked), keys, clock=clock).tick()
    assert delivery_status(db, event_id)["last_error"] == "timeout"


async def test_run_cancels_inflight_http_and_leaves_a_recoverable_lease(outbox):
    clock = Clock()
    db, keys, _user_id = outbox
    _, _, event_id = queue(outbox, clock, "tracked")
    started = anyio.Event()
    cancelled = anyio.Event()

    async def blocking(_body):
        started.set()
        try:
            await anyio.sleep_forever()
        finally:
            cancelled.set()

    worker = WebhookWorker(db, Fetcher(blocking), keys, clock=clock)
    with anyio.fail_after(2):
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(worker.run)
            await started.wait()
            tasks.cancel_scope.cancel()
    assert cancelled.is_set()
    assert delivery_status(db, event_id) == {
        "status": "pending",
        "attempts": 1,
        "next_attempt": 240 + monitor_webhooks.LEASE_SECONDS,
        "last_error": None,
    }

    async def ok(_body):
        return response(200)

    clock.now += monitor_webhooks.LEASE_SECONDS
    fetcher = Fetcher(ok)
    await WebhookWorker(db, fetcher, keys, clock=clock).tick()
    assert fetcher.calls[0][2]["headers"] == {"Idempotency-Key": event_id}
    assert delivery_status(db, event_id)["status"] == "delivered"
    assert delivery_status(db, event_id)["attempts"] == 2


async def test_overlapping_ticks_keep_the_same_concurrency_cap(outbox):
    clock = Clock()
    db, keys, _user_id = outbox
    event_ids = [queue(outbox, clock, f"tracked-{index}")[2] for index in range(7)]
    ready = anyio.Event()
    release = anyio.Event()
    active = peak = 0

    async def overlapping(body):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if active == MAX_CONCURRENT_SENDS:
            ready.set()
        try:
            await release.wait()
        finally:
            active -= 1
        return response(503 if body["service"]["name"] == "tracked-0" else 200)

    fetcher = Fetcher(overlapping)
    worker = WebhookWorker(db, fetcher, keys, clock=clock)
    with anyio.fail_after(2):
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(worker.tick)
            tasks.start_soon(worker.tick)
            await ready.wait()
            release.set()
    assert peak == MAX_CONCURRENT_SENDS
    assert sorted(call[2]["json"]["id"] for call in fetcher.calls) == sorted(event_ids)
    assert delivery_status(db, event_ids[0])["last_error"] == "http_503"
    assert all(delivery_status(db, event_id)["status"] == "delivered" for event_id in event_ids[1:])

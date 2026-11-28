from datetime import UTC, datetime

import anyio
import pytest

from serverhub.db import Database, monitoring, repo
from serverhub.integrations import monitoring as worker_module
from serverhub.integrations.monitoring import CONCURRENCY, MonitoringWorker

pytestmark = pytest.mark.anyio


@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "monitoring.db")
    try:
        yield database
    finally:
        database.close()


class Clock:
    now = 125.0

    def __call__(self):
        return self.now


class Checker:
    def __init__(self, result):
        self.calls = []
        self.checked_since = []
        self.result = result

    async def check_one(self, url, user_id, *, checked_since):
        self.calls.append((url, user_id))
        self.checked_since.append(checked_since)
        return await self.result(url)


def observation(at):
    return {
        "state": "up",
        "http_status": 200,
        "latency_ms": 2,
        "checked_at": datetime.fromtimestamp(at, UTC).isoformat(),
    }


def owner(db, name="alex"):
    return db.call(repo.create_user, f"{name}@example.org", name, "unused", "user")["id"]


def add_service(db, user_id, host):
    return db.call(
        repo.insert_owned,
        "services",
        user_id,
        {"name": host, "url": f"https://{host}.example", "icon": "box"},
        500,
    )


def enable(db, user_id, service, clock):
    db.call(monitoring.set_service_enabled, user_id, service["id"], True, clock())


def samples(db):
    return db.call(
        lambda conn: [
            tuple(row)
            for row in conn.execute(
                "SELECT service_id, slot, state, checked_at FROM monitor_samples"
                " ORDER BY slot, service_id"
            )
        ]
    )


async def test_tick_checks_only_opted_in_services_once_per_current_slot(db):
    clock = Clock()
    user_id = owner(db)
    service = add_service(db, user_id, "wanted")
    add_service(db, user_id, "ignored")

    async def result(_url):
        return observation(clock())

    checker = Checker(result)
    worker = MonitoringWorker(db, checker, clock=clock)
    await worker.tick()
    db.call(monitoring.set_global_enabled, True)
    await worker.tick()
    assert checker.calls == []

    enable(db, user_id, service, clock)
    await worker.tick()
    await worker.tick()
    clock.now = 369.0
    await worker.tick()
    assert checker.calls == [(service["url"], user_id)] * 2
    assert checker.checked_since == ["1970-01-01T00:02:00Z", "1970-01-01T00:06:00Z"]
    assert samples(db) == [
        (service["id"], 120, "up", observation(125)["checked_at"]),
        (service["id"], 360, "up", observation(369)["checked_at"]),
    ]


async def test_bad_and_stale_observations_do_not_drop_peer_checks(db):
    clock = Clock()
    user_id = owner(db)
    db.call(monitoring.set_global_enabled, True)
    services = {
        name: add_service(db, user_id, name) for name in ("working", "stale", "invalid", "failed")
    }
    for service in services.values():
        enable(db, user_id, service, clock)

    async def result(url):
        if url == services["failed"]["url"]:
            raise RuntimeError("check failed unexpectedly")
        if url == services["stale"]["url"]:
            return observation(119)
        if url == services["invalid"]["url"]:
            return {**observation(clock()), "checked_at": "invalid"}
        return observation(clock())

    await MonitoringWorker(db, Checker(result), clock=clock).tick()
    read = {service_id: (state, checked_at) for service_id, _, state, checked_at in samples(db)}
    assert read[services["working"]["id"]] == ("up", observation(125)["checked_at"])
    for name in ("stale", "invalid", "failed"):
        assert read[services[name]["id"]] == ("unknown", None)


async def test_result_completed_in_a_different_slot_is_never_written(db):
    clock = Clock()
    user_id = owner(db)
    db.call(monitoring.set_global_enabled, True)
    service = add_service(db, user_id, "slow")
    enable(db, user_id, service, clock)

    async def result(_url):
        clock.now = 180.0
        return observation(clock())

    await MonitoringWorker(db, Checker(result), clock=clock).tick()
    assert samples(db) == []


async def test_batch_deadline_cancels_an_unfinished_check_without_a_sample(db):
    clock = Clock()
    clock.now = 179.9
    user_id = owner(db)
    db.call(monitoring.set_global_enabled, True)
    enable(db, user_id, add_service(db, user_id, "blocked"), clock)
    stopped = anyio.Event()

    async def result(_url):
        try:
            await anyio.sleep_forever()
        finally:
            stopped.set()

    with anyio.fail_after(3):
        await MonitoringWorker(db, Checker(result), clock=clock).tick()
    assert stopped.is_set()
    assert samples(db) == []


async def test_worker_cancellation_reaches_inflight_checks(db):
    clock = Clock()
    user_id = owner(db)
    db.call(monitoring.set_global_enabled, True)
    enable(db, user_id, add_service(db, user_id, "blocked"), clock)
    started = anyio.Event()
    stopped = anyio.Event()

    async def result(_url):
        started.set()
        try:
            await anyio.sleep_forever()
        finally:
            stopped.set()

    worker = MonitoringWorker(db, Checker(result), clock=clock)
    with anyio.fail_after(3):
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(worker.run)
            await started.wait()
            tasks.cancel_scope.cancel()
    assert stopped.is_set()
    assert samples(db) == []


async def test_paused_target_waiting_for_capacity_never_reaches_checker(db, monkeypatch):
    monkeypatch.setattr(worker_module, "CONCURRENCY", 1)
    clock = Clock()
    user_id = owner(db)
    db.call(monitoring.set_global_enabled, True)
    first, queued = sorted(
        (add_service(db, user_id, name) for name in ("first", "second")), key=lambda row: row["id"]
    )
    enable(db, user_id, first, clock)
    enable(db, user_id, queued, clock)
    started = anyio.Event()
    release = anyio.Event()

    async def result(_url):
        started.set()
        await release.wait()
        return observation(clock())

    checker = Checker(result)
    worker = MonitoringWorker(db, checker, clock=clock)
    with anyio.fail_after(3):
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(worker.tick)
            await started.wait()
            await db.run(monitoring.set_service_enabled, user_id, queued["id"], False, clock())
            release.set()
    assert checker.calls == [(first["url"], user_id)]
    assert [row[0] for row in samples(db)] == [first["id"]]


async def test_run_prunes_expired_samples_even_with_monitoring_disabled(db, monkeypatch):
    clock = Clock()
    user_id = owner(db)
    db.call(monitoring.set_global_enabled, True)
    enable(db, user_id, add_service(db, user_id, "old"), clock)

    async def result(_url):
        return observation(clock())

    checker = Checker(result)
    worker = MonitoringWorker(db, checker, clock=clock)
    await worker.tick()
    assert len(samples(db)) == 1

    db.call(monitoring.set_global_enabled, False)
    clock.now += monitoring.RETENTION_SECONDS + 60
    prune = monitoring.prune
    cleaned = anyio.Event()

    def signal_after_prune(conn, cutoff_slot):
        more = prune(conn, cutoff_slot)
        anyio.from_thread.run_sync(cleaned.set)
        return more

    monkeypatch.setattr(monitoring, "prune", signal_after_prune)
    with anyio.fail_after(3):
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(worker.run)
            await cleaned.wait()
            tasks.cancel_scope.cancel()
    assert samples(db) == []
    assert len(checker.calls) == 1


async def test_wall_clock_rewind_never_sleeps_more_than_one_interval(db, monkeypatch):
    clock = Clock()
    sleeps = []

    class StopWorker(Exception):
        pass

    def rewind(_conn, _slot):
        clock.now -= 3600
        return None, []

    async def record_sleep(delay):
        sleeps.append(delay)
        raise StopWorker

    monkeypatch.setattr(monitoring, "due_targets", rewind)
    monkeypatch.setattr(worker_module.anyio, "sleep", record_sleep)
    with pytest.raises(StopWorker):
        await MonitoringWorker(db, Checker(None), clock=clock).run()
    assert sleeps == [60]


async def test_concurrency_is_bounded_across_accounts(db):
    clock = Clock()
    owners = [owner(db, "alex"), owner(db, "jamie")]
    db.call(monitoring.set_global_enabled, True)
    for i in range(CONCURRENCY + 1):
        user_id = owners[i % len(owners)]
        enable(db, user_id, add_service(db, user_id, f"service-{i}"), clock)

    active = 0
    peak = 0
    full = anyio.Event()
    release = anyio.Event()

    async def result(_url):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if active == CONCURRENCY:
            full.set()
        try:
            await release.wait()
            return observation(clock())
        finally:
            active -= 1

    checker = Checker(result)
    worker = MonitoringWorker(db, checker, clock=clock)
    with anyio.fail_after(3):
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(worker.tick)
            await full.wait()
            await anyio.wait_all_tasks_blocked()
            assert len(checker.calls) == CONCURRENCY
            release.set()
    assert peak == CONCURRENCY
    assert len(samples(db)) == CONCURRENCY + 1

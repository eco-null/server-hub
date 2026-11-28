from __future__ import annotations

import json
import time
from contextlib import aclosing

import anyio
import httpx
import pytest

from serverhub.db import monitoring
from serverhub.integrations.beszel import BeszelClient, Target, normalize_system
from serverhub.integrations.fetcher import FetchError, FetchResult, SafeFetcher
from serverhub.integrations.monitoring import MonitoringWorker
from serverhub.integrations.status import StatusChecker
from tests.conftest import LOCAL_OK, create_user, new_session, running, setup_admin

pytestmark = pytest.mark.anyio


# ---- status checks ----------------------------------------------------------------


async def test_status_checks(client, stub):
    await setup_admin(client)
    stub.route("GET", "/up", 200)
    stub.route("GET", "/missing", 404)
    stub.route("GET", "/broken", 503)
    stub.route("GET", "/moved", 301, headers={"Location": "http://169.254.169.254/"})
    ids = {}
    for name, url, check in (
        ("up", stub.url + "/up", True),
        ("missing", stub.url + "/missing", True),
        ("broken", stub.url + "/broken", True),
        ("moved", stub.url + "/moved", True),
        ("meta", "http://169.254.169.254/latest/", True),
        ("off", stub.url + "/up?off", False),
    ):
        r = await client.post("/api/services", json={"name": name, "url": url, "check": check})
        ids[name] = r.json()["service"]["id"]

    r = await client.get("/api/status")
    assert r.status_code == 200
    st = r.json()["statuses"]
    assert st[ids["up"]]["state"] == "up" and st[ids["up"]]["http_status"] == 200
    assert isinstance(st[ids["up"]]["latency_ms"], int)
    assert st[ids["up"]]["checked_at"].endswith("Z")
    assert st[ids["missing"]]["state"] == "up"  # any answer below 500
    assert st[ids["broken"]]["state"] == "down" and st[ids["broken"]]["http_status"] == 503
    assert st[ids["moved"]]["state"] == "up"  # redirect not followed
    assert st[ids["meta"]] == {
        "state": "unknown",
        "http_status": None,
        "latency_ms": None,
        "checked_at": st[ids["meta"]]["checked_at"],
    }
    assert ids["off"] not in st

    # TTL cache: a second poll does not hit the targets again.
    hits = len(stub.log)
    await client.get("/api/status")
    assert len(stub.log) == hits
    assert all("169.254" not in e["path"] for e in stub.log)


async def test_status_unreachable_is_down(client):
    await setup_admin(client)
    r = await client.post("/api/services", json={"name": "x", "url": "http://127.0.0.1:1/"})
    sid = r.json()["service"]["id"]
    st = (await client.get("/api/status")).json()["statuses"]
    assert st[sid]["state"] == "down"


async def test_status_reads_monitored_results_without_probing_or_exposing_details(
    tmp_path, stub, monkeypatch
):
    stub.route("GET", "/live", 200)

    async def idle(_self):
        await anyio.sleep_forever()

    monkeypatch.setattr(MonitoringWorker, "run", idle)
    async with running(tmp_path, fetcher_options=LOCAL_OK) as client:
        await setup_admin(client)
        user = await create_user(client, "monitor_owner")
        async with aclosing(await new_session(client.app, user["username"])) as owner:
            db = client.app.state.hub.db
            await db.run(monitoring.set_global_enabled, True)
            live = await owner.post(
                "/api/services", json={"name": "Live", "url": stub.url + "/live"}
            )
            monitored = await owner.post(
                "/api/services", json={"name": "Tracked", "url": stub.url + "/tracked"}
            )
            live_id = live.json()["service"]["id"]
            tracked_id = monitored.json()["service"]["id"]
            now = time.time()
            slot = monitoring.minute_slot(now)
            await db.run(monitoring.set_service_enabled, user["id"], tracked_id, True, now)
            epoch, targets = await db.run(monitoring.due_targets, slot)
            observed = {
                "state": "down",
                "checked_at": "2026-11-27T07:00:00Z",
                "http_status": 503,
                "latency_ms": 8,
            }
            assert await db.run(monitoring.record_result, epoch, targets[0], slot, observed)

            statuses = (await owner.get("/api/status")).json()["statuses"]
            assert statuses[live_id]["state"] == "up"
            assert statuses[tracked_id] == {**observed, "http_status": None, "latency_ms": None}
            assert [entry["path"] for entry in stub.log] == ["/live"]
            assert (await client.get("/api/status")).json() == {"statuses": {}}


async def test_status_checks_rotate_when_the_budget_cannot_cover_all_targets(monkeypatch):
    checked = []
    remaining = 0

    async def check(_method, url, **_options):
        nonlocal remaining
        if not remaining:
            raise FetchError("busy")
        remaining -= 1
        checked.append(url)
        return FetchResult(200, httpx.Headers(), b"")

    targets = [(name, f"https://{name}.example") for name in ("a", "b", "c")]
    f = SafeFetcher(allow_private=True)
    monkeypatch.setattr(f, "request", check)
    checker = StatusChecker(f, ttl=0)
    try:
        for _ in range(len(targets) + 1):
            remaining = 1
            await checker.check_many("user", targets)
    finally:
        await f.aclose()
    assert checked == [url for _, url in targets] + [targets[0][1]]


async def test_status_cache_can_require_a_current_slot_observation(monkeypatch):
    checks = []

    async def check(_method, url, **_options):
        checks.append(url)
        return FetchResult(200, httpx.Headers(), b"")

    url = "https://monitor.example/"
    fetcher = SafeFetcher(allow_private=False)
    monkeypatch.setattr(fetcher, "request", check)
    checker = StatusChecker(fetcher)
    checker._store(
        ("owner", url),
        {
            "state": "down",
            "http_status": 503,
            "latency_ms": 10,
            "checked_at": "2000-01-01T00:00:00Z",
        },
    )
    try:
        assert (await checker.check_one(url, "owner"))["state"] == "down"
        assert (await checker.check_one(url, "owner", checked_since="2000-01-01T00:01:00Z"))[
            "state"
        ] == "up"
        assert (await checker.check_one(url, "owner"))["state"] == "up"
    finally:
        await fetcher.aclose()
    assert checks == [url]


async def test_status_loopback_blocked_in_default_config(tmp_path, stub):
    stub.route("GET", "/", 200)
    async with running(tmp_path) as c:  # no test allowance for 127.0.0.1
        await setup_admin(c)
        r = await c.post("/api/services", json={"name": "x", "url": stub.url + "/"})
        sid = r.json()["service"]["id"]
        st = (await c.get("/api/status")).json()["statuses"]
        assert st[sid]["state"] == "unknown"
    assert stub.log == []


# ---- Beszel -------------------------------------------------------------------------

SYSTEM = {
    "id": "abc",
    "name": "nas",
    "status": "up",
    "host": "10.0.0.2",
    "info": json.dumps({"cpu": 12.345, "mp": 55, "dp": 101, "u": 3600}),
}


def pocketbase(stub, *, superuser: bool = False, password: str = "pw"):
    auth_calls = []

    def auth(collection):
        def handler(_h, body):
            auth_calls.append(collection)
            data = json.loads(body)
            ok = data["password"] == password and (collection == "_superusers") == superuser
            if not ok:
                payload = {"message": "Failed to authenticate. internal-detail-xyz", "data": {}}
                return 400, {"Content-Type": "application/json"}, json.dumps(payload).encode()
            rec = {"email": data["identity"], "username": "beszel-admin"}
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps({"token": f"tok-{len(auth_calls)}", "record": rec}).encode(),
            )

        return handler

    def systems(h, _b):
        if not h.headers.get("Authorization", "").startswith("tok-"):
            return 401, {}, b'{"message":"denied"}'
        body = {"page": 1, "items": [SYSTEM, {"name": "pi", "info": {"cpu": "bad"}}]}
        return 200, {"Content-Type": "application/json"}, json.dumps(body).encode()

    stub.routes[("POST", "/api/collections/users/auth-with-password")] = auth("users")
    stub.routes[("POST", "/api/collections/_superusers/auth-with-password")] = auth("_superusers")
    stub.routes[("GET", "/api/collections/systems/records")] = systems
    return auth_calls


def test_normalize_system():
    out = normalize_system(SYSTEM)
    assert out == {
        "name": "nas",
        "status": "up",
        "host": "10.0.0.2",
        "cpu": 12.3,
        "memory": 55.0,
        "disk": 100.0,
        "uptime_seconds": 3600,
    }
    assert normalize_system({"info": "not json"})["cpu"] is None


async def test_beszel_instances_and_systems(client, stub):
    await setup_admin(client)
    pocketbase(stub, superuser=True)
    r = await client.post(
        "/api/beszel/instances",
        json={"url": stub.url + "/", "username": "me@example.org", "password": "pw"},
    )
    assert r.status_code == 201, r.text
    inst = r.json()["instance"]
    assert inst["has_password"] is True and "password" not in inst
    assert inst["name"] == "127.0.0.1" and inst["url"] == stub.url

    r = await client.post(
        "/api/beszel/instances",
        json={"name": "bad", "url": "http://127.0.0.1:1", "username": "u", "password": "nope"},
    )
    bad = r.json()["instance"]

    r = await client.get("/api/beszel/systems")
    data = r.json()["instances"]
    good = next(i for i in data if i["id"] == inst["id"])
    assert good["ok"] is True and good["error"] is None
    assert [s["name"] for s in good["systems"]] == ["nas", "pi"]
    assert good["systems"][1]["cpu"] is None
    broken = next(i for i in data if i["id"] == bad["id"])
    assert broken["ok"] is False and broken["error"] == "Could not connect"
    assert broken["systems"] == []

    # PATCH without password keeps it; listing never reveals it.
    r = await client.patch(f"/api/beszel/instances/{inst['id']}", json={"name": "Home"})
    assert r.json()["instance"]["name"] == "Home"
    assert (await client.get("/api/beszel/systems")).json()["instances"][0]["ok"] is True
    assert "pw" not in (await client.get("/api/beszel/instances")).text


async def test_beszel_test_endpoint(client, stub):
    await setup_admin(client)
    pocketbase(stub)
    body = {"url": stub.url, "username": "me@example.org", "password": "pw"}
    r = await client.post("/api/beszel/test", json=body)
    assert r.json() == {"ok": True, "name": "beszel-admin", "error": None}

    r = await client.post("/api/beszel/test", json={**body, "password": "wrong"})
    out = r.json()
    assert out["ok"] is False and out["name"] is None
    assert "internal-detail-xyz" not in out["error"]  # remote bodies are never echoed

    r = await client.post("/api/beszel/test", json={**body, "url": "http://169.254.169.254"})
    assert r.json()["error"] == "That address is not allowed"

    inst = (await client.post("/api/beszel/instances", json=body)).json()["instance"]
    r = await client.post("/api/beszel/test", json={"instance_id": inst["id"]})
    assert r.json()["ok"] is True
    r = await client.post("/api/beszel/test", json={"instance_id": "nope"})
    assert r.status_code == 404
    r = await client.post(
        "/api/beszel/test", json={"url": "ftp://x", "username": "u", "password": "p"}
    )
    assert r.status_code == 400


async def test_beszel_token_reuse_and_refresh(stub):
    auth_calls = pocketbase(stub)
    f = SafeFetcher(allow_private=True, **LOCAL_OK)
    client = BeszelClient(f)
    target = Target(stub.url, "me@example.org", "pw")
    try:
        await client.systems(("i1", 1), target, "u")
        client._results = type(client._results)(16)  # expire the result cache
        await client.systems(("i1", 1), target, "u")
        assert auth_calls == ["users"]  # token reused

        # A revision bump (instance edited) never reuses the old token.
        await client.systems(("i1", 2), target, "u")
        assert auth_calls == ["users", "users"]
    finally:
        await f.aclose()


async def test_beszel_errors_are_cached_as_strings(stub):
    pocketbase(stub, password="other")
    f = SafeFetcher(allow_private=True, **LOCAL_OK)
    client = BeszelClient(f)
    try:
        for _ in range(2):
            with pytest.raises(Exception) as ei:
                await client.systems(("i1", 1), Target(stub.url, "u", "pw"), "u")
            assert ei.value.message == "Beszel rejected the username or password"
        cached = next(iter(client._results._d.values()))[1]
        assert isinstance(cached, str)
    finally:
        await f.aclose()

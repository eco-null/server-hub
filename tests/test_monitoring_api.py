from contextlib import aclosing
from uuid import uuid4

import pytest

from serverhub.api import monitoring as monitoring_api
from serverhub.db import monitoring
from serverhub.db.monitor_history import INCIDENT_PAGE_SIZE
from serverhub.integrations.status import unknown
from tests.conftest import create_user, new_session, setup_admin

pytestmark = pytest.mark.anyio

ADMIN_PATH = "/api/admin/monitoring"
# Keep the fake clock ahead of the real background scheduler.
FIRST_SLOT = 2_400_000_000
UP = {"state": "up", "checked_at": "2046-01-19T18:40:00Z", "http_status": 200, "latency_ms": 12}
DOWN = {**UP, "state": "down", "http_status": 503}
EMPTY_SUMMARY = {"uptime_pct": None, "checked": 0, "expected": 0, "unknown": 0, "missing": 0}


@pytest.fixture(autouse=True)
def freeze_monitoring_time(monkeypatch):
    monkeypatch.setattr(monitoring_api, "time", lambda: FIRST_SLOT)


async def create_service(client, *, check=True):
    response = await client.post(
        "/api/services",
        json={
            "name": "Test service",
            "url": "https://service.invalid",
            "icon": "box",
            "check": check,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["service"]["id"]


def path(sid):
    return f"/api/services/{sid}/monitoring"


async def enable_global(client):
    response = await client.put(ADMIN_PATH, json={"enabled": True})
    assert response.status_code == 200
    assert response.json() == {"enabled": True}


async def enable_service(client, sid):
    response = await client.put(path(sid), json={"enabled": True})
    assert response.status_code == 200, response.text
    assert response.json()["enabled"] is True


async def seed_samples(client, sid, measurements):
    db = client.app.state.hub.db
    epoch, targets = await db.run(monitoring.due_targets, FIRST_SLOT)
    target = next(target for target in targets if target.service_id == sid)
    assert epoch is not None
    for offset, result in measurements:
        assert await db.run(monitoring.record_result, epoch, target, FIRST_SLOT + offset, result)


@pytest.mark.parametrize("method", ["GET", "PUT"])
async def test_monitoring_requires_authentication(client, method):
    for url in [ADMIN_PATH, path(uuid4())]:
        response = await client.request(method, url, json={"enabled": True})
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthenticated"


async def test_admin_toggle_and_service_opt_in_respect_csrf_and_installation_state(client):
    await setup_admin(client)
    sid = await create_service(client)
    unchecked = await create_service(client, check=False)
    assert (await client.get(ADMIN_PATH)).json() == {"enabled": False}
    assert (await client.get(path(sid))).json() == {
        "available": False,
        "enabled": False,
        "check_enabled": True,
        "last_check": None,
        "summary": EMPTY_SUMMARY,
        "incidents": [],
        "next_before": None,
    }
    response = await client.put(path(sid), json={"enabled": True})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "monitoring_disabled"

    await enable_global(client)
    for url in (ADMIN_PATH, path(sid)):
        response = await client.put(
            url, json={"enabled": True}, headers={"Origin": "https://other.invalid"}
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "csrf"

    response = await client.put(path(unchecked), json={"enabled": True})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "checks_disabled"
    await enable_service(client, sid)
    assert (await client.get(path(sid))).json()["available"] is True
    response = await client.put(ADMIN_PATH, json={"enabled": False})
    assert response.json() == {"enabled": False}
    assert (await client.get(path(sid))).json()["available"] is False
    response = await client.put(path(sid), json={"enabled": False})
    assert response.status_code == 200
    assert response.json()["enabled"] is False


async def test_service_monitoring_is_owner_only_even_for_admins(client):
    await setup_admin(client)
    await create_user(client, "owner")
    admin_sid = await create_service(client)
    await enable_global(client)
    async with aclosing(await new_session(client.app, "owner")) as owner:
        owner_sid = await create_service(owner)
        await enable_service(owner, owner_sid)
        for method in ("GET", "PUT"):
            response = await owner.request(method, ADMIN_PATH, json={"enabled": False})
            assert response.status_code == 403
            for session, foreign_sid in ((client, owner_sid), (owner, admin_sid)):
                response = await session.request(method, path(foreign_sid), json={"enabled": False})
                assert response.status_code == 404
                assert response.json()["error"]["code"] == "not_found"
        assert (await owner.get(path(owner_sid))).json()["enabled"] is True


@pytest.mark.parametrize("sid", ["docker:example", "invalid-uuid", str(uuid4())])
async def test_non_service_id_returns_404(client, sid):
    await setup_admin(client)
    assert (await client.get(path(sid))).status_code == 404
    assert (await client.put(path(sid), json={"enabled": False})).status_code == 404


@pytest.mark.parametrize(
    "body", [{}, {"enabled": None}, {"enabled": 1}, {"enabled": "true"}, {"enabled": False, "x": 1}]
)
async def test_monitoring_put_requires_exact_boolean_object(client, body):
    await setup_admin(client)
    sid = await create_service(client)
    for url in (ADMIN_PATH, path(sid)):
        response = await client.put(url, json=body)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "validation"


@pytest.mark.parametrize(
    "query",
    [
        "before=",
        "before=0",
        "before=-1",
        "before=%2B1",
        "before=1.5",
        "before=%D9%A1",
        "before=1&before=2",
        "before=9223372036854775808",
    ],
)
async def test_before_must_be_single_positive_sqlite_integer(client, query):
    await setup_admin(client)
    sid = await create_service(client)
    response = await client.get(f"{path(sid)}?{query}")
    assert response.status_code == 400, response.text
    assert "before" in response.json()["error"]["fields"]


async def test_history_summary_counts_gaps_and_omits_check_details_for_nonadmin(
    client, monkeypatch
):
    await setup_admin(client)
    await create_user(client, "owner")
    await enable_global(client)
    admin_sid = await create_service(client)
    await enable_service(client, admin_sid)
    await seed_samples(client, admin_sid, [(240, UP)])

    async with aclosing(await new_session(client.app, "owner")) as owner:
        owner_sid = await create_service(owner)
        await enable_service(owner, owner_sid)
        await seed_samples(client, owner_sid, [(0, UP), (60, DOWN), (120, unknown()), (240, UP)])
        monkeypatch.setattr(monitoring_api, "time", lambda: FIRST_SLOT + 240)
        result = (await owner.get(path(owner_sid))).json()
        assert result["summary"] == {
            "uptime_pct": 66.67,
            "checked": 3,
            "expected": 5,
            "unknown": 1,
            "missing": 1,
        }
        assert result["last_check"] == {**UP, "http_status": None, "latency_ms": None}
    assert (await client.get(path(admin_sid))).json()["last_check"] == UP


async def test_incident_pagination_has_no_duplicates_or_skipped_rows(client, monkeypatch):
    await setup_admin(client)
    await enable_global(client)
    sid = await create_service(client)
    await enable_service(client, sid)

    def insert_incidents(conn):
        conn.executemany(
            "INSERT INTO monitor_incidents (id, service_id, started_at, ended_at, end_reason)"
            " VALUES (?, ?, ?, ?, 'recovered')",
            [
                (str(i), sid, FIRST_SLOT + i * 180, FIRST_SLOT + (i + 1) * 180)
                for i in range(INCIDENT_PAGE_SIZE + 2)
            ],
        )

    await client.app.state.hub.db.run(insert_incidents)
    monkeypatch.setattr(monitoring_api, "time", lambda: FIRST_SLOT + (INCIDENT_PAGE_SIZE + 3) * 180)
    result = await client.get(path(sid), params={"before": (1 << 63) - 1})
    assert result.status_code == 200, result.text
    first = result.json()
    assert len(first["incidents"]) == INCIDENT_PAGE_SIZE
    assert first["next_before"] == first["incidents"][-1]["started_at"]
    second = (await client.get(path(sid), params={"before": first["next_before"]})).json()
    assert second["next_before"] is None
    assert [row["id"] for row in first["incidents"] + second["incidents"]] == [
        str(i) for i in reversed(range(INCIDENT_PAGE_SIZE + 2))
    ]

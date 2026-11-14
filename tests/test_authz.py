from __future__ import annotations

import pytest

from tests.conftest import create_user, new_session, setup_admin

pytestmark = pytest.mark.anyio

SERVICE = {"name": "Grafana", "url": "http://grafana.lan:3000", "icon": "chart"}
BOOKMARK = {"name": "Docs", "url": "https://docs.example.org", "color": "#112233"}
BESZEL = {"url": "http://beszel.lan:8090", "username": "me@example.org", "password": "pw"}


async def test_tenant_isolation(client):
    await setup_admin(client)
    await create_user(client, "bob")
    bob = await new_session(client.app, "bob")
    try:
        svc = (await client.post("/api/services", json=SERVICE)).json()["service"]
        bm = (await client.post("/api/bookmarks", json=BOOKMARK)).json()["bookmark"]
        inst = (await client.post("/api/beszel/instances", json=BESZEL)).json()["instance"]
        await client.patch("/api/settings", json={"pageTitle": "Admin's hub"})

        # Bob sees none of it.
        assert (await bob.get("/api/services")).json() == {"services": []}
        assert (await bob.get("/api/bookmarks")).json() == {"bookmarks": []}
        assert (await bob.get("/api/beszel/instances")).json() == {"instances": []}
        boot = (await bob.get("/api/bootstrap")).json()
        assert boot["services"] == [] and boot["settings"]["pageTitle"] == ""
        assert (await bob.get("/api/backup")).json()["services"] == []

        # ...and cannot modify or delete it by id.
        for path, body in (
            (f"/api/services/{svc['id']}", {"name": "pwned"}),
            (f"/api/bookmarks/{bm['id']}", {"name": "pwned"}),
            (f"/api/beszel/instances/{inst['id']}", {"name": "pwned"}),
        ):
            assert (await bob.patch(path, json=body)).status_code == 404
            assert (await bob.delete(path)).status_code == 404
        r = await bob.post("/api/beszel/test", json={"instance_id": inst["id"]})
        assert r.status_code == 404

        # Bob's backup import only replaces Bob's data.
        r = await bob.post("/api/backup", json={"version": 1, "services": [SERVICE]})
        assert r.status_code == 200
        assert [s["name"] for s in (await client.get("/api/services")).json()["services"]] == [
            "Grafana"
        ]
        assert (await client.get("/api/services")).json()["services"][0]["id"] == svc["id"]
    finally:
        await bob.aclose()


async def test_non_admin_is_forbidden_from_admin_routes(client):
    await setup_admin(client)
    await create_user(client, "bob")
    bob = await new_session(client.app, "bob")
    try:
        me = (await bob.get("/api/me")).json()["user"]
        for method, path, body in (
            ("GET", "/api/admin/users", None),
            ("POST", "/api/admin/users", {"email": "x@y.zz", "username": "xx_x", "password": "p"}),
            ("PATCH", f"/api/admin/users/{me['id']}", {"role": "admin"}),
            ("DELETE", f"/api/admin/users/{me['id']}", None),
            ("GET", "/api/admin/config", None),
            ("PUT", "/api/admin/config", {"registration_open": True}),
            ("GET", "/api/stats", None),
        ):
            r = await bob.request(method, path, json=body)
            assert r.status_code == 403, (method, path, r.text)
        assert (await bob.get("/api/me")).json()["user"]["role"] == "user"
    finally:
        await bob.aclose()


async def test_unauthenticated_is_401_everywhere(client):
    for method, path in (
        ("GET", "/api/me"),
        ("GET", "/api/bootstrap"),
        ("GET", "/api/settings"),
        ("GET", "/api/services"),
        ("POST", "/api/services"),
        ("GET", "/api/status"),
        ("GET", "/api/beszel/systems"),
        ("GET", "/api/backup"),
        ("GET", "/api/stats"),
        ("GET", "/api/admin/users"),
    ):
        r = await client.request(method, path, json={} if method == "POST" else None)
        assert r.status_code == 401, (method, path)
        assert r.json()["error"]["code"] == "unauthenticated"


async def test_admin_user_management(client):
    admin = await setup_admin(client)
    bob = await create_user(client, "bob")
    users = (await client.get("/api/admin/users")).json()["users"]
    assert {u["username"] for u in users} == {"admin", "bob"}
    assert all("created_at" in u and "password_hash" not in u for u in users)

    # Duplicate username (case-insensitive) is a conflict.
    r = await client.post(
        "/api/admin/users",
        json={"email": "b2@example.org", "username": "BOB", "password": "long enough pw"},
    )
    assert r.status_code == 409

    # The last admin cannot be demoted or removed.
    r = await client.patch(f"/api/admin/users/{admin['id']}", json={"role": "user"})
    assert r.status_code == 409
    assert (await client.delete(f"/api/admin/users/{admin['id']}")).status_code == 409

    r = await client.patch(f"/api/admin/users/{bob['id']}", json={"role": "admin"})
    assert r.json()["user"]["role"] == "admin"
    r = await client.patch(f"/api/admin/users/{bob['id']}", json={"unknown": 1})
    assert r.status_code == 400
    assert (await client.delete(f"/api/admin/users/{bob['id']}")).status_code == 204
    assert (await client.delete(f"/api/admin/users/{bob['id']}")).status_code == 404
    assert (await client.delete("/api/admin/users/not-a-uuid")).status_code == 404


async def test_stats_for_admin(client):
    await setup_admin(client)
    r = await client.get("/api/stats")
    assert r.status_code == 200
    data = r.json()
    assert set(data) == {"hostname", "cpu", "memory", "disk"}
    assert isinstance(data["hostname"], str)

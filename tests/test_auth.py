from __future__ import annotations

import pytest

from tests.conftest import (
    PASSWORD,
    SETUP_TOKEN,
    create_user,
    new_session,
    running,
    setup_admin,
)

pytestmark = pytest.mark.anyio


async def test_state_and_first_run_setup(client):
    r = await client.get("/api/auth/state")
    assert r.json() == {"setup_required": True, "registration_open": False, "authenticated": False}

    user = await setup_admin(client)
    assert user["role"] == "admin" and user["twofa_enabled"] is False
    assert set(user) == {"id", "email", "username", "role", "twofa_enabled"}

    r = await client.get("/api/auth/state")
    assert r.json() == {"setup_required": False, "registration_open": False, "authenticated": True}
    assert (await client.get("/api/me")).json()["user"]["id"] == user["id"]

    # Setup only works once.
    r = await client.post(
        "/api/auth/setup",
        json={
            "email": "x@example.org",
            "username": "second",
            "password": PASSWORD,
            "setup_token": SETUP_TOKEN,
        },
    )
    assert r.status_code == 409


async def test_setup_validation(client):
    r = await client.post(
        "/api/auth/setup", json={"email": "nope", "username": "a!", "password": "short"}
    )
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "validation"
    assert set(err["fields"]) == {"email", "username", "password", "setup_token"}


async def test_login_by_username_or_email_and_uniform_errors(client):
    await setup_admin(client)
    await client.post("/api/auth/logout")
    assert (await client.get("/api/me")).status_code == 401

    for ident in ("admin", "ADMIN@example.org"):
        r = await client.post("/api/auth/login", json={"identifier": ident, "password": PASSWORD})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["username"] == "admin"

    bad_pw = await client.post("/api/auth/login", json={"identifier": "admin", "password": "x"})
    unknown = await client.post("/api/auth/login", json={"identifier": "ghost", "password": "x"})
    assert bad_pw.status_code == unknown.status_code == 401
    assert bad_pw.json() == unknown.json()
    assert bad_pw.json()["error"]["code"] == "invalid_credentials"


async def test_account_lockout_is_persistent(tmp_path):
    async with running(tmp_path) as c:
        await setup_admin(c)
        await c.post("/api/auth/logout")
        codes = []
        for _ in range(9):
            r = await c.post("/api/auth/login", json={"identifier": "admin", "password": "wrong"})
            codes.append(r.status_code)
        assert codes[:8] == [401] * 8
        assert codes[8] == 429
        assert int(r.headers["Retry-After"]) > 0
        # Even the right password is refused while locked.
        r = await c.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
        assert r.status_code == 429

    # A restart does not clear the lock.
    async with running(tmp_path) as c:
        r = await c.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
        assert r.status_code == 429


async def test_ip_lockout_across_accounts(tmp_path):
    async with running(tmp_path, client_ip="203.0.113.9") as c:
        await setup_admin(c)
        await c.post("/api/auth/logout")
        statuses = []
        for i in range(21):
            r = await c.post(
                "/api/auth/login", json={"identifier": f"user{i}", "password": "wrong"}
            )
            statuses.append(r.status_code)
        assert statuses[-1] == 429


async def test_logout_revokes_session_server_side(client):
    await setup_admin(client)
    cookie = dict(client.cookies)
    assert (await client.post("/api/auth/logout")).status_code == 204
    assert (await client.get("/api/me")).status_code == 401
    # Replaying the old cookie does not work: it was revoked, not just cleared.
    client.cookies.update(cookie)
    r = await client.get("/api/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthenticated"


async def test_session_rotation_on_login(client):
    await setup_admin(client)
    old = client.cookies.get("serverhub_session")
    r = await client.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
    assert r.status_code == 200
    new = client.cookies.get("serverhub_session")
    assert new and new != old
    client.cookies.set("serverhub_session", old)
    assert (await client.get("/api/me")).status_code == 401


async def test_cookie_flags(client):
    r = await client.post(
        "/api/auth/setup",
        json={
            "email": "a@example.org",
            "username": "admin",
            "password": PASSWORD,
            "setup_token": SETUP_TOKEN,
        },
    )
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie
    assert "secure" not in cookie


async def test_secure_cookie_uses_host_prefix(tmp_path):
    async with running(tmp_path, cookie_secure="true", base_url="https://testserver") as c:
        r = await c.post(
            "/api/auth/setup",
            json={
                "email": "a@example.org",
                "username": "admin",
                "password": PASSWORD,
                "setup_token": SETUP_TOKEN,
            },
        )
        assert r.status_code == 200
        assert r.headers["set-cookie"].startswith("__Host-serverhub_session=")
        assert "secure" in r.headers["set-cookie"].lower()
        assert (await c.get("/api/me")).status_code == 200
        assert "strict-transport-security" in r.headers


async def test_password_change_revokes_other_sessions(client):
    await setup_admin(client)
    other = await new_session(client.app, "admin")
    try:
        assert (await other.get("/api/me")).status_code == 200
        r = await client.put(
            "/api/me/password",
            json={"current_password": "nope", "new_password": "another password 1"},
        )
        assert r.status_code == 400
        r = await client.put(
            "/api/me/password",
            json={"current_password": PASSWORD, "new_password": "another password 1"},
        )
        assert r.status_code == 204
        assert (await client.get("/api/me")).status_code == 200  # current kept
        assert (await other.get("/api/me")).status_code == 401  # others revoked
    finally:
        await other.aclose()
    await client.post("/api/auth/logout")
    r = await client.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
    assert r.status_code == 401
    r = await client.post(
        "/api/auth/login", json={"identifier": "admin", "password": "another password 1"}
    )
    assert r.status_code == 200


async def test_registration_closed_by_default_and_switchable(client):
    body = {"email": "u@example.org", "username": "newbie", "password": PASSWORD}
    await setup_admin(client)
    r = await client.post("/api/auth/register", json=body)
    assert r.status_code == 403 and r.json()["error"]["code"] == "registration_closed"

    r = await client.put("/api/admin/config", json={"registration_open": True})
    assert r.json() == {"registration_open": True}
    assert (await client.get("/api/auth/state")).json()["registration_open"] is True

    await client.post("/api/auth/logout")
    r = await client.post("/api/auth/register", json=body)
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "user"
    r = await client.post("/api/auth/register", json={**body, "email": "other@example.org"})
    assert r.status_code == 409  # username taken (case-insensitive unique)


async def test_register_rate_limited(client):
    await setup_admin(client)
    await client.put("/api/admin/config", json={"registration_open": True})
    statuses = []
    for i in range(6):
        r = await client.post(
            "/api/auth/register",
            json={"email": f"u{i}@example.org", "username": f"user_{i}", "password": PASSWORD},
        )
        statuses.append(r.status_code)
    assert statuses[:5] == [200] * 5 and statuses[5] == 429


async def test_admin_password_reset_revokes_target_sessions(client):
    await setup_admin(client)
    bob = await create_user(client, "bob")
    bob_client = await new_session(client.app, "bob")
    try:
        r = await client.patch(
            f"/api/admin/users/{bob['id']}", json={"password": "brand new password"}
        )
        assert r.status_code == 200
        assert (await bob_client.get("/api/me")).status_code == 401
    finally:
        await bob_client.aclose()

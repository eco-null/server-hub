from __future__ import annotations

import time

import pyotp
import pytest

from tests.conftest import PASSWORD, setup_admin

pytestmark = pytest.mark.anyio


async def enable_2fa(client) -> tuple[str, list[str]]:
    r = await client.post("/api/me/2fa/setup")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["otpauth_uri"].startswith("otpauth://totp/")
    assert data["qr_svg"].startswith("<svg") and "style=" not in data["qr_svg"]
    secret = data["secret"]
    r = await client.post("/api/me/2fa/enable", json={"code": "000000"})
    assert r.status_code == 401
    r = await client.post("/api/me/2fa/enable", json={"code": pyotp.TOTP(secret).now()})
    assert r.status_code == 200, r.text
    codes = r.json()["recovery_codes"]
    assert len(codes) == 10 and len(set(codes)) == 10
    return secret, codes


def code_for_next_step(secret: str) -> str:
    """A valid code for a later time step than the one just used (avoids replay)."""
    return pyotp.TOTP(secret).at(time.time() + 30)


async def password_step(client) -> None:
    r = await client.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
    assert r.status_code == 200
    assert r.json() == {"twofa_required": True}
    assert "serverhub_session" not in r.headers.get("set-cookie", "")


async def test_enable_and_login_with_totp(client):
    await setup_admin(client)
    secret, _ = await enable_2fa(client)
    assert (await client.get("/api/me")).json()["user"]["twofa_enabled"] is True
    await client.post("/api/auth/logout")

    await password_step(client)
    # The pending state is not a session.
    assert (await client.get("/api/me")).status_code == 401
    assert (await client.get("/api/bootstrap")).status_code == 401

    code = code_for_next_step(secret)
    r = await client.post("/api/auth/2fa", json={"code": code})
    assert r.status_code == 200, r.text
    assert (await client.get("/api/me")).status_code == 200

    # Replay: the same code cannot be used again, even in a new login.
    await client.post("/api/auth/logout")
    await password_step(client)
    r = await client.post("/api/auth/2fa", json={"code": code})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_code"


async def test_2fa_without_pending_state(client):
    await setup_admin(client)
    await client.post("/api/auth/logout")
    r = await client.post("/api/auth/2fa", json={"code": "123456"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "login_expired"


async def test_recovery_codes_are_single_use(client):
    await setup_admin(client)
    _, codes = await enable_2fa(client)
    await client.post("/api/auth/logout")

    await password_step(client)
    r = await client.post("/api/auth/2fa", json={"code": codes[0].upper()})
    assert r.status_code == 200, r.text
    await client.post("/api/auth/logout")

    await password_step(client)
    r = await client.post("/api/auth/2fa", json={"code": codes[0]})
    assert r.status_code == 401
    r = await client.post("/api/auth/2fa", json={"code": codes[1].replace("-", "")})
    assert r.status_code == 200


async def test_pending_login_attempt_cap(client):
    await setup_admin(client)
    await enable_2fa(client)
    await client.post("/api/auth/logout")
    await password_step(client)
    for _ in range(5):
        r = await client.post("/api/auth/2fa", json={"code": "000000"})
        assert r.status_code in (401, 429)
    r = await client.post("/api/auth/2fa", json={"code": "000000"})
    assert r.status_code in (401, 429)
    assert r.json()["error"]["code"] in ("login_expired", "rate_limited")


async def test_cannot_disable_via_settings(client):
    await setup_admin(client)
    await enable_2fa(client)
    for body in ({"twofa": {"enabled": False}}, {"twofa_enabled": False}):
        r = await client.patch("/api/settings", json=body)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "validation"
    assert (await client.get("/api/me")).json()["user"]["twofa_enabled"] is True
    assert "twofa" not in (await client.get("/api/settings")).json()["settings"]


async def test_disable_requires_valid_code(client):
    await setup_admin(client)
    _secret, codes = await enable_2fa(client)
    r = await client.post("/api/me/2fa/disable", json={"code": "999999"})
    assert r.status_code == 401
    r = await client.post("/api/me/2fa/disable", json={"code": codes[3]})
    assert r.status_code == 204
    assert (await client.get("/api/me")).json()["user"]["twofa_enabled"] is False
    await client.post("/api/auth/logout")
    r = await client.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
    assert "user" in r.json()


async def test_setup_twice_and_enable_without_setup(client):
    await setup_admin(client)
    r = await client.post("/api/me/2fa/enable", json={"code": "123456"})
    assert r.status_code == 409
    await enable_2fa(client)
    assert (await client.post("/api/me/2fa/setup")).status_code == 409


async def test_admin_can_clear_2fa(client):
    await setup_admin(client)
    me = (await client.get("/api/me")).json()["user"]
    await enable_2fa(client)
    r = await client.patch(f"/api/admin/users/{me['id']}", json={"disable_twofa": True})
    assert r.status_code == 200
    assert r.json()["user"]["twofa_enabled"] is False

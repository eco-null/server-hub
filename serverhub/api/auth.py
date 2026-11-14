"""/api/auth/* and /api/me/* endpoints.

Every password, setup-token or second-factor check reserves its rate-limit
slot *before* the check runs (see serverhub.auth.ratelimit), and password
verifications are capped per client address while in flight.
"""

from __future__ import annotations

import hmac

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api.schemas import (
    CodeIn,
    LoginIn,
    PasswordChangeIn,
    SetupIn,
    SignupIn,
    TwofaDisableIn,
    TwofaSetupIn,
)
from serverhub.api.serialize import user_out
from serverhub.auth import sessions, totp
from serverhub.auth.ratelimit import account_id, key
from serverhub.db import repo
from serverhub.errors import ApiError
from serverhub.http import client_limit_ip, hub, json_response, no_content, parse
from serverhub.hub import Hub

TOTP_SETUP_TTL = 10 * 60


def _invalid_credentials() -> ApiError:
    return ApiError(401, "invalid_credentials", "Invalid username/email or password")


def _invalid_code() -> ApiError:
    return ApiError(401, "invalid_code", "That code is not valid")


def _wrong_current_password() -> ApiError:
    return ApiError(
        400,
        "validation",
        "Current password is incorrect",
        fields={"current_password": "incorrect"},
    )


async def verify_second_factor(h: Hub, user: dict, code: str) -> bool:
    """TOTP (single use per time step) or an unused recovery code. Fails closed."""
    enc = user.get("totp_secret_enc")
    if not enc:
        return False
    secret = h.keys.decrypt(enc)
    if secret is None:
        return False
    code = code.strip()
    if totp.is_totp_shape(code):
        step = totp.match_step(secret, code)
        return step is not None and await h.db.run(repo.claim_totp_step, user["id"], step)
    normalized = totp.normalize_recovery_code(code)
    if len(normalized) != 10:
        return False
    return await h.db.run(repo.consume_recovery_code, user["id"], h.keys.hash_code(normalized))


async def state(request: Request) -> Response:
    h = hub(request)

    def _q(conn):
        return repo.count_users(conn), bool(repo.get_config(conn, "registration_open", False))

    users, reg_open = await h.db.run(_q)
    user = await sessions.current_user(request)
    return json_response(
        {
            "setup_required": users == 0,
            "registration_open": reg_open and users > 0,
            "authenticated": user is not None,
        }
    )


def _setup_token_ok(h: Hub, supplied: str) -> bool:
    expected = h.setup_token
    if not expected:
        return False
    return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


async def setup(request: Request) -> Response:
    h = hub(request)
    ip = client_limit_ip(request)
    await h.limiter.reserve(key("setup_ip", ip))  # counted before anything is checked
    body = await parse(request, SetupIn)
    if await h.db.run(repo.count_users) > 0:
        raise ApiError(409, "setup_complete", "Setup has already been completed")
    if not _setup_token_ok(h, body.setup_token):
        raise ApiError(
            403,
            "invalid_setup_token",
            "The setup token is missing or wrong; it is printed in the server log at startup",
        )
    async with h.limiter.inflight(ip):
        pw_hash = await h.passwords.hash(body.password)
    user = await h.db.run(repo.create_first_admin, body.email, body.username, pw_hash)
    if user is None:
        raise ApiError(409, "setup_complete", "Setup has already been completed")
    h.setup_token = None
    response = json_response({"user": user_out(user)})
    await sessions.complete_login(request, response, user)
    return response


async def register(request: Request) -> Response:
    h = hub(request)
    ip = client_limit_ip(request)
    await h.limiter.reserve(key("register_ip", ip))

    def _open(conn):
        return repo.count_users(conn) > 0 and bool(
            repo.get_config(conn, "registration_open", False)
        )

    if not await h.db.run(_open):
        raise ApiError(403, "registration_closed", "Registration is closed")
    body = await parse(request, SignupIn)
    async with h.limiter.inflight(ip):
        pw_hash = await h.passwords.hash(body.password)
    user = await h.db.run(repo.create_user, body.email, body.username, pw_hash, "user")
    response = json_response({"user": user_out(user)})
    await sessions.complete_login(request, response, user)
    return response


async def login(request: Request) -> Response:
    h = hub(request)
    body = await parse(request, LoginIn)
    ip = client_limit_ip(request)
    user = await h.db.run(repo.get_user_by_identifier, body.identifier) if body.identifier else None
    # Username and email resolve to the same user id, so they share one budget;
    # unknown identifiers get a hashed id of the same shape.
    acct = account_id(user, body.identifier)
    ip_key = key("login_ip", ip)
    async with h.limiter.inflight(ip):
        await h.limiter.reserve_and_wait(
            ip_key, key("login_acct_ip", acct, ip), key("login_acct", acct)
        )
        ok = await h.passwords.verify(user["password_hash"] if user else None, body.password)
    if not ok or user is None:
        raise _invalid_credentials()
    await h.limiter.refund(ip_key)
    if h.passwords.needs_rehash(user["password_hash"]):
        await h.db.run(repo.rehash_password, user["id"], await h.passwords.hash(body.password))
    if user["totp_secret_enc"]:
        # Password proven: forget the password-guess counters but keep the 2FA budget.
        await h.limiter.reset(key("login_acct", acct))
        await h.db.run(repo.rate_reset_prefix, key("login_acct_ip", acct) + ":")
        response = json_response({"twofa_required": True})
        await sessions.start_pending(request, response, user)
        return response
    await h.limiter.reset_user(user["id"])
    response = json_response({"user": user_out(user)})
    await sessions.complete_login(request, response, user)
    return response


async def login_2fa(request: Request) -> Response:
    h = hub(request)
    body = await parse(request, CodeIn)
    ip = client_limit_ip(request)
    uid = await sessions.take_pending(request)
    ip_key = key("2fa_ip", ip)
    # The account-wide 2FA limit is hard: only someone who knows the password can hit it.
    await h.limiter.reserve(ip_key, key("2fa_acct", uid))
    user = await h.db.run(repo.get_user, uid)
    if user is None or not await verify_second_factor(h, user, body.code):
        raise _invalid_code()
    await h.limiter.refund(ip_key)
    await h.limiter.reset_user(uid)
    response = json_response({"user": user_out(user)})
    await sessions.complete_login(request, response, user)
    return response


async def logout(request: Request) -> Response:
    response = no_content()
    await sessions.logout(request, response)
    return response


async def me(request: Request) -> Response:
    user = await sessions.require_user(request)
    return json_response({"user": user_out(user)})


async def _check_current_password(request: Request, h: Hub, user: dict, password: str) -> None:
    """Re-authentication for sensitive account changes (reserve first, then verify)."""
    acct_key = key("password_acct", user["id"])
    async with h.limiter.inflight(client_limit_ip(request)):
        await h.limiter.reserve(acct_key)
        ok = await h.passwords.verify(user["password_hash"], password)
    if not ok:
        raise _wrong_current_password()
    await h.limiter.reset(acct_key)


async def change_password(request: Request) -> Response:
    h = hub(request)
    user = await sessions.require_user(request)
    body = await parse(request, PasswordChangeIn)
    await _check_current_password(request, h, user, body.current_password)
    new_hash = await h.passwords.hash(body.new_password)
    await h.db.run(repo.set_password, user["id"], new_hash, sessions.session_hash(request))
    return no_content()


async def twofa_setup(request: Request) -> Response:
    h = hub(request)
    user = await sessions.require_user(request)
    body = await parse(request, TwofaSetupIn)
    if user["totp_secret_enc"]:
        raise ApiError(409, "twofa_enabled", "Two-factor authentication is already enabled")
    await _check_current_password(request, h, user, body.current_password)
    secret = totp.new_secret()
    exp = repo.now_ts() + TOTP_SETUP_TTL
    await h.db.run(repo.set_totp_pending, user["id"], h.keys.encrypt(secret), exp)
    return json_response(totp.provisioning(secret, user["username"]))


async def twofa_enable(request: Request) -> Response:
    h = hub(request)
    user = await sessions.require_user(request)
    body = await parse(request, CodeIn)
    if user["totp_secret_enc"]:
        raise ApiError(409, "twofa_enabled", "Two-factor authentication is already enabled")
    pending = user["totp_pending_enc"]
    secret = h.keys.decrypt(pending) if pending else None
    if secret is None or (user["totp_pending_exp"] or 0) < repo.now_ts():
        raise ApiError(409, "twofa_setup_expired", "Start two-factor setup again")
    acct_key = key("2fa_acct", user["id"])
    await h.limiter.reserve(acct_key)
    step = totp.match_step(secret, body.code)
    if step is None:
        raise _invalid_code()
    codes = totp.new_recovery_codes()
    hashes = [h.keys.hash_code(totp.normalize_recovery_code(c)) for c in codes]
    if not await h.db.run(repo.enable_totp, user["id"], h.keys.encrypt(secret), step, hashes):
        raise ApiError(409, "twofa_enabled", "Two-factor authentication is already enabled")
    await h.limiter.reset(acct_key)
    return json_response({"recovery_codes": codes})


async def twofa_disable(request: Request) -> Response:
    h = hub(request)
    user = await sessions.require_user(request)
    body = await parse(request, TwofaDisableIn)
    if not user["totp_secret_enc"]:
        raise ApiError(409, "twofa_disabled", "Two-factor authentication is not enabled")
    await _check_current_password(request, h, user, body.current_password)
    acct_key = key("2fa_acct", user["id"])
    await h.limiter.reserve(acct_key)
    if not await verify_second_factor(h, user, body.code):
        raise _invalid_code()
    await h.limiter.reset(acct_key)
    await h.db.run(repo.disable_totp, user["id"])
    return no_content()


routes = [
    Route("/api/auth/state", state, methods=["GET"]),
    Route("/api/auth/setup", setup, methods=["POST"]),
    Route("/api/auth/register", register, methods=["POST"]),
    Route("/api/auth/login", login, methods=["POST"]),
    Route("/api/auth/2fa", login_2fa, methods=["POST"]),
    Route("/api/auth/logout", logout, methods=["POST"]),
    Route("/api/me", me, methods=["GET"]),
    Route("/api/me/password", change_password, methods=["PUT"]),
    Route("/api/me/2fa/setup", twofa_setup, methods=["POST"]),
    Route("/api/me/2fa/enable", twofa_enable, methods=["POST"]),
    Route("/api/me/2fa/disable", twofa_disable, methods=["POST"]),
]

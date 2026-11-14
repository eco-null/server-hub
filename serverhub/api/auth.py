"""/api/auth/* and /api/me/* endpoints."""

from __future__ import annotations

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api.schemas import CodeIn, LoginIn, PasswordChangeIn, SignupIn
from serverhub.api.serialize import user_out
from serverhub.auth import sessions, totp
from serverhub.auth.ratelimit import key
from serverhub.db import repo
from serverhub.errors import ApiError
from serverhub.http import client_ip, hub, json_response, no_content, parse
from serverhub.hub import Hub

TOTP_SETUP_TTL = 10 * 60


def _invalid_credentials() -> ApiError:
    return ApiError(401, "invalid_credentials", "Invalid username/email or password")


def _invalid_code() -> ApiError:
    return ApiError(401, "invalid_code", "That code is not valid")


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


async def setup(request: Request) -> Response:
    h = hub(request)
    ip_key = key("setup_ip", client_ip(request))
    await h.limiter.check(ip_key)
    await h.limiter.hit(ip_key)
    body = await parse(request, SignupIn)
    if await h.db.run(repo.count_users) > 0:
        raise ApiError(409, "setup_complete", "Setup has already been completed")
    pw_hash = await h.passwords.hash(body.password)
    user = await h.db.run(repo.create_first_admin, body.email, body.username, pw_hash)
    if user is None:
        raise ApiError(409, "setup_complete", "Setup has already been completed")
    response = json_response({"user": user_out(user)})
    await sessions.complete_login(request, response, user)
    return response


async def register(request: Request) -> Response:
    h = hub(request)
    ip_key = key("register_ip", client_ip(request))
    await h.limiter.check(ip_key)

    def _open(conn):
        return repo.count_users(conn) > 0 and bool(
            repo.get_config(conn, "registration_open", False)
        )

    if not await h.db.run(_open):
        raise ApiError(403, "registration_closed", "Registration is closed")
    await h.limiter.hit(ip_key)
    body = await parse(request, SignupIn)
    pw_hash = await h.passwords.hash(body.password)
    user = await h.db.run(repo.create_user, body.email, body.username, pw_hash, "user")
    response = json_response({"user": user_out(user)})
    await sessions.complete_login(request, response, user)
    return response


async def login(request: Request) -> Response:
    h = hub(request)
    body = await parse(request, LoginIn)
    keys = (key("login_ip", client_ip(request)), key("login_acct", body.identifier))
    await h.limiter.check(*keys)
    user = await h.db.run(repo.get_user_by_identifier, body.identifier) if body.identifier else None
    ok = await h.passwords.verify(user["password_hash"] if user else None, body.password)
    if not ok or user is None:
        await h.limiter.hit(*keys)
        raise _invalid_credentials()
    await h.limiter.reset(keys[1])
    if h.passwords.needs_rehash(user["password_hash"]):
        await h.db.run(repo.rehash_password, user["id"], await h.passwords.hash(body.password))
    if user["totp_secret_enc"]:
        response = json_response({"twofa_required": True})
        await sessions.start_pending(request, response, user)
        return response
    response = json_response({"user": user_out(user)})
    await sessions.complete_login(request, response, user)
    return response


async def login_2fa(request: Request) -> Response:
    h = hub(request)
    body = await parse(request, CodeIn)
    ip_key = key("2fa_ip", client_ip(request))
    await h.limiter.check(ip_key)
    uid = await sessions.take_pending(request)
    acct_key = key("2fa_acct", uid)
    await h.limiter.check(acct_key)
    user = await h.db.run(repo.get_user, uid)
    if user is None or not await verify_second_factor(h, user, body.code):
        await h.limiter.hit(ip_key, acct_key)
        raise _invalid_code()
    await h.limiter.reset(acct_key)
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


async def change_password(request: Request) -> Response:
    h = hub(request)
    user = await sessions.require_user(request)
    body = await parse(request, PasswordChangeIn)
    acct_key = key("password_acct", user["id"])
    await h.limiter.check(acct_key)
    if not await h.passwords.verify(user["password_hash"], body.current_password):
        await h.limiter.hit(acct_key)
        raise ApiError(
            400,
            "validation",
            "Current password is incorrect",
            fields={"current_password": "incorrect"},
        )
    await h.limiter.reset(acct_key)
    new_hash = await h.passwords.hash(body.new_password)
    await h.db.run(repo.set_password, user["id"], new_hash, sessions.session_hash(request))
    return no_content()


async def twofa_setup(request: Request) -> Response:
    h = hub(request)
    user = await sessions.require_user(request)
    if user["totp_secret_enc"]:
        raise ApiError(409, "twofa_enabled", "Two-factor authentication is already enabled")
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
    acct_key = key("2fa_acct", user["id"])
    await h.limiter.check(acct_key)
    pending = user["totp_pending_enc"]
    secret = h.keys.decrypt(pending) if pending else None
    if secret is None or (user["totp_pending_exp"] or 0) < repo.now_ts():
        raise ApiError(409, "twofa_setup_expired", "Start two-factor setup again")
    step = totp.match_step(secret, body.code)
    if step is None:
        await h.limiter.hit(acct_key)
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
    body = await parse(request, CodeIn)
    if not user["totp_secret_enc"]:
        raise ApiError(409, "twofa_disabled", "Two-factor authentication is not enabled")
    acct_key = key("2fa_acct", user["id"])
    await h.limiter.check(acct_key)
    if not await verify_second_factor(h, user, body.code):
        await h.limiter.hit(acct_key)
        raise _invalid_code()
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

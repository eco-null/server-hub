"""Session cookies and the single login function every sign-in path uses."""

from __future__ import annotations

from starlette.requests import Request
from starlette.responses import Response

from serverhub.auth.crypto import hash_token, new_token
from serverhub.db import repo
from serverhub.errors import ApiError, forbidden, unauthenticated
from serverhub.http import hub

PENDING_TTL = 5 * 60
PENDING_MAX_ATTEMPTS = 5


def _names(request: Request) -> tuple[str, str]:
    if hub(request).config.secure_cookies:
        return "__Host-serverhub_session", "__Host-serverhub_2fa"
    return "serverhub_session", "serverhub_2fa"


def _set_cookie(request: Request, response: Response, name: str, value: str, max_age: int) -> None:
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        path="/",
        httponly=True,
        samesite="lax",
        secure=hub(request).config.secure_cookies,
    )


def _clear_cookie(request: Request, response: Response, name: str) -> None:
    response.delete_cookie(
        name, path="/", httponly=True, samesite="lax", secure=hub(request).config.secure_cookies
    )


def session_hash(request: Request) -> str | None:
    token = request.cookies.get(_names(request)[0])
    if not token or len(token) > 128:
        return None
    return hash_token(token)


def pending_hash(request: Request) -> str | None:
    token = request.cookies.get(_names(request)[1])
    if not token or len(token) > 128:
        return None
    return hash_token(token)


async def current_user(request: Request) -> dict | None:
    """The live session's user (cached on the request), or None."""
    state = request.scope["state"]
    if "user" in state:
        return state["user"]
    user = None
    sid = session_hash(request)
    if sid:
        h = hub(request)
        idle = int(h.config.session_idle_days * 86400)
        user = await h.db.run(repo.get_session_user, sid, idle)
    state["user"] = user
    return user


async def require_user(request: Request) -> dict:
    user = await current_user(request)
    if user is None:
        raise unauthenticated()
    return user


async def require_admin(request: Request) -> dict:
    user = await require_user(request)
    if user["role"] != "admin":
        raise forbidden("Admin access required")
    return user


async def complete_login(request: Request, response: Response, user: dict) -> None:
    """Issue a fresh session for ``user``; the only place sessions are created.

    Any session the browser already had is revoked (rotation), and pending
    second-factor state is discarded.
    """
    h = hub(request)
    token = new_token()
    max_age = int(h.config.session_max_days * 86400)
    await h.db.run(
        repo.create_session, hash_token(token), user["id"], max_age, session_hash(request)
    )
    session_cookie, pending_cookie = _names(request)
    _set_cookie(request, response, session_cookie, token, max_age)
    pending = pending_hash(request)
    if pending:
        await h.db.run(repo.delete_pending, pending)
    if pending_cookie in request.cookies:
        _clear_cookie(request, response, pending_cookie)
    request.scope["state"]["user"] = user


async def start_pending(request: Request, response: Response, user: dict) -> None:
    """Password accepted, second factor outstanding: server-side pending state only."""
    h = hub(request)
    token = new_token()
    await h.db.run(
        repo.create_pending, hash_token(token), user["id"], PENDING_TTL, pending_hash(request)
    )
    _set_cookie(request, response, _names(request)[1], token, PENDING_TTL)


async def take_pending(request: Request) -> str:
    """Consume one attempt on the pending login; returns the user id."""
    pending = pending_hash(request)
    uid = None
    if pending:
        uid = await hub(request).db.run(repo.take_pending_attempt, pending, PENDING_MAX_ATTEMPTS)
    if uid is None:
        raise ApiError(
            401, "login_expired", "Your sign-in attempt expired, enter your password again"
        )
    return uid


async def logout(request: Request, response: Response) -> None:
    h = hub(request)
    sid = session_hash(request)
    if sid:
        await h.db.run(repo.delete_session, sid)
    pending = pending_hash(request)
    if pending:
        await h.db.run(repo.delete_pending, pending)
    session_cookie, pending_cookie = _names(request)
    _clear_cookie(request, response, session_cookie)
    _clear_cookie(request, response, pending_cookie)

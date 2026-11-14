"""Admin-only endpoints: user management, registration switch, host stats."""

from __future__ import annotations

import anyio.to_thread
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api import schemas as s
from serverhub.api.data import path_id, reject_nulls
from serverhub.api.serialize import user_out
from serverhub.auth.sessions import require_admin
from serverhub.db import repo, transaction
from serverhub.errors import not_found
from serverhub.http import hub, json_response, no_content, parse
from serverhub.system import stats


async def list_users(request: Request) -> Response:
    await require_admin(request)
    rows = await hub(request).db.run(repo.list_users)
    return json_response({"users": [user_out(u, with_created=True) for u in rows]})


async def create_user(request: Request) -> Response:
    await require_admin(request)
    h = hub(request)
    body = await parse(request, s.AdminUserCreate)
    pw_hash = await h.passwords.hash(body.password)
    user = await h.db.run(repo.create_user, body.email, body.username, pw_hash, body.role)
    return json_response({"user": user_out(user)}, 201)


async def update_user(request: Request) -> Response:
    await require_admin(request)
    h = hub(request)
    uid = path_id(request)
    body = await parse(request, s.AdminUserPatch)
    reject_nulls(body)
    if await h.db.run(repo.get_user, uid) is None:
        raise not_found()
    if body.role is not None:
        await h.db.run(repo.update_role, uid, body.role)
    if body.password is not None:
        # Revokes every session of that user, including the admin's own if
        # they reset their own password here.
        await h.db.run(repo.set_password, uid, await h.passwords.hash(body.password), None)
    if body.disable_twofa:

        def _disable(conn):
            repo.disable_totp(conn, uid)
            with transaction(conn):
                repo.delete_user_sessions(conn, uid)

        await h.db.run(_disable)
    user = await h.db.run(repo.get_user, uid)
    if user is None:
        raise not_found()
    return json_response({"user": user_out(user)})


async def delete_user(request: Request) -> Response:
    await require_admin(request)
    await hub(request).db.run(repo.delete_user, path_id(request))
    return no_content()


async def get_config(request: Request) -> Response:
    await require_admin(request)
    value = await hub(request).db.run(repo.get_config, "registration_open", False)
    return json_response({"registration_open": bool(value)})


async def put_config(request: Request) -> Response:
    await require_admin(request)
    body = await parse(request, s.RegistrationConfig)
    await hub(request).db.run(repo.set_config, "registration_open", body.registration_open)
    return json_response({"registration_open": body.registration_open})


async def host_stats(request: Request) -> Response:
    await require_admin(request)
    return json_response(await anyio.to_thread.run_sync(stats.snapshot))


routes = [
    Route("/api/admin/users", list_users, methods=["GET"]),
    Route("/api/admin/users", create_user, methods=["POST"]),
    Route("/api/admin/users/{id}", update_user, methods=["PATCH"]),
    Route("/api/admin/users/{id}", delete_user, methods=["DELETE"]),
    Route("/api/admin/config", get_config, methods=["GET"]),
    Route("/api/admin/config", put_config, methods=["PUT"]),
    Route("/api/stats", host_stats, methods=["GET"]),
]

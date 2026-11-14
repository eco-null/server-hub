"""Bootstrap, settings, services, bookmarks, status checks and backup."""

from __future__ import annotations

import uuid
from functools import partial

import anyio
from pydantic import BaseModel, ValidationError
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api import schemas as s
from serverhub.api.docker import discovered_statuses
from serverhub.api.serialize import bookmark_out, bootstrap, load_settings, service_out
from serverhub.auth.sessions import require_user
from serverhub.db import repo
from serverhub.errors import not_found, validation
from serverhub.http import hub, json_response, no_content, parse, read_json, validation_from


def canonical_id(raw: object) -> str:
    """A canonical lowercase UUID string, else 404 (no oracle for malformed ids)."""
    if not isinstance(raw, str) or len(raw) > 64:
        raise not_found()
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        raise not_found() from None


def path_id(request: Request) -> str:
    return canonical_id(request.path_params.get("id", ""))


def reject_nulls(model: BaseModel, nullable: frozenset[str] = frozenset()) -> None:
    bad = {
        f: "must not be null"
        for f in model.model_fields_set
        if f not in nullable and getattr(model, f) is None
    }
    if bad:
        raise validation(bad)


# ---- bootstrap / settings -------------------------------------------------------


async def get_bootstrap(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    return json_response(
        await h.db.run(partial(bootstrap, docker_configured=h.docker is not None), user)
    )


async def get_settings(request: Request) -> Response:
    user = await require_user(request)
    return json_response({"settings": await hub(request).db.run(load_settings, user["id"])})


async def patch_settings(request: Request) -> Response:
    user = await require_user(request)
    patch = await read_json(request)
    if not isinstance(patch, dict):
        raise validation({"body": "must be a JSON object"})

    def _merge(conn):
        current = load_settings(conn, user["id"])
        try:
            merged = s.Settings.model_validate(s.deep_merge(current, patch)).model_dump()
        except ValidationError as exc:
            raise validation_from(exc) from None
        repo.put_settings(conn, user["id"], merged)
        return merged

    return json_response({"settings": await hub(request).db.run(_merge)})


async def reset_settings(request: Request) -> Response:
    user = await require_user(request)
    await hub(request).db.run(repo.delete_settings, user["id"])
    return json_response({"settings": dict(s.DEFAULT_SETTINGS)})


# ---- services -------------------------------------------------------------------


def _service_fields(m: BaseModel) -> dict:
    data = m.model_dump(exclude_unset=isinstance(m, s.ServicePatch))
    if "check" in data:
        data["check_enabled"] = 1 if data.pop("check") else 0
    return data


async def list_services(request: Request) -> Response:
    user = await require_user(request)
    rows = await hub(request).db.run(repo.list_owned, "services", user["id"])
    return json_response({"services": [service_out(r) for r in rows]})


async def create_service(request: Request) -> Response:
    user = await require_user(request)
    body = await parse(request, s.ServiceCreate)
    row = await hub(request).db.run(
        repo.insert_owned, "services", user["id"], _service_fields(body), s.MAX_SERVICES
    )
    return json_response({"service": service_out(row)}, 201)


async def update_service(request: Request) -> Response:
    user = await require_user(request)
    sid = path_id(request)
    body = await parse(request, s.ServicePatch)
    reject_nulls(body, frozenset({"category"}))
    row = await hub(request).db.run(
        repo.update_owned, "services", user["id"], sid, _service_fields(body)
    )
    if row is None:
        raise not_found()
    return json_response({"service": service_out(row)})


async def delete_service(request: Request) -> Response:
    user = await require_user(request)
    sid = path_id(request)
    if not await hub(request).db.run(repo.delete_owned, "services", user["id"], sid):
        raise not_found()
    return no_content()


# ---- bookmarks -------------------------------------------------------------------


async def list_bookmarks(request: Request) -> Response:
    user = await require_user(request)
    rows = await hub(request).db.run(repo.list_owned, "bookmarks", user["id"])
    return json_response({"bookmarks": [bookmark_out(r) for r in rows]})


async def create_bookmark(request: Request) -> Response:
    user = await require_user(request)
    body = await parse(request, s.BookmarkCreate)
    row = await hub(request).db.run(
        repo.insert_owned, "bookmarks", user["id"], body.model_dump(), s.MAX_BOOKMARKS
    )
    return json_response({"bookmark": bookmark_out(row)}, 201)


async def update_bookmark(request: Request) -> Response:
    user = await require_user(request)
    bid = path_id(request)
    body = await parse(request, s.BookmarkPatch)
    reject_nulls(body)
    row = await hub(request).db.run(
        repo.update_owned, "bookmarks", user["id"], bid, body.model_dump(exclude_unset=True)
    )
    if row is None:
        raise not_found()
    return json_response({"bookmark": bookmark_out(row)})


async def delete_bookmark(request: Request) -> Response:
    user = await require_user(request)
    bid = path_id(request)
    if not await hub(request).db.run(repo.delete_owned, "bookmarks", user["id"], bid):
        raise not_found()
    return no_content()


# ---- status checks ------------------------------------------------------------------


async def get_status(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    rows = await h.db.run(repo.list_owned, "services", user["id"])
    targets = [(r["id"], r["url"]) for r in rows if r["check_enabled"]]
    statuses: dict[str, dict] = {}

    async def own() -> None:
        # The user's own services: their own fetcher budget and cache.
        statuses.update(await h.status.check_many(user["id"], targets))

    async def discovered() -> None:
        # Discovered Docker services (keyed "docker:<name>"), for users who may see
        # them: one shared identity/budget/cache, never the user's own budget.
        found = await discovered_statuses(h, user)
        statuses.update({k: v for k, v in found.items() if k.startswith("docker:")})

    async with anyio.create_task_group() as tg:
        tg.start_soon(own)
        tg.start_soon(discovered)
    if user["role"] != "admin":
        # State only: HTTP codes and timings of arbitrary targets would make
        # this an internal-network probe for non-admin accounts.
        statuses = {
            sid: {**st, "http_status": None, "latency_ms": None} for sid, st in statuses.items()
        }
    return json_response({"statuses": statuses})


# ---- backup ---------------------------------------------------------------------------


async def export_backup(request: Request) -> Response:
    user = await require_user(request)
    data = await hub(request).db.run(bootstrap, user)
    keep_service = ("name", "url", "description", "icon", "category", "check")
    return json_response(
        {
            "version": 1,
            "exported_at": repo.iso_now(),
            "settings": data["settings"],
            "services": [{k: r[k] for k in keep_service} for r in data["services"]],
            "bookmarks": [{k: r[k] for k in ("name", "url", "color")} for r in data["bookmarks"]],
        }
    )


async def import_backup(request: Request) -> Response:
    user = await require_user(request)
    doc = await parse(request, s.BackupDoc)
    try:
        settings = s.Settings.model_validate(
            s.deep_merge(s.DEFAULT_SETTINGS, doc.settings)
        ).model_dump()
    except ValidationError as exc:
        raise validation(
            {f"settings.{k}": v for k, v in validation_from(exc).fields.items()}  # type: ignore[union-attr]
        ) from None
    services = [_service_fields(x) for x in doc.services]
    bookmarks = [x.model_dump() for x in doc.bookmarks]

    h = hub(request)

    def _replace(conn):
        repo.replace_user_data(conn, user["id"], settings, services, bookmarks)
        return bootstrap(conn, user, docker_configured=h.docker is not None)

    return json_response(await h.db.run(_replace))


routes = [
    Route("/api/bootstrap", get_bootstrap, methods=["GET"]),
    Route("/api/settings", get_settings, methods=["GET"]),
    Route("/api/settings", patch_settings, methods=["PATCH"]),
    Route("/api/settings", reset_settings, methods=["DELETE"]),
    Route("/api/services", list_services, methods=["GET"]),
    Route("/api/services", create_service, methods=["POST"]),
    Route("/api/services/{id}", update_service, methods=["PATCH"]),
    Route("/api/services/{id}", delete_service, methods=["DELETE"]),
    Route("/api/bookmarks", list_bookmarks, methods=["GET"]),
    Route("/api/bookmarks", create_bookmark, methods=["POST"]),
    Route("/api/bookmarks/{id}", update_bookmark, methods=["PATCH"]),
    Route("/api/bookmarks/{id}", delete_bookmark, methods=["DELETE"]),
    Route("/api/status", get_status, methods=["GET"]),
    Route("/api/backup", export_backup, methods=["GET"]),
    Route("/api/backup", import_backup, methods=["POST"]),
]

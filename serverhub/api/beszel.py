"""/api/beszel/* endpoints."""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

from pydantic import ValidationError
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api import schemas as s
from serverhub.api.data import canonical_id, path_id, reject_nulls
from serverhub.api.serialize import beszel_out
from serverhub.auth.sessions import require_user
from serverhub.db import repo
from serverhub.errors import not_found, validation
from serverhub.http import hub, json_response, no_content, parse, read_json, validation_from
from serverhub.integrations.beszel import GENERIC_ERROR, BeszelError, Target

log = logging.getLogger(__name__)


def _default_name(url: str) -> str:
    return (urlsplit(url).hostname or "Beszel")[:200]


def _failed(user: dict, detail: str) -> Response:
    """Admins see why a test failed; other users get one generic message, so the
    endpoint cannot be used to map the internal network (SSRF oracle)."""
    message = detail if user["role"] == "admin" else GENERIC_ERROR
    return json_response({"ok": False, "name": None, "error": message})


async def list_instances(request: Request) -> Response:
    user = await require_user(request)
    rows = await hub(request).db.run(repo.list_owned, "beszel_instances", user["id"])
    return json_response({"instances": [beszel_out(r) for r in rows]})


async def create_instance(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    body = await parse(request, s.BeszelCreate)
    fields = {
        "name": body.name or _default_name(body.url),
        "url": body.url.rstrip("/"),
        "username": body.username,
        "password_enc": h.keys.encrypt(body.password),
    }
    row = await h.db.run(repo.insert_owned, "beszel_instances", user["id"], fields, s.MAX_BESZEL)
    return json_response({"instance": beszel_out(row)}, 201)


async def update_instance(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    iid = path_id(request)
    body = await parse(request, s.BeszelPatch)
    reject_nulls(body)
    fields = body.model_dump(exclude_unset=True)
    if "url" in fields:
        fields["url"] = fields["url"].rstrip("/")
    if "password" in fields:
        fields["password_enc"] = h.keys.encrypt(fields.pop("password"))
    if fields.get("name") == "":
        current = await h.db.run(repo.get_owned, "beszel_instances", user["id"], iid)
        if current is None:
            raise not_found()
        fields["name"] = _default_name(fields.get("url") or current["url"])
    row = await h.db.run(repo.update_owned, "beszel_instances", user["id"], iid, fields)
    if row is None:
        raise not_found()
    h.beszel.forget(iid)
    return json_response({"instance": beszel_out(row)})


async def delete_instance(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    iid = path_id(request)
    if not await h.db.run(repo.delete_owned, "beszel_instances", user["id"], iid):
        raise not_found()
    h.beszel.forget(iid)
    return no_content()


async def test_instance(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    data = await read_json(request)
    if not isinstance(data, dict):
        raise validation({"body": "must be a JSON object"})
    try:
        if "instance_id" in data:
            stored = s.BeszelTestStored.model_validate(data)
            iid = canonical_id(stored.instance_id)
            row = await h.db.run(repo.get_owned, "beszel_instances", user["id"], iid)
            if row is None:
                raise not_found()
            password = h.keys.decrypt(row["password_enc"])
            if password is None:
                return _failed(user, "Stored password cannot be decrypted")
            target = Target(row["url"], row["username"], password)
        else:
            adhoc = s.BeszelTestAdhoc.model_validate(data)
            target = Target(adhoc.url.rstrip("/"), adhoc.username, adhoc.password)
    except ValidationError as exc:
        raise validation_from(exc) from None
    try:
        name, _count = await h.beszel.test(target, user["id"])
    except BeszelError as exc:
        return _failed(user, exc.message)
    except Exception:
        log.warning("Beszel test failed unexpectedly", exc_info=True)
        return _failed(user, GENERIC_ERROR)
    return json_response({"ok": True, "name": name, "error": None})


async def systems(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    rows = await h.db.run(repo.list_owned, "beszel_instances", user["id"])
    pairs = []
    for r in rows:
        password = h.keys.decrypt(r["password_enc"])
        target = Target(r["url"], r["username"], password) if password is not None else None
        pairs.append((r, target))
    results = await h.beszel.fan_out(user["id"], pairs)
    if user["role"] != "admin":
        for r in results:
            if r["error"] is not None:
                r["error"] = GENERIC_ERROR
    return json_response({"instances": results})


routes = [
    Route("/api/beszel/instances", list_instances, methods=["GET"]),
    Route("/api/beszel/instances", create_instance, methods=["POST"]),
    Route("/api/beszel/instances/{id}", update_instance, methods=["PATCH"]),
    Route("/api/beszel/instances/{id}", delete_instance, methods=["DELETE"]),
    Route("/api/beszel/test", test_instance, methods=["POST"]),
    Route("/api/beszel/systems", systems, methods=["GET"]),
]

"""Docker auto-discovery endpoints (read-only).

Discovered services are never stored: they are rebuilt from the (cached)
container list on every request, so they cannot be edited or deleted through
``/api/services/{id}`` (``docker:*`` ids are not UUIDs and answer 404 there)
and are never part of a backup.

No request waits on the Docker API except the first ``/api/docker`` (or
suggestions) call after start-up: the client serves its last good listing
(stale-while-revalidate, bounded by ``MAX_STALE``) while a refresh runs in the
background, and ``/api/status`` never waits at all.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api.serialize import docker_visible
from serverhub.auth.sessions import require_admin, require_user
from serverhub.db import repo
from serverhub.http import hub, json_response
from serverhub.hub import Hub
from serverhub.integrations.docker import DockerError, Listing, discover, status_plan, suggest
from serverhub.integrations.status import not_running, unknown

log = logging.getLogger(__name__)

USER_ERROR = "Docker discovery is unavailable right now"
ADMIN_ERRORS = {
    "connect": (
        "Could not connect to the Docker API; check SERVERHUB_DOCKER_HOST and that the "
        "socket proxy is running"
    ),
    "timeout": "The Docker API did not answer in time",
    "too_large": "The Docker API response was too large",
    "protocol": "The Docker API sent an unexpected response",
    "denied": (
        "The socket proxy refused to list containers; it must allow GET /containers/json "
        "from Server Hub (see compose.yaml)"
    ),
}


def error_message(exc: DockerError, *, admin: bool) -> str:
    if not admin:
        return USER_ERROR
    if exc.kind == "http" and exc.status is not None:
        return f"The Docker API answered HTTP {int(exc.status)}"
    return ADMIN_ERRORS.get(exc.kind, "The Docker API could not be used")


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _may_see(h: Hub, user: dict) -> bool:
    return h.docker is not None and await h.db.run(docker_visible, user)


async def discovered_statuses(h: Hub, user: dict) -> dict[str, dict]:
    """Statuses of the discovered services ``user`` may see ({} when hidden/off).

    Never waits on the Docker API: uses the cached listing (also while it is
    stale), or reports nothing when there is none yet. Outbound checks run under
    the shared discovery identity and cache (see StatusChecker.check_discovered).
    """
    if h.docker is None or not await _may_see(h, user):
        return {}
    got = await h.docker.listing(wait=False)
    if got.containers is None:
        return {}
    targets, fixed = status_plan(discover(got.containers).services)
    out = {sid: (not_running() if state == "down" else unknown()) for sid, state in fixed.items()}
    out.update(await h.status.check_discovered(targets))
    return out


def _unavailable(got: Listing, *, admin: bool) -> dict:
    err = got.error or DockerError("timeout")
    body: dict = {
        "enabled": True,
        "available": False,
        "error": error_message(err, admin=admin),
        "stale": False,
        "updated_at": None,
        "services": [],
    }
    if admin:
        body["skipped"] = []
        body["warnings"] = []
    return body


async def get_docker(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    if h.docker is None or not await _may_see(h, user):
        return json_response(
            {
                "enabled": False,
                "available": False,
                "error": None,
                "stale": False,
                "updated_at": None,
                "services": [],
            }
        )
    admin = user["role"] == "admin"
    got = await h.docker.listing()
    if got.containers is None:
        return json_response(_unavailable(got, admin=admin))
    found = discover(got.containers)
    body = {
        "enabled": True,
        "available": True,
        "error": None,
        "stale": got.stale,
        "updated_at": _iso(got.fetched_at),
        "services": found.services,
    }
    if admin:
        warnings = list(found.warnings)
        if got.stale and got.error is not None and got.fetched_at is not None:
            age = max(0, round(time.time() - got.fetched_at))
            warnings.insert(
                0,
                {
                    "container": "*",
                    "reason": (
                        f"{error_message(got.error, admin=True)}; showing the container list "
                        f"from {age} s ago"
                    ),
                },
            )
        body["skipped"] = found.skipped
        body["warnings"] = warnings
    return json_response(body)


async def get_suggestions(request: Request) -> Response:
    user = await require_admin(request)
    h = hub(request)
    if h.docker is None:
        return json_response({"available": False, "error": None, "suggestions": []})
    got = await h.docker.listing()
    if got.containers is None:
        err = got.error or DockerError("timeout")
        return json_response(
            {"available": False, "error": error_message(err, admin=True), "suggestions": []}
        )
    rows = await h.db.run(repo.list_owned, "services", user["id"])
    suggestions = suggest(
        got.containers,
        public_host=h.config.docker_public_host,
        existing_urls={r["url"] for r in rows},
        exclude_id_prefix=h.docker.self_id_prefix,
    )
    return json_response({"available": True, "error": None, "suggestions": suggestions})


routes = [
    Route("/api/docker", get_docker, methods=["GET"]),
    Route("/api/admin/docker/suggestions", get_suggestions, methods=["GET"]),
]

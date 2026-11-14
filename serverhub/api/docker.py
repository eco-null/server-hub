"""Docker auto-discovery endpoints (read-only).

Discovered services are never stored: they are rebuilt from the (cached)
container list on every request, so they cannot be edited or deleted through
``/api/services/{id}`` (``docker:*`` ids are not UUIDs and answer 404 there)
and are never part of a backup.
"""

from __future__ import annotations

import logging

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api.serialize import docker_visible
from serverhub.auth.sessions import require_admin, require_user
from serverhub.db import repo
from serverhub.http import hub, json_response
from serverhub.hub import Hub
from serverhub.integrations.docker import DockerError, discover, suggest

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
    "denied": ("The socket proxy refused to list containers; enable CONTAINERS=1 on the proxy"),
}


def error_message(exc: DockerError, *, admin: bool) -> str:
    if not admin:
        return USER_ERROR
    if exc.kind == "http" and exc.status is not None:
        return f"The Docker API answered HTTP {int(exc.status)}"
    return ADMIN_ERRORS.get(exc.kind, "The Docker API could not be used")


async def _may_see(h: Hub, user: dict) -> bool:
    return h.docker is not None and await h.db.run(docker_visible, user)


async def discovered_for(h: Hub, user: dict) -> list[dict]:
    """Discovered services ``user`` may see; [] when hidden, off or unreachable."""
    if h.docker is None or not await _may_see(h, user):
        return []
    try:
        return discover(await h.docker.containers()).services
    except DockerError:
        return []


async def get_docker(request: Request) -> Response:
    user = await require_user(request)
    h = hub(request)
    if h.docker is None or not await _may_see(h, user):
        return json_response({"enabled": False, "available": False, "error": None, "services": []})
    admin = user["role"] == "admin"
    try:
        found = discover(await h.docker.containers())
    except DockerError as exc:
        body: dict = {
            "enabled": True,
            "available": False,
            "error": error_message(exc, admin=admin),
            "services": [],
        }
        if admin:
            body["skipped"] = []
            body["warnings"] = []
        return json_response(body)
    body = {"enabled": True, "available": True, "error": None, "services": found.services}
    if admin:
        body["skipped"] = found.skipped
        body["warnings"] = found.warnings
    return json_response(body)


async def get_suggestions(request: Request) -> Response:
    user = await require_admin(request)
    h = hub(request)
    if h.docker is None:
        return json_response({"available": False, "error": None, "suggestions": []})
    try:
        containers = await h.docker.containers()
    except DockerError as exc:
        return json_response(
            {"available": False, "error": error_message(exc, admin=True), "suggestions": []}
        )
    rows = await h.db.run(repo.list_owned, "services", user["id"])
    suggestions = suggest(
        containers,
        public_host=h.config.docker_public_host,
        existing_urls={r["url"] for r in rows},
        exclude_names={h.docker.host},
        exclude_id_prefix=h.docker.self_id_prefix,
    )
    return json_response({"available": True, "error": None, "suggestions": suggestions})


routes = [
    Route("/api/docker", get_docker, methods=["GET"]),
    Route("/api/admin/docker/suggestions", get_suggestions, methods=["GET"]),
]

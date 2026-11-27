"""Service-owner monitoring history and installation-wide opt-in."""

from __future__ import annotations

from time import time

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api.data import path_id
from serverhub.api.schemas import Strict
from serverhub.auth.sessions import require_admin, require_user
from serverhub.db import monitor_history, monitoring
from serverhub.errors import ApiError, not_found, validation
from serverhub.http import hub, json_response, parse

_SQLITE_MAX_INTEGER = (1 << 63) - 1
_ENABLE_ERRORS = {
    "monitoring_disabled": "An admin must enable background monitoring first.",
    "checks_disabled": "Enable status checks for this service first.",
    "monitor_limit": f"This installation can monitor at most {monitoring.MAX_MONITORS} services.",
    "owner_limit": f"You can monitor at most {monitoring.MAX_USER_MONITORS} services.",
}


class MonitoringToggle(Strict):
    enabled: bool


def _before(request: Request) -> int | None:
    values = request.query_params.getlist("before")
    if not values:
        return None
    raw = values[0]
    if len(values) == 1 and len(raw) <= 19 and raw.isascii() and raw.isdecimal():
        value = int(raw)
        if 0 < value <= _SQLITE_MAX_INTEGER:
            return value
    raise validation({"before": "must be a positive integer timestamp"})


async def get_service_monitoring(request: Request) -> Response:
    user = await require_user(request)
    history = await hub(request).db.run(
        monitor_history.read_history,
        user["id"],
        path_id(request),
        monitoring.minute_slot(time()),
        _before(request),
        user["role"] == "admin",
    )
    if history is None:
        raise not_found()
    return json_response(history)


async def put_service_monitoring(request: Request) -> Response:
    user = await require_user(request)
    service_id = path_id(request)
    body = await parse(request, MonitoringToggle)
    now = time()

    def _update(conn):
        try:
            enabled = monitoring.set_service_enabled(
                conn, user["id"], service_id, body.enabled, now
            )
        except ValueError as exc:
            code = str(exc)
            if code not in _ENABLE_ERRORS:
                raise
            raise ApiError(409, code, _ENABLE_ERRORS[code]) from None
        if enabled is None:
            raise not_found()
        return monitor_history.read_history(
            conn, user["id"], service_id, monitoring.minute_slot(now), None, user["role"] == "admin"
        )

    return json_response(await hub(request).db.run(_update))


async def get_admin_monitoring(request: Request) -> Response:
    await require_admin(request)
    enabled = await hub(request).db.run(monitoring.global_enabled)
    return json_response({"enabled": enabled})


async def put_admin_monitoring(request: Request) -> Response:
    await require_admin(request)
    body = await parse(request, MonitoringToggle)
    enabled = await hub(request).db.run(monitoring.set_global_enabled, body.enabled)
    return json_response({"enabled": enabled})


routes = [
    Route("/api/services/{id}/monitoring", get_service_monitoring, methods=["GET"]),
    Route("/api/services/{id}/monitoring", put_service_monitoring, methods=["PUT"]),
    Route("/api/admin/monitoring", get_admin_monitoring, methods=["GET"]),
    Route("/api/admin/monitoring", put_admin_monitoring, methods=["PUT"]),
]

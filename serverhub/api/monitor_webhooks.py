"""Admin configuration for the write-only incident webhook destination."""

from __future__ import annotations

from urllib.parse import urlsplit

from pydantic import field_validator
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from serverhub.api.schemas import ServiceUrl, Strict
from serverhub.auth.sessions import require_admin
from serverhub.db import monitor_webhooks
from serverhub.http import hub, json_response, parse


class WebhookDestination(Strict):
    url: ServiceUrl

    @field_validator("url")
    @classmethod
    def https_destination(cls, value: str) -> str:
        if urlsplit(value).scheme != "https" or "#" in value:
            raise ValueError("must be an HTTPS URL without a fragment")
        return value


async def get_webhook(request: Request) -> Response:
    await require_admin(request)
    return json_response(await hub(request).db.run(monitor_webhooks.read_config))


async def put_webhook(request: Request) -> Response:
    await require_admin(request)
    body = await parse(request, WebhookDestination)
    h = hub(request)
    return json_response(await h.db.run(monitor_webhooks.configure, h.keys.encrypt(body.url)))


async def delete_webhook(request: Request) -> Response:
    await require_admin(request)
    return json_response(await hub(request).db.run(monitor_webhooks.remove))


routes = [
    Route("/api/admin/monitoring/webhook", get_webhook, methods=["GET"]),
    Route("/api/admin/monitoring/webhook", put_webhook, methods=["PUT"]),
    Route("/api/admin/monitoring/webhook", delete_webhook, methods=["DELETE"]),
]

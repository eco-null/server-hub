"""Outermost ASGI middleware: client resolution, CSRF, body limits, headers."""

from __future__ import annotations

import json
from urllib.parse import urlsplit

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from serverhub.config import Config
from serverhub.errors import ApiError
from serverhub.http import resolve_client

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
DEFAULT_BODY_LIMIT = 64 * 1024
LARGE_BODY_LIMITS = {"/api/backup": 4 * 1024 * 1024}

CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data: https:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "manifest-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)
PERMISSIONS_POLICY = (
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), "
    "microphone=(), payment=(), usb=(), interest-cohort=()"
)
BASE_HEADERS = [
    (b"content-security-policy", CSP.encode()),
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"permissions-policy", PERMISSIONS_POLICY.encode()),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
]
HSTS = (b"strict-transport-security", b"max-age=31536000; includeSubDomains")


class BodyTooLarge(ApiError):
    def __init__(self) -> None:
        super().__init__(413, "payload_too_large", "Request body is too large")


def _json_error(status: int, code: str, message: str) -> tuple[int, bytes]:
    return status, json.dumps({"error": {"code": code, "message": message}}).encode()


def _headers(scope: Scope) -> dict[bytes, bytes]:
    return {k.lower(): v for k, v in scope.get("headers", [])}


class SecurityMiddleware:
    def __init__(self, app: ASGIApp, config: Config) -> None:
        self.app = app
        self.config = config

    def _origin_ok(self, origin: str, host: str | None, https: bool) -> bool:
        if origin == "null" or not origin:
            return False
        try:
            o = urlsplit(origin)
        except ValueError:
            return False
        normalized = f"{o.scheme}://{o.netloc}".lower()
        if self.config.public_url and normalized == self.config.public_url:
            return True
        if not host:
            return False
        return normalized == f"{'https' if https else 'http'}://{host.lower()}"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        ip, https = resolve_client(scope, self.config.trusted_proxies)
        state = scope.setdefault("state", {})
        state["client_ip"] = ip
        state["https"] = https
        path: str = scope["path"]
        method: str = scope["method"]
        is_api = path == "/api" or path.startswith("/api/")
        headers = _headers(scope)

        extra = list(BASE_HEADERS)
        if https:
            extra.append(HSTS)

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                hdrs = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() not in {h for h, _ in extra}
                ]
                hdrs.extend(extra)
                if is_api and not any(k.lower() == b"cache-control" for k, _ in hdrs):
                    hdrs.append((b"cache-control", b"no-store"))
                message = {**message, "headers": hdrs}
            await send(message)

        async def reject(status: int, code: str, msg: str) -> None:
            status, body = _json_error(status, code, msg)
            await send_wrapper(
                {
                    "type": "http.response.start",
                    "status": status,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send_wrapper({"type": "http.response.body", "body": body})

        if method not in SAFE_METHODS:
            # CSRF: browsers always send Origin and/or Sec-Fetch-Site on
            # non-GET requests; both absent means a non-browser client.
            origin = headers.get(b"origin", b"").decode("latin-1")
            fetch_site = headers.get(b"sec-fetch-site", b"").decode("latin-1").lower()
            host = headers.get(b"host", b"").decode("latin-1") or None
            if origin:
                if not self._origin_ok(origin, host, https):
                    await reject(403, "csrf", "Cross-origin request blocked")
                    return
            elif fetch_site and fetch_site != "same-origin":
                await reject(403, "csrf", "Cross-origin request blocked")
                return

        limit = LARGE_BODY_LIMITS.get(path, DEFAULT_BODY_LIMIT)
        length = headers.get(b"content-length")
        if length is not None:
            try:
                declared = int(length)
            except ValueError:
                await reject(400, "bad_request", "Invalid Content-Length")
                return
            if declared > limit:
                await reject(413, "payload_too_large", "Request body is too large")
                return
        has_body = (length is not None and length != b"0") or b"transfer-encoding" in headers

        if is_api and method not in SAFE_METHODS:
            ctype = headers.get(b"content-type", b"").decode("latin-1")
            media = ctype.split(";", 1)[0].strip().lower()
            if (has_body or ctype) and media != "application/json":
                await reject(415, "unsupported_media_type", "Content-Type must be application/json")
                return

        received = 0

        async def receive_wrapper() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise BodyTooLarge()
            return message

        await self.app(scope, receive_wrapper, send_wrapper)

"""Application factory and server entry point."""

from __future__ import annotations

import contextlib
import ipaddress
import logging
import secrets
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlsplit

import anyio
from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Match, Route

from serverhub.api import admin as admin_api
from serverhub.api import auth as auth_api
from serverhub.api import beszel as beszel_api
from serverhub.api import data as data_api
from serverhub.api import docker as docker_api
from serverhub.auth.crypto import Keys, Passwords
from serverhub.auth.ratelimit import LONGEST_WINDOW, RateLimiter
from serverhub.config import Config, load_config
from serverhub.db import Database, repo
from serverhub.errors import ApiError
from serverhub.http import validation_from
from serverhub.hub import Hub
from serverhub.integrations.beszel import BeszelClient
from serverhub.integrations.docker import DockerClient
from serverhub.integrations.fetcher import SafeFetcher
from serverhub.integrations.monitoring import MonitoringWorker
from serverhub.integrations.status import DISCOVERY_IDENTITY, DISCOVERY_LIMITS, StatusChecker
from serverhub.middleware import SecurityMiddleware
from serverhub.web import routes as web_routes

log = logging.getLogger("serverhub")


def _error_response(request: Request, status: int, code: str, message: str) -> Response:
    if request.url.path.startswith("/api/") or request.url.path == "/api":
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)
    return Response(message, status_code=status, media_type="text/plain")


async def _api_error(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, ApiError)  # noqa: S101
    return JSONResponse(exc.body(), status_code=exc.status, headers=exc.headers)


async def _validation_error(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, ValidationError)  # noqa: S101
    err = validation_from(exc)
    return JSONResponse(err.body(), status_code=err.status)


async def _http_error(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, HTTPException)  # noqa: S101
    codes = {404: "not_found", 405: "method_not_allowed"}
    code = codes.get(exc.status_code, "http_error")
    msg = {404: "Not found", 405: "Method not allowed"}.get(exc.status_code, str(exc.detail))
    resp = _error_response(request, exc.status_code, code, msg)
    if exc.headers:
        resp.headers.update(exc.headers)
    return resp


async def _server_error(request: Request, exc: Exception) -> Response:
    if isinstance(exc, ClientDisconnect):
        # The client went away (or was cut off by the slow-body timeout).
        return Response(status_code=400)
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return _error_response(request, 500, "internal", "Internal server error")


async def _api_fallback(request: Request) -> Response:
    """Unknown /api path: 404. A known path with the wrong method: 405 (this
    catch-all would otherwise win over Starlette's own 405 for every method it
    lists). OPTIONS on a known path answers 204 with the complete Allow list; left to
    Starlette, the first partial match would report only its own methods."""
    allowed: set[str] = set()
    for route in request.app.router.routes:
        if isinstance(route, Route) and route.endpoint is not _api_fallback:
            match, _ = route.matches(request.scope)
            if match is Match.PARTIAL and route.methods:
                allowed |= route.methods
    if allowed and request.method == "OPTIONS":
        allow = ", ".join(sorted(allowed | {"OPTIONS"}))
        return Response(status_code=204, headers={"Allow": allow})
    if allowed:
        raise ApiError(
            405,
            "method_not_allowed",
            "Method not allowed",
            headers={"Allow": ", ".join(sorted(allowed))},
        )
    raise ApiError(404, "not_found", "Not found")


def _announce_setup_token(token: str, *, from_env: bool) -> None:
    bar = "=" * 72
    if from_env:
        detail = "  The setup token is the value of SERVERHUB_SETUP_TOKEN."
    else:
        detail = (
            f"  FIRST-RUN SETUP TOKEN:  {token}\n"
            "  (a new one is generated at every start until setup is done;\n"
            "   set SERVERHUB_SETUP_TOKEN to choose your own)"
        )
    lines = [
        "",
        bar,
        "  No account exists yet. Open the web UI and create the admin account.",
        detail,
        "  Alternatively: python -m serverhub create-admin --email ... --username ...",
        bar,
    ]
    log.warning("%s", "\n".join(lines))


def startup_warnings(cfg: Config) -> list[str]:
    """Configuration that works but is probably not what the operator wants."""
    out = []
    try:
        loopback = cfg.host in ("localhost", "") or ipaddress.ip_address(cfg.host).is_loopback
    except ValueError:
        loopback = False
    https_url = bool(cfg.public_url and cfg.public_url.startswith("https:"))
    if not loopback and not cfg.tls_enabled and not https_url:
        out.append(
            f"Serving PLAIN HTTP on {cfg.host}:{cfg.port}: passwords and session cookies cross "
            "the network unencrypted. Fine on a trusted LAN/VPN; otherwise set "
            "SERVERHUB_TLS_CERT_FILE and SERVERHUB_TLS_KEY_FILE (see .env.example), or set "
            "SERVERHUB_PUBLIC_URL=https://... if an HTTPS tunnel terminates TLS for you."
        )
    if cfg.secure_cookies and not cfg.tls_enabled and not cfg.trusted_proxies:
        out.append(
            "Secure cookies are on (SERVERHUB_COOKIE_SECURE / https SERVERHUB_PUBLIC_URL) but "
            "this process serves plain HTTP and SERVERHUB_TRUSTED_PROXIES is empty. Browsers "
            "drop Secure cookies on http:// pages, so signing in over plain HTTP will silently "
            "loop back to the login page. Reach the hub only through its https:// URL, enable "
            "TLS here, or set SERVERHUB_COOKIE_SECURE=false."
        )
    return out


def create_app(
    config: Config | None = None,
    *,
    fetcher_options: dict[str, Any] | None = None,
    password_options: dict[str, int] | None = None,
    docker_options: dict[str, Any] | None = None,
) -> Starlette:
    """Build the ASGI app. Keyword options exist for tests (cheap hashing, stub DNS,
    short Docker timeouts)."""
    cfg = config or load_config()

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        db = Database(cfg.db_path)
        fetcher = SafeFetcher(
            allow_private=cfg.allow_private_network_targets,
            identity_limits={DISCOVERY_IDENTITY: DISCOVERY_LIMITS},
            # User- and label-supplied URLs may never reach the Docker API endpoint.
            deny_hosts=[urlsplit(cfg.docker_host).hostname or ""] if cfg.docker_host else (),
            **(fetcher_options or {}),
        )
        hub = Hub(
            config=cfg,
            db=db,
            keys=Keys(cfg.secret_key),
            passwords=Passwords(**(password_options or {})),
            limiter=RateLimiter(db),
            fetcher=fetcher,
            status=StatusChecker(fetcher),
            beszel=BeszelClient(fetcher),
            docker=(
                DockerClient(cfg.docker_host, **(docker_options or {})) if cfg.docker_host else None
            ),
        )
        app.state.hub = hub
        if await db.run(repo.count_users) == 0:
            hub.setup_token = cfg.setup_token or secrets.token_urlsafe(18)
            _announce_setup_token(hub.setup_token, from_env=cfg.setup_token is not None)
        idle = int(cfg.session_idle_days * 86400)

        async def housekeeping() -> None:
            while True:
                try:
                    await db.run(repo.prune, LONGEST_WINDOW, idle)
                except Exception:
                    log.exception("housekeeping failed")
                await anyio.sleep(600 + secrets.randbelow(60))

        try:
            async with anyio.create_task_group() as tg:
                tg.start_soon(housekeeping)
                tg.start_soon(MonitoringWorker(db, hub.status).run)
                if hub.docker is not None:
                    hub.docker.attach(tg)  # background refreshes, never inside a request
                yield
                tg.cancel_scope.cancel()
        finally:
            await fetcher.aclose()
            if hub.docker is not None:
                await hub.docker.aclose()
            db.close()

    routes = [
        *web_routes,
        *auth_api.routes,
        *data_api.routes,
        *beszel_api.routes,
        *docker_api.routes,
        *admin_api.routes,
        Route(
            "/api/{rest:path}",
            _api_fallback,
            methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        ),
    ]
    return Starlette(
        routes=routes,
        middleware=[Middleware(SecurityMiddleware, config=cfg)],
        exception_handlers={
            ApiError: _api_error,
            ValidationError: _validation_error,
            HTTPException: _http_error,
            Exception: _server_error,
        },
        lifespan=lifespan,
    )


def run(config: Config | None = None) -> None:
    import uvicorn

    from serverhub.server import guarded_protocol

    cfg = config or load_config()
    logging.basicConfig(
        level=cfg.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    app = create_app(cfg)
    for warning in startup_warnings(cfg):
        log.warning("%s", warning)
    scheme = "https" if cfg.tls_enabled else "http"
    log.info("Server Hub listening on %s://%s:%d", scheme, cfg.host, cfg.port)
    uvicorn.run(
        app,
        host=cfg.host,
        port=cfg.port,
        ssl_certfile=str(cfg.tls_cert_file) if cfg.tls_cert_file else None,
        ssl_keyfile=str(cfg.tls_key_file) if cfg.tls_key_file else None,
        log_level=cfg.log_level,
        access_log=cfg.log_level == "debug",
        proxy_headers=False,  # X-Forwarded-* is handled by SecurityMiddleware
        server_header=False,
        date_header=True,
        # h11 with slow-client defences: header deadline, body-progress
        # timeout and per-IP / global connection caps (serverhub/server.py).
        http=guarded_protocol(
            max_connections=cfg.max_connections,
            max_per_ip=cfg.max_connections_per_ip,
            exempt=cfg.trusted_proxies,
        ),
        ws="none",
        lifespan="on",
        # Connections are capped by the protocol above; this is only a backstop.
        limit_concurrency=cfg.max_connections + 64,
        backlog=512,
        timeout_keep_alive=5,
        timeout_graceful_shutdown=15,
        h11_max_incomplete_event_size=16 * 1024,
    )

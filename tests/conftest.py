from __future__ import annotations

import contextlib
import json
import threading
from collections.abc import AsyncIterator, Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from serverhub.config import Config
from serverhub.main import create_app

SECRET = "test-secret-key-0123456789-abcdefghijklmnop"
PASSWORD = "correct horse battery"
FAST_HASH = {"time_cost": 1, "memory_cost": 1024, "parallelism": 1}
LOCAL_OK = {"extra_allowed": ["127.0.0.1/32"]}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def make_web(root: Path) -> Path:
    web = root / "web"
    (web / "static" / "css").mkdir(parents=True, exist_ok=True)
    (web / "index.html").write_text("<!doctype html><title>dash</title>")
    (web / "settings.html").write_text("<!doctype html><title>settings</title>")
    (web / "login.html").write_text("<!doctype html><title>login</title>")
    (web / "static" / "app.js").write_text("console.log('hi')")
    (web / "static" / "app.0123abcd.js").write_text("console.log('hashed')")
    (web / "static" / "css" / "main.css").write_text("body{}")
    (web / "static" / ".hidden").write_text("secret")
    (root / "outside.txt").write_text("outside")
    return web


def make_config(tmp_path: Path, **overrides) -> Config:
    values = {
        "secret_key": SECRET,
        "data_dir": tmp_path / "data",
        "web_dir": make_web(tmp_path),
        **overrides,
    }
    return Config(**values)


@contextlib.asynccontextmanager
async def running(
    tmp_path: Path,
    *,
    fetcher_options: dict | None = None,
    client_ip: str = "127.0.0.1",
    base_url: str = "http://testserver",
    **cfg,
) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(
        make_config(tmp_path, **cfg),
        fetcher_options=fetcher_options,
        password_options=FAST_HASH,
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, client=(client_ip, 50000))
        async with httpx.AsyncClient(transport=transport, base_url=base_url) as client:
            client.app = app  # type: ignore[attr-defined]
            yield client


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    async with running(tmp_path, fetcher_options=LOCAL_OK) as c:
        yield c


async def setup_admin(
    c: httpx.AsyncClient, username: str = "admin", email: str = "admin@example.org"
) -> dict:
    r = await c.post(
        "/api/auth/setup", json={"email": email, "username": username, "password": PASSWORD}
    )
    assert r.status_code == 200, r.text
    return r.json()["user"]


async def new_session(app, username: str, password: str = PASSWORD) -> httpx.AsyncClient:
    """A second, independent client (own cookie jar) logged in as ``username``."""
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50001))
    c = httpx.AsyncClient(transport=transport, base_url="http://testserver")
    r = await c.post("/api/auth/login", json={"identifier": username, "password": password})
    assert r.status_code == 200, r.text
    return c


async def create_user(admin: httpx.AsyncClient, username: str, role: str = "user") -> dict:
    r = await admin.post(
        "/api/admin/users",
        json={
            "email": f"{username}@example.org",
            "username": username,
            "password": PASSWORD,
            "role": role,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["user"]


# ---- local stub HTTP servers ----------------------------------------------------

Handler = Callable[[BaseHTTPRequestHandler, bytes], tuple[int, dict, bytes]]


class Stub:
    """A tiny threaded HTTP server with per-path handlers and a request log."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Handler] = {}
        self.log: list[dict] = []
        stub = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _do(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                path = self.path.split("?", 1)[0]
                stub.log.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": dict(self.headers),
                        "body": body,
                    }
                )
                handler = stub.routes.get((self.command, path))
                if handler is None:
                    status, headers, payload = 404, {}, b"not here"
                else:
                    status, headers, payload = handler(self, body)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                if "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_HEAD = _do

            def log_message(self, *args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def route(self, method: str, path: str, status: int = 200, body=b"", headers=None) -> None:
        payload = json.dumps(body).encode() if isinstance(body, dict | list) else body
        hdrs = dict(headers or {})
        if isinstance(body, dict | list):
            hdrs.setdefault("Content-Type", "application/json")
        self.routes[(method, path)] = lambda _h, _b: (status, hdrs, payload)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def stub() -> AsyncIterator[Stub]:
    s = Stub()
    yield s
    s.close()


@pytest.fixture
def stub2() -> AsyncIterator[Stub]:
    s = Stub()
    yield s
    s.close()

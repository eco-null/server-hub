from __future__ import annotations

import pytest

from serverhub.http import resolve_client
from serverhub.middleware import CSP
from tests.conftest import setup_admin

pytestmark = pytest.mark.anyio


async def test_csrf_blocks_cross_origin(client):
    await setup_admin(client)
    svc = {"name": "x", "url": "http://x.lan"}
    bad = [
        {"Origin": "https://evil.example"},
        {"Origin": "null"},
        {"Origin": "http://testserver.evil.example"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
    ]
    for headers in bad:
        r = await client.post("/api/services", json=svc, headers=headers)
        assert r.status_code == 403, headers
        assert r.json()["error"]["code"] == "csrf"
    # Logout is a state change too.
    r = await client.post("/api/auth/logout", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert (await client.get("/api/me")).status_code == 200

    ok = [
        {"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"},
        {"Sec-Fetch-Site": "same-origin"},
        {},  # non-browser client (no Origin, no Fetch Metadata)
    ]
    for headers in ok:
        r = await client.post("/api/services", json=svc, headers=headers)
        assert r.status_code == 201, headers


async def test_public_url_origin_is_accepted(tmp_path):
    from tests.conftest import running

    async with running(tmp_path, public_url="https://hub.example.org") as c:
        r = await c.post(
            "/api/auth/login",
            json={"identifier": "a", "password": "b"},
            headers={"Origin": "https://hub.example.org"},
        )
        assert r.status_code == 401  # passed CSRF, failed credentials


async def test_json_content_type_enforced(client):
    await setup_admin(client)
    r = await client.post(
        "/api/services",
        content=b"name=x&url=http://x",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 415
    r = await client.post(
        "/api/services",
        content=b'{"name":"x","url":"http://x.lan"}',
        headers={"Content-Type": "text/plain"},
    )
    assert r.status_code == 415
    r = await client.post(
        "/api/services",
        content=b'{"name":"x","url":"http://x.lan"}',
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    assert r.status_code == 201
    # Body-less POSTs need no content type.
    assert (await client.post("/api/me/2fa/setup")).status_code == 200


async def test_body_size_limit(client):
    await setup_admin(client)
    big = {"name": "x", "url": "http://x.lan", "description": "a" * 70_000}
    r = await client.post("/api/services", json=big)
    assert r.status_code == 413


async def test_invalid_json(client):
    await setup_admin(client)
    r = await client.post(
        "/api/services", content=b"{nope", headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_json"
    r = await client.post("/api/services", json=[1, 2])
    assert r.status_code == 400


async def test_security_headers(client):
    for path in ("/healthz", "/login", "/api/auth/state", "/static/app.js", "/nope"):
        r = await client.get(path)
        h = r.headers
        assert h["content-security-policy"] == CSP
        assert "'unsafe-inline'" not in h["content-security-policy"]
        assert h["x-content-type-options"] == "nosniff"
        assert h["x-frame-options"] == "DENY"
        assert h["referrer-policy"] == "no-referrer"
        assert "permissions-policy" in h
        assert "strict-transport-security" not in h  # plain HTTP
        assert "server" not in h
    assert (await client.get("/api/auth/state")).headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in CSP and "connect-src 'self'" in CSP


async def test_hsts_only_with_https(tmp_path):
    from tests.conftest import running

    async with running(tmp_path, base_url="https://testserver") as c:
        r = await c.get("/healthz")
        assert r.headers["strict-transport-security"].startswith("max-age=")


async def test_healthz(client):
    r = await client.get("/healthz")
    assert r.status_code == 200 and r.json() == {"status": "ok"}
    r = await client.head("/healthz")
    assert r.status_code == 200 and r.content == b""


async def test_pages_require_session(client):
    for path in ("/", "/settings"):
        r = await client.get(path)
        assert r.status_code == 302 and r.headers["location"] == "/login"
    r = await client.get("/login")
    assert r.status_code == 200 and "login" in r.text
    assert r.headers["content-type"].startswith("text/html")
    await setup_admin(client)
    r = await client.get("/")
    assert r.status_code == 200 and "dash" in r.text
    assert (await client.get("/settings")).status_code == 200
    assert (await client.get("/login")).status_code == 302


async def test_missing_page_is_404(client, tmp_path):
    await setup_admin(client)
    (tmp_path / "web" / "settings.html").unlink()
    assert (await client.get("/settings")).status_code == 404


async def test_static_files_and_caching(client):
    r = await client.get("/static/app.js")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.headers["cache-control"] == "no-cache"
    etag = r.headers["etag"]
    r2 = await client.get("/static/app.js", headers={"If-None-Match": etag})
    assert r2.status_code == 304 and r2.content == b""

    r = await client.get("/static/app.0123abcd.js")
    assert "immutable" in r.headers["cache-control"]
    r = await client.get("/static/css/main.css")
    assert r.headers["content-type"].startswith("text/css")
    assert (await client.head("/static/app.js")).content == b""


async def test_static_traversal_and_hidden(client):
    for path in (
        "/static/../outside.txt",
        "/static/%2e%2e/outside.txt",
        "/static/..%2foutside.txt",
        "/static/.hidden",
        "/static/css",
        "/static/missing.js",
        "/static/..\\outside.txt",
        "/index.html",
        "/web/index.html",
    ):
        r = await client.get(path)
        assert r.status_code == 404, path
        assert "outside" not in r.text


async def test_unknown_api_route_is_json_404(client):
    r = await client.get("/api/does-not-exist")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    r = await client.put("/api/services", json={})
    assert r.status_code in (404, 405)
    assert "error" in r.json()


def test_trusted_proxy_resolution():
    import ipaddress

    trusted = (ipaddress.ip_network("10.0.0.0/8"),)
    scope = {
        "client": ("10.0.0.5", 1),
        "scheme": "http",
        "headers": [
            (b"x-forwarded-for", b"6.6.6.6, 198.51.100.7, 10.0.0.9"),
            (b"x-forwarded-proto", b"https"),
        ],
    }
    assert resolve_client(scope, trusted) == ("198.51.100.7", True)
    # Untrusted peer: headers are ignored.
    scope["client"] = ("198.51.100.1", 1)
    assert resolve_client(scope, trusted) == ("198.51.100.1", False)
    assert resolve_client(scope, ()) == ("198.51.100.1", False)

"""Regression tests for the security review findings (H2-H5, M1-M5, L1-L7, nits)."""

from __future__ import annotations

import ipaddress
import logging

import anyio
import httpx
import pytest

from serverhub.auth import ratelimit
from serverhub.db import repo
from serverhub.http import limit_ip
from serverhub.integrations.fetcher import FetchError, address_allowed, validate_url
from serverhub.integrations.status import StatusChecker
from serverhub.main import startup_warnings
from tests.conftest import (
    CLIENT_HEADERS,
    LOCAL_OK,
    PASSWORD,
    SETUP_TOKEN,
    create_user,
    make_config,
    new_session,
    running,
    setup_admin,
)

pytestmark = pytest.mark.anyio

SIGNUP = {"email": "a@example.org", "username": "admin", "password": PASSWORD}


def client_for(app, ip: str, **kw) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, client=(ip, 40000))
    return httpx.AsyncClient(
        transport=transport, base_url="http://testserver", headers=CLIENT_HEADERS, **kw
    )


# ---- H2a: first-run setup token --------------------------------------------------------


async def test_setup_requires_token(client):
    for body in (SIGNUP, {**SIGNUP, "setup_token": "wrong-token-value"}, {**SIGNUP, "x": 1}):
        r = await client.post("/api/auth/setup", json=body)
        assert r.status_code in (400, 403)
        if "setup_token" in body and "x" not in body:
            assert r.status_code == 403
            assert r.json()["error"]["code"] == "invalid_setup_token"
    assert (await client.get("/api/auth/state")).json()["setup_required"] is True
    r = await client.post("/api/auth/setup", json={**SIGNUP, "setup_token": SETUP_TOKEN})
    assert r.status_code == 200


async def test_setup_token_attempts_are_rate_limited(client):
    codes = []
    for _ in range(11):
        r = await client.post("/api/auth/setup", json={**SIGNUP, "setup_token": "nope" * 5})
        codes.append(r.status_code)
    assert codes[:10] == [403] * 10 and codes[10] == 429
    # Even the right token is refused while that address is locked.
    r = await client.post("/api/auth/setup", json={**SIGNUP, "setup_token": SETUP_TOKEN})
    assert r.status_code == 429


async def test_generated_setup_token_is_logged_and_works(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="serverhub")
    async with running(tmp_path, setup_token=None) as c:
        token = c.app.state.hub.setup_token
        assert token and len(token) >= 20
        assert any(token in rec.getMessage() for rec in caplog.records)
        r = await c.post("/api/auth/setup", json={**SIGNUP, "setup_token": SETUP_TOKEN})
        assert r.status_code == 403
        r = await c.post("/api/auth/setup", json={**SIGNUP, "setup_token": token})
        assert r.status_code == 200
        assert c.app.state.hub.setup_token is None
    caplog.clear()
    # With a user present no token is generated or printed.
    async with running(tmp_path, setup_token=None) as c:
        assert c.app.state.hub.setup_token is None
        assert not any("SETUP TOKEN" in rec.getMessage() for rec in caplog.records)


async def test_env_setup_token_is_not_printed(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger="serverhub")
    async with running(tmp_path) as c:
        assert c.app.state.hub.setup_token == SETUP_TOKEN
    assert not any(SETUP_TOKEN in rec.getMessage() for rec in caplog.records)
    assert any("SERVERHUB_SETUP_TOKEN" in rec.getMessage() for rec in caplog.records)


# ---- H2b: Host allowlist and Origin check ----------------------------------------------


async def test_host_allowlist(tmp_path):
    async with running(
        tmp_path, public_url="https://hub.example.org", allowed_hosts=("hub.lan",)
    ) as c:
        for host in ("evil.rebind.test", "evil.rebind.test:8642", "hub.lan.evil.test", ""):
            r = await c.get("/healthz", headers={"Host": host})
            assert r.status_code == 400, host
            assert r.headers["content-type"].startswith("text/plain")
            assert "SERVERHUB_ALLOWED_HOSTS" in r.text
        for host in (
            "localhost",
            "localhost:8642",
            "127.0.0.1:8642",
            "10.0.0.5",
            "[::1]:8642",
            "hub.lan",
            "HUB.LAN:8642",
            "hub.example.org",
        ):
            r = await c.get("/healthz", headers={"Host": host})
            assert r.status_code == 200, host


async def test_rebinding_setup_is_blocked(client):
    r = await client.post(
        "/api/auth/setup",
        json={**SIGNUP, "setup_token": SETUP_TOKEN},
        headers={"Host": "evil.rebind.test:8655", "Origin": "http://evil.rebind.test:8655"},
    )
    assert r.status_code == 400
    assert (await client.get("/api/auth/state")).json()["setup_required"] is True


async def test_origin_must_match_an_allowed_host(client):
    await setup_admin(client)
    svc = {"name": "x", "url": "http://x.lan"}
    ok = {"Host": "192.168.1.10:8642", "Origin": "http://192.168.1.10:8642"}
    assert (await client.post("/api/services", json=svc, headers=ok)).status_code == 201
    for origin in ("http://192.168.1.11:8642", "https://192.168.1.10:8642", "http://evil.test"):
        r = await client.post(
            "/api/services", json=svc, headers={"Host": "192.168.1.10:8642", "Origin": origin}
        )
        assert r.status_code == 403, origin


# ---- H3: reserve-then-verify -----------------------------------------------------------


async def test_reserve_is_atomic_under_concurrency(tmp_path):
    async with running(tmp_path) as c:
        limiter = c.app.state.hub.limiter
        outcomes: list[str] = []

        async def attempt():
            try:
                await limiter.reserve(ratelimit.key("login_acct_ip", "acct", "1.2.3.4"))
                outcomes.append("ok")
            except Exception as exc:
                outcomes.append(type(exc).__name__)

        async with anyio.create_task_group() as tg:
            for _ in range(60):
                tg.start_soon(attempt)
        assert outcomes.count("ok") == ratelimit.RULES["login_acct_ip"].limit


async def test_login_burst_is_capped(client):
    await setup_admin(client)
    await client.post("/api/auth/logout")
    results: list[int] = []

    async def one(i: int) -> None:
        r = await client.post("/api/auth/login", json={"identifier": "admin", "password": f"w{i}"})
        results.append(r.status_code)

    async with anyio.create_task_group() as tg:
        for i in range(60):
            tg.start_soon(one, i)
    assert set(results) <= {401, 429}
    assert results.count(401) <= ratelimit.RULES["login_acct_ip"].limit, results
    # Sequentially, the budget is still enforced afterwards.
    r = await client.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
    assert r.status_code in (200, 429)


async def test_inflight_password_checks_are_capped_per_ip(tmp_path):
    async with running(tmp_path) as c:
        limiter = c.app.state.hub.limiter
        async with limiter.inflight("1.2.3.4"), limiter.inflight("1.2.3.4"):
            with pytest.raises(Exception, match="rate_limited"):
                async with limiter.inflight("1.2.3.4"):
                    pass
            async with limiter.inflight("5.6.7.8"):
                pass
        async with limiter.inflight("1.2.3.4"):
            pass


# ---- H4: account limits cannot lock the owner out --------------------------------------


async def test_attacker_from_other_ips_cannot_lock_out_owner(client, monkeypatch):
    monkeypatch.setattr(ratelimit, "SOFT_DELAY_STEP", 0.001)
    monkeypatch.setattr(ratelimit, "SOFT_DELAY_MAX", 0.01)
    await setup_admin(client)
    await client.post("/api/auth/logout")
    for n in range(10):
        attacker = client_for(client.app, f"203.0.113.{n + 1}")
        for i in range(8):
            r = await attacker.post(
                "/api/auth/login", json={"identifier": "admin", "password": f"x{i}"}
            )
            assert r.status_code == 401
        r = await attacker.post("/api/auth/login", json={"identifier": "admin", "password": "y"})
        assert r.status_code == 429  # that attacker address is locked
        await attacker.aclose()
    # 80 failures for the account, yet the owner (other address) still gets in.
    r = await client.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
    assert r.status_code == 200, r.text


async def test_username_and_email_share_one_budget(client):
    await setup_admin(client)
    await client.post("/api/auth/logout")
    codes = []
    for i in range(9):
        ident = "admin" if i % 2 else "ADMIN@Example.org"
        r = await client.post("/api/auth/login", json={"identifier": ident, "password": "bad"})
        codes.append(r.status_code)
    assert codes[:8] == [401] * 8 and codes[8] == 429


async def test_unknown_user_gets_same_shape_and_budget(client):
    await setup_admin(client)
    await client.post("/api/auth/logout")
    ghost = [
        await client.post("/api/auth/login", json={"identifier": "Ghost", "password": "x"})
        for _ in range(9)
    ]
    assert [r.status_code for r in ghost] == [401] * 8 + [429]
    assert (
        ghost[0].json()
        == (
            await client.post("/api/auth/login", json={"identifier": "admin", "password": "x"})
        ).json()
    )


async def test_success_resets_all_account_keys(client):
    await setup_admin(client)
    me = (await client.get("/api/me")).json()["user"]
    await client.post("/api/auth/logout")
    other = client_for(client.app, "203.0.113.50")
    for _ in range(5):
        await other.post("/api/auth/login", json={"identifier": "admin", "password": "bad"})
        await client.post("/api/auth/login", json={"identifier": "admin", "password": "bad"})
    r = await client.post("/api/auth/login", json={"identifier": "admin", "password": PASSWORD})
    assert r.status_code == 200
    rows = await client.app.state.hub.db.run(
        lambda conn: [k for (k,) in conn.execute("SELECT key FROM rate_limits")]
    )
    assert not [k for k in rows if me["id"] in k], rows
    await other.aclose()


# ---- M1: deep JSON ---------------------------------------------------------------------


async def test_deeply_nested_json_is_rejected(client):
    for depth in (33, 30_000):  # 30k stays under the 64 KiB body cap
        body = b"[" * depth + b"]" * depth
        r = await client.post(
            "/api/auth/login", content=body, headers={"Content-Type": "application/json"}
        )
        assert r.status_code == 400, depth
        assert r.json()["error"]["code"] == "invalid_json"
    nested = b'{"a":' * 30 + b"1" + b"}" * 30
    r = await client.post(
        "/api/auth/login", content=nested, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "validation"


# ---- M2: malformed URLs ----------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://\x80/",
        "http://exa­mple.com/",
        "http://example.com:0/",
        "http://ex\x07ample.com/",
        "http://[::1/",
        "http://xn--/",
    ],
)
async def test_bad_hosts_are_rejected_at_input(client, url):
    await setup_admin(client)
    r = await client.post("/api/services", json={"name": "x", "url": url})
    assert r.status_code == 400, url
    assert set(r.json()["error"]["fields"]) == {"url"}


async def test_existing_bad_rows_do_not_break_status_or_beszel(client):
    await setup_admin(client)
    me = (await client.get("/api/me")).json()["user"]
    h = client.app.state.hub
    good = (await client.post("/api/services", json={"name": "ok", "url": "http://x.lan"})).json()
    for url in ("http://\x80/", "http://exa­mple.com/", "http://h:0/"):
        await h.db.run(
            repo.insert_owned,
            "services",
            me["id"],
            {"name": "bad", "url": url, "icon": "box", "check_enabled": 1},
            500,
        )
        await h.db.run(
            repo.insert_owned,
            "beszel_instances",
            me["id"],
            {"name": "b", "url": url, "username": "u", "password_enc": h.keys.encrypt("p")},
            20,
        )
    r = await client.get("/api/status")
    assert r.status_code == 200
    assert len(r.json()["statuses"]) == 4
    assert good["service"]["id"] in r.json()["statuses"]
    r = await client.get("/api/beszel/systems")
    assert r.status_code == 200
    assert all(i["ok"] is False and i["error"] for i in r.json()["instances"])


async def test_unexpected_fetcher_error_becomes_fetch_error(monkeypatch):
    from serverhub.integrations.fetcher import SafeFetcher

    f = SafeFetcher(allow_private=True, **LOCAL_OK)

    def boom(*a, **k):
        raise KeyError("library bug")

    monkeypatch.setattr(f._client, "build_request", boom)
    with pytest.raises(FetchError) as info:
        await f.request("GET", "http://127.0.0.1:9/", user_id="u")
    assert info.value.kind == "protocol"
    await f.aclose()


async def test_status_sweep_survives_one_crashing_check():
    class Fetcher:
        async def request(self, method, url, **kw):
            if "boom" in url:
                raise RuntimeError("unexpected")
            raise FetchError("connect")

    checker = StatusChecker(Fetcher())  # type: ignore[arg-type]
    out = await checker.check_many("u", [("a", "http://boom/"), ("b", "http://fine/")])
    assert out["a"]["state"] == "unknown" and out["b"]["state"] == "down"


# ---- M3: Beszel URL shape and non-admin error collapsing -------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.5:8090/internal?confirm=1",
        "http://10.0.0.5:8090/#",
        "http://10.0.0.5:8090/?",
        "http://u:p@10.0.0.5:8090",
        "http://10.0.0.5:8090/a/../b",
        "http://10.0.0.5:8090/a%2fb",
    ],
)
async def test_beszel_url_shape(client, url):
    await setup_admin(client)
    r = await client.post(
        "/api/beszel/instances", json={"url": url, "username": "u", "password": "p"}
    )
    assert r.status_code == 400, url
    r = await client.post("/api/beszel/test", json={"url": url, "username": "u", "password": "p"})
    assert r.status_code == 400, url
    r = await client.post(
        "/api/beszel/instances",
        json={"url": "https://beszel.lan:8090/prefix/", "username": "u", "password": "p"},
    )
    assert r.status_code == 201


async def test_beszel_stored_query_is_dropped_when_joining(stub):
    from serverhub.integrations.beszel import base_url

    assert base_url("http://h:1/pre/?x=1#y") == "http://h:1/pre"
    assert base_url("http://h:1") == "http://h:1"


async def test_non_admin_gets_generic_beszel_errors_and_no_status_detail(tmp_path, stub):
    stub.route("GET", "/up", 200, b"ok")
    async with running(tmp_path, fetcher_options=LOCAL_OK) as admin:
        await setup_admin(admin)
        await create_user(admin, "bob")
        bob = await new_session(admin.app, "bob")
        try:
            details = set()
            for target in (stub.url, "http://127.0.0.1:1", "http://169.254.169.254"):
                r = await bob.post(
                    "/api/beszel/test", json={"url": target, "username": "u", "password": "p"}
                )
                assert r.status_code == 200 and r.json()["ok"] is False
                details.add(r.json()["error"])
            assert len(details) == 1
            r = await admin.post(
                "/api/beszel/test",
                json={"url": "http://169.254.169.254", "username": "u", "password": "p"},
            )
            assert r.json()["error"] == "That address is not allowed"

            await bob.post("/api/services", json={"name": "s", "url": stub.url + "/up"})
            st = next(iter((await bob.get("/api/status")).json()["statuses"].values()))
            assert st["state"] == "up"
            assert st["http_status"] is None and st["latency_ms"] is None
            await admin.post("/api/services", json={"name": "s", "url": stub.url + "/up"})
            st = next(iter((await admin.get("/api/status")).json()["statuses"].values()))
            assert st["http_status"] == 200 and isinstance(st["latency_ms"], int)
        finally:
            await bob.aclose()


# ---- M4: no compressed responses -------------------------------------------------------


async def test_fetcher_asks_for_identity_encoding(stub):
    from serverhub.integrations.fetcher import SafeFetcher

    stub.route("GET", "/x", 200, b"ok")
    f = SafeFetcher(allow_private=True, **LOCAL_OK)
    try:
        await f.request("GET", stub.url + "/x", user_id="u")
    finally:
        await f.aclose()
    assert stub.log[-1]["headers"]["Accept-Encoding"] == "identity"


# ---- M5: client address normalisation --------------------------------------------------


def test_limit_ip_normalisation():
    assert limit_ip("::ffff:198.51.100.7") == "198.51.100.7"
    assert limit_ip("2001:db8:1:2:aaaa::1") == limit_ip("2001:db8:1:2:bbbb::9")
    assert limit_ip("2001:db8:1:2::1") != limit_ip("2001:db8:1:3::1")
    assert limit_ip("198.51.100.7") == "198.51.100.7"


async def test_ipv6_rotation_within_a_64_shares_the_ip_budget(client):
    await setup_admin(client)
    await client.post("/api/auth/logout")
    codes = []
    for i in range(21):
        c = client_for(client.app, f"2001:db8:5:6::{i + 1:x}")
        r = await c.post("/api/auth/login", json={"identifier": f"user{i}", "password": "x"})
        codes.append(r.status_code)
        await c.aclose()
    assert codes[-1] == 429


# ---- L1: custom header for cookie-bearing requests without Origin ----------------------


async def test_cookie_requests_without_origin_need_client_header(client):
    await setup_admin(client)
    svc = {"name": "x", "url": "http://x.lan"}
    bare = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=client.app, client=("127.0.0.1", 1)),
        base_url="http://testserver",
        cookies=client.cookies,
    )
    try:
        r = await bare.post("/api/services", json=svc)
        assert r.status_code == 403 and r.json()["error"]["code"] == "csrf"
        r = await bare.post("/api/services", json=svc, headers={"X-ServerHub-Client": "web"})
        assert r.status_code == 201
        r = await bare.post("/api/services", json=svc, headers={"Sec-Fetch-Site": "same-origin"})
        assert r.status_code == 201
        bare.cookies.clear()
        r = await bare.post("/api/auth/login", json={"identifier": "a", "password": "b"})
        assert r.status_code == 401  # no cookie: non-browser clients need nothing extra
    finally:
        await bare.aclose()


# ---- L3: session cap and pruning -------------------------------------------------------


async def test_sessions_per_user_are_capped(client):
    await setup_admin(client)
    me = (await client.get("/api/me")).json()["user"]
    first_cookie = client.cookies.get("serverhub_session")
    for _ in range(repo.MAX_SESSIONS_PER_USER + 3):
        c = await new_session(client.app, "admin")
        await c.aclose()
    n = await client.app.state.hub.db.run(
        lambda conn: conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE user_id = ?", (me["id"],)
        ).fetchone()[0]
    )
    assert n == repo.MAX_SESSIONS_PER_USER
    client.cookies.set("serverhub_session", first_cookie)
    assert (await client.get("/api/me")).status_code == 401  # the oldest went first


def test_prune_removes_expired_and_idle_rows(tmp_path):
    from serverhub.db import Database

    db = Database(tmp_path / "x.db")
    now = repo.now_ts()
    uid = db.call(repo.create_user, "p@example.org", "pruner", "h", "user")["id"]

    def seed(conn):
        conn.execute("INSERT INTO sessions VALUES ('expired', ?, 0, ?, ?)", (uid, now, now - 1))
        conn.execute(
            "INSERT INTO sessions VALUES ('idle', ?, 0, ?, ?)", (uid, now - 99_999, now + 999)
        )
        conn.execute("INSERT INTO sessions VALUES ('live', ?, 0, ?, ?)", (uid, now, now + 999))
        conn.execute("INSERT INTO pending_logins VALUES ('p', ?, ?, 0)", (uid, now - 1))
        conn.execute("INSERT INTO rate_limits VALUES ('login_ip:x', 3, ?, 0)", (now - 99_999,))
        conn.execute("INSERT INTO rate_limits VALUES ('login_ip:y', 3, ?, 0)", (now,))

    db.call(seed)
    db.call(repo.prune, ratelimit.LONGEST_WINDOW, 3600)
    left = db.call(
        lambda conn: (
            [r[0] for r in conn.execute("SELECT id_hash FROM sessions")],
            conn.execute("SELECT COUNT(*) FROM pending_logins").fetchone()[0],
            [r[0] for r in conn.execute("SELECT key FROM rate_limits")],
        )
    )
    db.close()
    assert left == (["live"], 0, ["login_ip:y"])


# ---- L4: status cache is per user ------------------------------------------------------


async def test_status_cache_is_keyed_by_user():
    calls: list[str] = []

    class Fetcher:
        async def request(self, method, url, *, user_id, **kw):
            calls.append(user_id)
            raise FetchError("connect")

    checker = StatusChecker(Fetcher())  # type: ignore[arg-type]
    await checker.check_one("http://x.lan/", "alice")
    await checker.check_one("http://x.lan/", "alice")
    await checker.check_one("http://x.lan/", "bob")
    assert calls == ["alice", "bob"]


# ---- H5 / L7: startup warnings ---------------------------------------------------------


def test_startup_warnings(tmp_path):
    assert startup_warnings(make_config(tmp_path, host="127.0.0.1")) == []
    plain = startup_warnings(make_config(tmp_path, host="0.0.0.0"))
    assert len(plain) == 1 and "PLAIN HTTP" in plain[0]
    tunnel = startup_warnings(make_config(tmp_path, public_url="https://hub.example.org"))
    assert len(tunnel) == 1 and "loop" in tunnel[0]
    forced = startup_warnings(make_config(tmp_path, host="127.0.0.1", cookie_secure="true"))
    assert len(forced) == 1 and "Secure cookies" in forced[0]
    proxied = make_config(
        tmp_path, public_url="https://hub.example.org", trusted_proxies="10.0.0.0/8"
    )
    assert startup_warnings(proxied) == []


# ---- nits ------------------------------------------------------------------------------


@pytest.mark.parametrize("addr", ["::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "5f00::1", "5f00:1::"])
def test_translated_and_srv6_forms_are_blocked(addr):
    ip = ipaddress.ip_address(addr)
    assert not address_allowed(ip, allow_private=True)


@pytest.mark.parametrize("url", ["http://example.com:0/", "http://\x80/", "http://a​b.com/"])
def test_validate_url_rejects_unparseable(url):
    with pytest.raises(FetchError):
        validate_url(url)


def test_config_allowed_hosts_parsing(tmp_path, monkeypatch):
    from serverhub.config import ConfigError, load_config

    monkeypatch.setenv("SERVERHUB_SECRET_KEY", "k" * 40)
    monkeypatch.setenv("SERVERHUB_ALLOWED_HOSTS", " Hub.LAN , dash.example.org.,")
    cfg = load_config()
    assert cfg.allowed_hosts == ("hub.lan", "dash.example.org")
    assert {"localhost", "hub.lan", "dash.example.org"} <= cfg.host_allowlist
    monkeypatch.setenv("SERVERHUB_ALLOWED_HOSTS", "http://hub.lan:8642")
    with pytest.raises(ConfigError, match="SERVERHUB_ALLOWED_HOSTS"):
        load_config()

"""Regression tests for the security review of Docker auto-discovery.

H1/L5/L6 socket proxy configuration, M1 shared status-check identity and cap,
L1 the Docker endpoint is never a fetch target, L2/N7 stale-while-revalidate,
L3 no credentials in service URLs, N1 duplicate ids, N2 self-exclusion,
N3 URL normalisation, and the skip-reason fixes.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import anyio
import httpx
import pytest
from pydantic import BaseModel, ConfigDict, field_validator

from serverhub.api import docker as d_api
from serverhub.integrations import docker as d
from serverhub.integrations import status as status_mod
from serverhub.integrations.fetcher import FetchError, SafeFetcher
from tests.conftest import (
    LOCAL_OK,
    Stub,
    create_user,
    new_session,
    running,
    setup_admin,
)
from tests.test_docker import FAST, container, labelled, serve

pytestmark = pytest.mark.anyio

ROOT = Path(__file__).resolve().parent.parent


# ---- H1 / L5 / L6: the socket proxy is an exact allow-list ------------------------------


def compose_service(name: str) -> str:
    """The text of one service block in compose.yaml (no YAML parser in the deps)."""
    text = (ROOT / "compose.yaml").read_text(encoding="utf-8")
    m = re.search(rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  \S|^\S)", text)
    assert m, f"service {name} not found in compose.yaml"
    # Without comment lines and trailing comments, so prose cannot satisfy or break a check.
    lines = (re.sub(r"\s+#\s.*$", "", ln) for ln in m.group(1).splitlines())
    return "\n".join(ln for ln in lines if not ln.lstrip().startswith("#")) + "\n"


def proxy_rules() -> dict[str, list[str]]:
    rules: dict[str, list[str]] = {}
    for method, rx in re.findall(
        r'^\s+- "-allow([A-Z]+)=(.*?)"', compose_service("docker-proxy"), re.M
    ):
        rules.setdefault(method, []).append(rx)
    return rules


def proxy_allows(method: str, path: str) -> bool:
    """wollomatic/socket-proxy semantics: per-method regexes, anchored ^...$, URL path only."""
    return any(re.fullmatch(rx, path) for rx in proxy_rules().get(method, []))


def test_compose_proxy_is_wollomatic_with_one_get_rule():
    block = compose_service("docker-proxy")
    assert re.search(r"^    image: wollomatic/socket-proxy:\d+\.\d+\.\d+$", block, re.M)
    assert proxy_rules() == {"GET": ["/(v[0-9.]+/)?containers/json"]}
    assert '"-allowfrom=server-hub"' in block
    assert '"-listenip=0.0.0.0"' in block and '"-proxyport=2375"' in block
    # Non-root with the socket's group; the fallback is nobody's group, never root.
    assert 'user: "65534:${DOCKER_GID:-65534}"' in block
    assert "read_only: true" in block and "no-new-privileges:true" in block
    assert re.search(r"cap_drop:\n\s+- ALL", block) and "cap_add" not in block
    assert not re.search(r"^    (ports|expose|tmpfs|cap_add|privileged):", block, re.M)
    assert re.search(r"^    pids_limit: 32$", block, re.M)
    assert 'GOMAXPROCS: "2"' in block
    assert 'test: ["CMD", "/healthcheck"]' in block and '"-allowhealthcheck"' in block
    assert "- /var/run/docker.sock:/var/run/docker.sock:ro" in block
    assert 'profiles: ["docker"]' in block
    hub = compose_service("server-hub")
    assert "docker.sock" not in hub and "depends_on" not in hub
    assert "lscr.io/linuxserver" not in (ROOT / "compose.yaml").read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("method", "path", "allowed"),
    [
        ("GET", "/containers/json", True),
        ("GET", "/v1.47/containers/json", True),
        ("GET", "/containers/abc/json", False),  # inspect: env vars, mounts
        ("GET", "/v1.47/containers/abc/json", False),
        ("GET", "/containers/abc/stats", False),
        ("GET", "/containers/abc/logs", False),
        ("GET", "/containers/abc/attach/ws", False),
        ("GET", "/containers/json/", False),
        ("GET", "/containers/json/../abc/json", False),
        ("GET", "/x/containers/json", False),
        ("GET", "/images/json", False),
        ("GET", "/version", False),
        ("GET", "/info", False),
        ("GET", "/_ping", False),
        ("HEAD", "/containers/json", False),
        ("POST", "/containers/create", False),
        ("POST", "/containers/abc/stop", False),
        ("DELETE", "/containers/abc", False),
    ],
)
def test_proxy_allow_list(method, path, allowed):
    assert proxy_allows(method, path) is allowed


async def test_client_request_passes_the_allow_list(stub):
    serve(stub, [])
    client = d.DockerClient(stub.url)
    try:
        await client.containers()
    finally:
        await client.aclose()
    (req,) = stub.log
    path, _, query = req["path"].partition("?")
    assert req["method"] == "GET" and query == "all=true"
    assert proxy_allows("GET", path)  # the proxy matches the path only, not the query


# ---- M1: one identity, budget and cache for discovered services; cap; running only ------


def _hits(stub: Stub, prefix: str) -> int:
    return sum(1 for e in stub.log if e["path"].startswith(prefix))


async def test_labelled_containers_cannot_starve_a_users_own_checks(tmp_path, docker_stub, stub2):
    """The reviewer's scenario: 300 labelled containers vs. one user's own service."""
    many = [labelled(f"amp{i:03d}", url=f"{stub2.url}/p{i}") for i in range(300)]
    serve(docker_stub, many)
    # A tight per-user budget makes starvation deterministic if it were possible.
    fetcher = {**LOCAL_OK, "per_user_per_minute": 20}
    async with running(
        tmp_path, fetcher_options=fetcher, docker_host=docker_stub.url, docker_options=FAST
    ) as admin:
        await setup_admin(admin)
        await create_user(admin, "bob")
        await admin.put("/api/admin/config", json={"docker_visible_to_users": True})
        bob = await new_session(admin.app, "bob")
        try:
            r = await bob.post("/api/services", json={"name": "Mine", "url": stub2.url + "/mine"})
            mine = r.json()["service"]["id"]
            await bob.get("/api/docker")
            for _ in range(3):
                st = (await bob.get("/api/status")).json()["statuses"]
                assert st[mine]["state"] == "up"
            states = [st[f"docker:amp{i:03d}"]["state"] for i in range(300)]
            assert states[:100] == ["up"] * 100  # sorted by name: the first 100 are checked
            assert states[100:] == ["unknown"] * 200  # over the cap: no request
            assert _hits(stub2, "/p") == 100  # each URL once, across all three sweeps
            assert _hits(stub2, "/mine") == 1

            # Another viewer shares the cache: no new outbound requests.
            st_admin = (await admin.get("/api/status")).json()["statuses"]
            assert st_admin["docker:amp000"]["state"] == "up"
            assert st_admin["docker:amp000"]["http_status"] == 404  # admin detail
            assert st["docker:amp000"]["http_status"] is None  # stripped for users
            assert _hits(stub2, "/p") == 100

            # The cap is an admin warning.
            warnings = (await admin.get("/api/docker")).json()["warnings"]
            assert any("first 100" in w["reason"] and "200" in w["reason"] for w in warnings)
            assert "warnings" not in (await bob.get("/api/docker")).json()
        finally:
            await bob.aclose()


async def test_not_running_is_down_without_a_request(tmp_path, docker_stub, stub2):
    stopped = labelled("stopped", url=stub2.url + "/stopped")
    stopped.update(State="exited", Status="Exited (0) 1 minute ago")
    paused = labelled("paused", url=stub2.url + "/paused")
    paused.update(State="paused")
    off = labelled("off", url=stub2.url + "/off", check="false")
    off.update(State="exited")
    serve(docker_stub, [stopped, paused, off])
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=docker_stub.url, docker_options=FAST
    ) as c:
        await setup_admin(c)
        await c.get("/api/docker")
        st = (await c.get("/api/status")).json()["statuses"]
        assert set(st) == {"docker:stopped", "docker:paused"}  # check=false: not reported
        for sid in ("docker:stopped", "docker:paused"):
            assert st[sid]["state"] == "down" and st[sid]["http_status"] is None
            assert st[sid]["checked_at"]
        assert stub2.log == []


def test_status_plan_unit():
    svcs = d.discover([labelled(f"s{i:03d}") for i in range(d.MAX_DISCOVERED_CHECKS + 3)]).services
    targets, fixed = d.status_plan(svcs)
    assert len(targets) == d.MAX_DISCOVERED_CHECKS
    assert fixed == {f"docker:s{i:03d}": "unknown" for i in range(100, 103)}


async def test_concurrent_viewers_share_one_request(stub):
    calls = []

    def slow(_h, _b):
        calls.append(1)
        time.sleep(0.3)
        return 200, {}, b""

    stub.routes[("GET", "/x")] = slow
    f = SafeFetcher(allow_private=True, **LOCAL_OK)
    checker = status_mod.StatusChecker(f)
    try:
        async with anyio.create_task_group() as tg:
            for _ in range(5):
                tg.start_soon(checker.check_discovered, [("docker:x", stub.url + "/x")])
        assert len(calls) == 1
    finally:
        await f.aclose()


# ---- L1: the Docker endpoint is never a fetch target --------------------------------------


async def test_fetcher_refuses_docker_host_by_name_and_address():
    async def resolver(host: str, port: int) -> list[str]:
        return {"docker-proxy": ["10.9.9.9"], "alias.lan": ["10.9.9.9"], "ok.lan": ["10.1.1.1"]}[
            host
        ]

    f = SafeFetcher(allow_private=True, resolver=resolver, deny_hosts=["docker-proxy"])
    try:
        for url in (
            "http://docker-proxy:2375/containers/json",
            "http://DOCKER-PROXY.:80/",
            "http://docker-proxy:9999/",
            "http://alias.lan/",  # another name for the same address
            "http://10.9.9.9:1/",
            "http://[::ffff:10.9.9.9]:2375/",
        ):
            with pytest.raises(FetchError) as exc:
                await f.request("GET", url, user_id="u")
            assert exc.value.kind == "blocked", url
        assert f.host_denied("docker-proxy") and not f.host_denied("ok.lan")
    finally:
        await f.aclose()


async def test_docker_host_refused_even_when_otherwise_allowed(tmp_path, stub):
    """The test hook allows 127.0.0.1; a Docker host there still wins, on any port."""
    serve(stub, [labelled("self", url=f"http://127.0.0.1:{stub.port + 1}/")])
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=stub.url, docker_options=FAST
    ) as c:
        await setup_admin(c)
        r = await c.post("/api/services", json={"name": "Proxy", "url": stub.url + "/info"})
        sid = r.json()["service"]["id"]
        await c.get("/api/docker")
        st = (await c.get("/api/status")).json()["statuses"]
        assert st[sid]["state"] == "unknown" and st["docker:self"]["state"] == "unknown"
        r = await c.post(
            "/api/beszel/test", json={"url": stub.url, "username": "a", "password": "b"}
        )
        assert r.json()["ok"] is False and r.json()["error"] == "That address is not allowed"
        assert {e["path"] for e in stub.log} == {"/containers/json?all=true"}


# ---- L2 / N7: stale-while-revalidate, nothing blocks on a hanging proxy -------------------


class Hanging:
    """A Docker API stub that answers once, then hangs (until released)."""

    def __init__(self, stub: Stub, containers: list) -> None:
        self.hang = False
        self.calls = 0
        self.release = False
        payload = json.dumps(containers).encode()

        def handler(_h, _b):
            self.calls += 1
            while self.hang and not self.release:
                time.sleep(0.05)
            return 200, {"Content-Type": "application/json"}, payload

        stub.routes[("GET", "/containers/json")] = handler


SWR = {
    "connect_timeout": 0.5,
    "read_timeout": 1.0,
    "total_timeout": 1.0,
    "ttl": 0.2,
    "error_ttl": 0.2,
}


async def _timed(client: httpx.AsyncClient, path: str) -> tuple[httpx.Response, float]:
    t = time.monotonic()
    r = await client.get(path)
    return r, time.monotonic() - t


async def test_hanging_proxy_never_blocks_requests(tmp_path, docker_stub, stub2):
    stub2.route("GET", "/", 200, b"ok")
    h = Hanging(docker_stub, [labelled("app", url=stub2.url + "/")])
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=docker_stub.url, docker_options=SWR
    ) as c:
        await setup_admin(c)
        await create_user(c, "bob")
        await c.put("/api/admin/config", json={"docker_visible_to_users": True})
        bob = await new_session(c.app, "bob")
        try:
            assert (await c.get("/api/docker")).json()["available"] is True
            assert (await c.get("/api/status")).json()["statuses"]["docker:app"]["state"] == "up"
            h.hang = True
            await anyio.sleep(0.3)  # the listing is now due for a refresh

            worst = 0.0
            stale_seen = False
            deadline = time.monotonic() + 3.0  # several refresh timeouts
            while time.monotonic() < deadline:
                results = []

                async def one(cl, path, results=results):
                    results.append((path, *await _timed(cl, path)))

                async with anyio.create_task_group() as tg:
                    for _ in range(3):
                        tg.start_soon(one, c, "/api/status")
                        tg.start_soon(one, bob, "/api/docker")
                        tg.start_soon(one, c, "/api/docker")
                for path, r, took in results:
                    worst = max(worst, took)
                    assert r.status_code == 200
                    body = r.json()
                    if path == "/api/docker":
                        # The last good listing is still served ...
                        assert body["available"] is True and body["error"] is None
                        assert [s["id"] for s in body["services"]] == ["docker:app"]
                        stale_seen = stale_seen or body["stale"] is True
                    else:
                        # ... and discovered statuses keep coming from the shared cache (N7).
                        assert body["statuses"]["docker:app"]["state"] == "up"
                await anyio.sleep(0.1)
            assert worst < 0.5, worst
            assert stale_seen
            # Single flight: one upstream call per refresh attempt, not one per request.
            assert h.calls <= 1 + 3.3 / (SWR["total_timeout"] + SWR["error_ttl"]) + 1
            admin_body = (await c.get("/api/docker")).json()
            assert admin_body["stale"] is True and admin_body["updated_at"]
            assert "showing the container list from" in admin_body["warnings"][0]["reason"]
        finally:
            h.release = True
            await bob.aclose()


async def test_stale_listing_expires(tmp_path, docker_stub):
    h = Hanging(docker_stub, [labelled("app")])
    opts = {**SWR, "max_stale": 1.0}
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=docker_stub.url, docker_options=opts
    ) as c:
        await setup_admin(c)
        assert (await c.get("/api/docker")).json()["available"] is True
        h.hang = True
        try:
            await anyio.sleep(1.5)
            await c.get("/api/docker")  # kicks a refresh; it times out after 1 s
            await anyio.sleep(1.3)
            body = (await c.get("/api/docker")).json()
            assert body["available"] is False and body["services"] == []
            assert body["error"] == d_api.ADMIN_ERRORS["timeout"]
            assert (await c.get("/api/status")).json()["statuses"] == {}
        finally:
            h.release = True


async def test_cold_start_status_does_not_wait(tmp_path, docker_stub):
    h = Hanging(docker_stub, [labelled("app")])
    h.hang = True
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=docker_stub.url, docker_options=SWR
    ) as c:
        await setup_admin(c)
        try:
            r, took = await _timed(c, "/api/status")
            assert r.json()["statuses"] == {} and took < 0.5
            r, took = await _timed(c, "/api/docker")  # the first load may wait, bounded
            assert r.json()["available"] is False and took < SWR["total_timeout"] + 1.5
        finally:
            h.release = True


# ---- L3: no credentials in service URLs ---------------------------------------------------


def test_label_url_with_credentials_is_skipped():
    for url in ("http://user:pw@app.lan/", "http://user@app.lan/", "https://@app.lan"):
        found = d.discover([labelled("cred", url=url)])
        assert found.services == []
        assert found.skipped == [{"container": "cred", "reason": d.SKIP_URL_CREDENTIALS}]


async def test_service_url_with_credentials(tmp_path):
    async with running(tmp_path, fetcher_options=LOCAL_OK) as c:
        await setup_admin(c)
        r = await c.post("/api/services", json={"name": "X", "url": "http://u:p@x.lan/"})
        assert r.status_code == 400 and "credentials" in r.json()["error"]["fields"]["url"]
        ok = (await c.post("/api/services", json={"name": "X", "url": "http://x.lan/"})).json()
        r = await c.patch(f"/api/services/{ok['service']['id']}", json={"url": "http://u@x.lan"})
        assert r.status_code == 400
        # Stored data from before keeps working: an old backup still restores ...
        backup = (await c.get("/api/backup")).json()
        backup["services"].append({"name": "Old", "url": "http://u:p@old.lan/"})
        r = await c.post("/api/backup", json=backup)
        assert r.status_code == 200
        old = next(s for s in r.json()["services"] if s["name"] == "Old")
        # ... and the row is listed, status-checked (refused: unknown) and editable.
        assert (await c.get("/api/services")).status_code == 200
        st = (await c.get("/api/status")).json()["statuses"]
        assert st[old["id"]]["state"] == "unknown"
        r = await c.patch(f"/api/services/{old['id']}", json={"name": "Renamed"})
        assert r.status_code == 200 and r.json()["service"]["url"] == "http://u:p@old.lan/"


# ---- N1: duplicate ids ----------------------------------------------------------------------


def test_duplicate_names_are_skipped():
    found = d.discover([labelled("dup", url="http://a.lan/"), labelled("dup", url="http://b.lan/")])
    assert [(s["id"], s["url"]) for s in found.services] == [("docker:dup", "http://a.lan/")]
    assert found.skipped == [{"container": "dup", "reason": d.SKIP_DUPLICATE}]
    twice = [
        container("web", ports=[{"IP": "", "PrivatePort": 80, "PublicPort": 81, "Type": "tcp"}])
    ]
    assert len(d.suggest(twice * 2, public_host=None, existing_urls=set())) == 1


# ---- N2: self-exclusion ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "c",
    [
        container("server-hub", image="server-hub:latest"),
        container("hub", image="ghcr.io/someone/serverhub:2"),
        container("x-docker-proxy-1", labels={"com.docker.compose.service": "docker-proxy"}),
        container("x-server-hub-1", labels={"com.docker.compose.service": "server-hub"}),
        container("sp", image="wollomatic/socket-proxy:1.13.2@sha256:" + "0" * 64),
        container("lsio", image="lscr.io/linuxserver/socket-proxy:latest"),
        container("tec", image="tecnativa/docker-socket-proxy"),
        container("me", cid="abcdef012345" + "0" * 52),
    ],
)
def test_self_and_proxy_detection(c):
    assert d.is_self_or_proxy(c, "abcdef012345")


def test_ordinary_container_not_self():
    assert not d.is_self_or_proxy(container("web", image="nginx:1.27"), "abcdef012345")
    assert not d.is_self_or_proxy(container("docker-proxy-ui", image="nginx"), None)


# ---- N3: one URL normalisation rule ------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b", "same"),
    [
        ("HTTP://NAS.lan:3000/", "http://nas.lan:3000", True),
        ("http://nas.lan:80/", "http://nas.lan", True),
        ("https://nas.lan:443", "https://nas.lan/", True),
        ("http://nas.lan/app/", "http://nas.lan/app", True),
        ("http://nas.lan/app#top", "http://nas.lan/app", True),
        ("http://user:pw@nas.lan/", "http://nas.lan", True),
        ("http://nas.lan/?", "http://nas.lan/", True),
        ("http://[FD00::2]:80/", "http://[fd00::2]", True),
        ("http://nas.lan/?a=1", "http://nas.lan/?a=2", False),  # query kept
        ("http://nas.lan/?a=1", "http://nas.lan/", False),
        ("http://nas.lan/App", "http://nas.lan/app", False),  # path case kept
        ("http://nas.lan:443", "https://nas.lan", False),  # scheme kept
        ("http://nas.lan:8080", "http://nas.lan", False),
    ],
)
def test_normalize_url(a, b, same):
    assert (d.normalize_url(a) == d.normalize_url(b)) is same


def test_normalize_url_shape():
    assert d.normalize_url(" HTTPS://Nas.LAN:443/a/b//?q=1#f ") == "https://nas.lan/a/b?q=1"
    assert d.normalize_url("http://nas.lan:8096/") == "http://nas.lan:8096"


def test_suggestion_with_query_is_not_hidden_by_another_query():
    c = [container("web", ports=[{"IP": "", "PrivatePort": 80, "PublicPort": 80, "Type": "tcp"}])]
    assert d.suggest(c, public_host="nas.lan", existing_urls={"http://nas.lan/?x=1"})
    assert not d.suggest(c, public_host="nas.lan", existing_urls={"http://NAS.lan:80/#f"})


# ---- skip reasons --------------------------------------------------------------------------


def test_long_url_has_one_reason():
    for n in (2001, 2048, 2049, 5000):
        url = "http://a.lan/" + "x" * (n - len("http://a.lan/"))
        found = d.discover([labelled("long", url=url)])
        assert found.skipped == [{"container": "long", "reason": d.SKIP_URL_TOO_LONG}], n
    assert d.discover([labelled("ok", url="http://a.lan/" + "x" * 1987)]).services


def test_non_url_validation_failure_is_not_blamed_on_the_url(monkeypatch):
    class Failing(BaseModel):
        model_config = ConfigDict(extra="forbid")
        name: str
        url: str
        description: str = ""
        icon: str = "box"
        category: str | None = None
        check: bool = True

        @field_validator("check")
        @classmethod
        def _no(cls, v):
            raise ValueError("nope")

    monkeypatch.setattr(d, "ServiceCreate", Failing)
    found = d.discover([labelled("x", check="true")])
    assert found.skipped == [{"container": "x", "reason": d.SKIP_LABELS_INVALID}]

"""Docker auto-discovery: config, label parsing, suggestions, API, client hardening.

The Docker Engine API is replaced by the local ``Stub`` HTTP server (and, for the
streaming size cap, an httpx.MockTransport). Real Docker is exercised in CI.
"""

from __future__ import annotations

import json
import socket
import time

import anyio
import httpx
import pytest

from serverhub.api import docker as d_api
from serverhub.config import ConfigError, load_config
from serverhub.integrations import docker as d
from tests.conftest import LOCAL_OK, SECRET, create_user, new_session, running, setup_admin

pytestmark = pytest.mark.anyio

FAST = {
    "connect_timeout": 0.5,
    "read_timeout": 0.5,
    "total_timeout": 1.0,
    "ttl": 0.0,
    "error_ttl": 0.0,
    # Requests wait for the refresh they triggered, so a test sees the stub's
    # current answer (production default: 0, never wait when anything is cached).
    "refresh_wait": 2.0,
}


def container(
    name: str,
    *,
    labels: dict | None = None,
    state: str = "running",
    status: str = "Up 2 hours",
    image: str = "nginx:1.27",
    ports: list | None = None,
    cid: str | None = None,
    **extra,
) -> dict:
    return {
        "Id": cid or ("ab" * 32),
        "Names": [f"/{name}"],
        "Image": image,
        "State": state,
        "Status": status,
        "Labels": labels or {},
        "Ports": ports or [],
        **extra,
    }


def labelled(
    cname: str, /, url: str = "http://app.lan:8080", *, image: str = "nginx:1.27", **labels
) -> dict:
    """A container with serverhub.enable=true, serverhub.url and serverhub.<key> labels."""
    lab = {"serverhub.enable": "true", "serverhub.url": url}
    lab.update({f"serverhub.{k}": v for k, v in labels.items()})
    return container(cname, labels=lab, image=image)


def tcp(private: int, public: int, ip: str = "0.0.0.0", proto: str = "tcp") -> dict:
    return {"IP": ip, "PrivatePort": private, "PublicPort": public, "Type": proto}


def closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---- configuration ------------------------------------------------------------------


def cfg(tmp_path, **kw):
    return load_config(secret_key=SECRET, data_dir=tmp_path, **kw)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("tcp://docker-proxy:2375", "http://docker-proxy:2375"),
        ("http://docker-proxy:2375/", "http://docker-proxy:2375"),
        ("TCP://Docker-Proxy", "http://docker-proxy:2375"),
        ("http://10.0.0.5", "http://10.0.0.5:80"),
        ("tcp://[fd00::5]:2375", "http://[fd00::5]:2375"),
        ("", None),
        ("   ", None),
    ],
)
def test_docker_host_accepted(tmp_path, raw, expected):
    assert cfg(tmp_path, docker_host=raw).docker_host == expected


@pytest.mark.parametrize(
    "raw",
    [
        "unix:///var/run/docker.sock",
        "https://docker-proxy:2375",
        "npipe:////./pipe/docker_engine",
        "docker-proxy:2375",
        "tcp://user:pw@docker-proxy:2375",
        "tcp://docker-proxy:2375/v1.47",
        "tcp://docker-proxy:2375?x=1",
        "tcp://docker-proxy:0",
        "tcp://docker-proxy:99999",
        "tcp://bad host:2375",
        "tcp://",
    ],
)
def test_docker_host_rejected(tmp_path, raw):
    with pytest.raises(ConfigError) as exc:
        cfg(tmp_path, docker_host=raw)
    assert "SERVERHUB_DOCKER_HOST" in str(exc.value)
    assert "tcp://host:port" in str(exc.value)


def test_docker_public_host(tmp_path):
    assert cfg(tmp_path).docker_public_host is None
    assert cfg(tmp_path, docker_public_host=" NAS.lan. ").docker_public_host == "nas.lan"
    assert cfg(tmp_path, docker_public_host="[::1]").docker_public_host == "::1"
    assert cfg(tmp_path, docker_public_host="192.168.1.2").docker_public_host == "192.168.1.2"
    for bad in ("http://nas.lan", "nas.lan:8080", "nas.lan/x", "a b"):
        with pytest.raises(ConfigError, match="SERVERHUB_DOCKER_PUBLIC_HOST"):
            cfg(tmp_path, docker_public_host=bad)


def test_docker_off_by_default(tmp_path):
    assert cfg(tmp_path).docker_host is None


# ---- label parsing ------------------------------------------------------------------


def test_discover_defaults_and_labels():
    found = d.discover(
        [
            labelled("my_grafana-1", image="grafana/grafana:11"),
            labelled(
                "wiki",
                url="https://wiki.lan",
                name="Team Wiki",
                description="Docs",
                icon="book",
                category="productivity",
                check="false",
            ),
            container("plain"),  # no labels: not discovered
            container("off", labels={"serverhub.enable": "false", "serverhub.url": "http://x"}),
        ]
    )
    assert found.skipped == [] and found.warnings == []
    by_id = {s["id"]: s for s in found.services}
    assert set(by_id) == {"docker:my_grafana-1", "docker:wiki"}
    g = by_id["docker:my_grafana-1"]
    assert g["name"] == "My Grafana"
    assert g["icon"] == "chart"  # heuristic from the image
    assert g["category"] is None and g["check"] is True and g["description"] == ""
    assert g["container"] == {
        "name": "my_grafana-1",
        "image": "grafana/grafana:11",
        "state": "running",
        "status": "Up 2 hours",
        "health": None,
    }
    w = by_id["docker:wiki"]
    assert (w["name"], w["url"], w["description"], w["icon"], w["category"], w["check"]) == (
        "Team Wiki",
        "https://wiki.lan",
        "Docs",
        "book",
        "Productivity",
        False,
    )
    assert set(w) == {"id", "name", "url", "description", "icon", "category", "check", "container"}


def test_discover_stopped_and_health():
    c1 = labelled("a")
    c1.update(State="exited", Status="Exited (1) 3 minutes ago")
    c2 = labelled("b")
    c2.update(Status="Up 1 minute (health: starting)")
    c3 = labelled("c")
    c3.update(Status="Up 1 hour (unhealthy)")
    c4 = labelled("e")
    c4.update(Health={"Status": "healthy", "FailingStreak": 0}, Status="Up (unhealthy)")
    c5 = labelled("f")
    c5.update(Health={"Status": "none"})
    found = d.discover([c1, c2, c3, c4, c5])
    got = {s["container"]["name"]: s["container"] for s in found.services}
    assert got["a"]["state"] == "exited" and got["a"]["health"] is None
    assert got["a"]["status"] == "Exited (1) 3 minutes ago"
    assert got["b"]["health"] == "starting"
    assert got["c"]["health"] == "unhealthy"
    assert got["e"]["health"] == "healthy"  # v1.52+ Health object wins over the text
    assert got["f"]["health"] is None


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "data:text/html,x",
        "ftp://x.lan",
        "http://",
        "http://x.lan/\x00",
        "http://exa mple.lan",
        "http://" + "a" * 3000 + ".lan",
        "",
    ],
)
def test_discover_bad_url_is_skipped(url):
    found = d.discover([labelled("bad", url=url), labelled("good")])
    assert [s["id"] for s in found.services] == ["docker:good"]
    assert len(found.skipped) == 1 and found.skipped[0]["container"] == "bad"
    assert "serverhub.url" in found.skipped[0]["reason"]


def test_discover_missing_url_is_skipped():
    c = container("nourl", labels={"serverhub.enable": "true"})
    found = d.discover([c])
    assert found.services == []
    assert found.skipped == [{"container": "nourl", "reason": "serverhub.url is missing"}]


def test_discover_malicious_labels_fall_back():
    found = d.discover(
        [
            labelled(
                "evil",
                image="busybox:1.37",
                name="x" * 100_000,  # over the label cap: ignored
                description="d" * 600,  # over 500 after cleaning: default
                icon="<script>",
                category="Hacking",
                check="maybe",
            ),
            labelled("ctl", name="Bad\x00\x1b[31mName‮\n", description="a\tb\r\nc\x07"),
            labelled("blank", name="\x00\x01 "),
        ]
    )
    by = {s["container"]["name"]: s for s in found.services}
    evil = by["evil"]
    assert evil["name"] == "Evil" and evil["description"] == ""
    assert evil["icon"] == "box" and evil["category"] is None and evil["check"] is True
    ctl = by["ctl"]
    assert ctl["name"] == "Bad[31mName"
    assert ctl["description"] == "a b  c"
    assert by["blank"]["name"] == "Blank"
    reasons = {(w["container"], w["reason"].split(" ")[0]) for w in found.warnings}
    for field in ("name", "description", "icon", "category", "check"):
        assert ("evil", f"serverhub.{field}") in reasons
    assert ("blank", "serverhub.name") in reasons
    assert found.skipped == []
    # Nothing unprintable survives anywhere in the output.
    blob = json.dumps(found.services)
    assert "\\u0000" not in blob and "\\u001b" not in blob and "\\u202e" not in blob


def test_discover_untrusted_shapes():
    long_status = "Up " + "z" * 5000
    entries = [
        "not a dict",
        42,
        None,
        {"Names": "nope", "Labels": {"serverhub.enable": "true"}},
        {"Names": ["/ok"], "Labels": ["serverhub.enable=true"]},  # labels not a dict
        container(
            "weird-state",
            labels={"serverhub.enable": "true", "serverhub.url": "http://a"},
            state="zombie",
        ),
        container("../etc", labels={"serverhub.enable": "true", "serverhub.url": "http://a"}),
        container("num", labels={"serverhub.enable": True, "serverhub.url": "http://a"}),
        {**labelled("longstatus"), "Status": long_status, "Image": 7},
    ]
    found = d.discover(entries)
    assert [s["id"] for s in found.services] == ["docker:longstatus"]
    svc = found.services[0]
    assert len(svc["container"]["status"]) == 200 and svc["container"]["image"] == ""
    reasons = sorted(s["reason"] for s in found.skipped)
    assert reasons == [
        "container has no usable name",  # Names not a list
        "container has no usable name",  # "/../etc" is not a Docker name
        "unknown container state",
    ]


def test_discover_caps_container_count():
    many = [labelled(f"c{i}") for i in range(d.MAX_CONTAINERS + 5)]
    found = d.discover(many)
    assert len(found.services) == d.MAX_CONTAINERS
    assert any(w["container"] == "*" for w in found.warnings)


def test_stable_ids_from_names():
    a = labelled("app")
    b = {**labelled("app"), "Id": "cd" * 32}  # recreated: new id, same name
    assert d.discover([a]).services[0]["id"] == d.discover([b]).services[0]["id"] == "docker:app"
    linked = {**labelled("app"), "Names": ["/other/alias", "/app"]}
    assert d.discover([linked]).services[0]["id"] == "docker:app"


def test_prettify():
    assert d.prettify("server-hub") == "Server Hub"
    assert d.prettify("stack_web_1") == "Stack Web"
    assert d.prettify("app-12") == "App"
    assert d.prettify("x.y") == "X Y"


# ---- suggestions --------------------------------------------------------------------


def test_suggest_filters_and_heuristics():
    containers = [
        container("web", ports=[tcp(80, 8081), tcp(80, 8081, ip="::"), tcp(9000, 9001)]),
        container(
            "secure", image="ghcr.io/x/portainer:2", ports=[tcp(9000, 9000), tcp(8443, 9443)]
        ),
        container("tls", ports=[tcp(443, 443)]),
        container("plain80", ports=[tcp(80, 80)]),
        container("other", ports=[tcp(1234, 4321), tcp(25, 2525)]),
        container("udp-only", ports=[tcp(53, 53, proto="udp")]),
        container("local-only", ports=[tcp(80, 8085, ip="127.0.0.1")]),
        container("noports"),
        container("stopped", state="exited", ports=[tcp(80, 8090)]),
        container("labelled", labels={"serverhub.enable": "false"}, ports=[tcp(80, 8091)]),
        container("myself", cid="0123456789ab" + "0" * 52, ports=[tcp(8642, 8642)]),
        # Server Hub and the socket proxy, as Compose names them (N2).
        container(
            "proj-docker-proxy-1",
            image="nginx:1.27",
            labels={"com.docker.compose.service": "docker-proxy"},
            ports=[tcp(2375, 2375)],
        ),
        container("my-proxy", image="wollomatic/socket-proxy:1.13.2", ports=[tcp(2375, 2376)]),
        container("dsp", image="ghcr.io/tecnativa/docker-socket-proxy", ports=[tcp(2375, 2377)]),
        container("hub-2", image="server-hub:latest", ports=[tcp(8642, 8643)]),
        container("taken", ports=[tcp(3000, 3000)]),
        "garbage",
        {"Names": ["/broken"], "State": "running", "Ports": [{"PrivatePort": "80"}, "x"]},
    ]
    out = d.suggest(
        containers,
        public_host="nas.lan",
        existing_urls={"HTTP://NAS.lan:3000/"},
        exclude_id_prefix="0123456789ab",
    )
    by = {s["container"]["name"]: s for s in out}
    assert list(by) == ["other", "plain80", "secure", "tls", "web"]
    assert by["web"]["suggested"]["url"] == "http://nas.lan:8081"
    assert by["web"]["ports"] == [
        {"private": 80, "public": 8081, "protocol": "tcp"},
        {"private": 9000, "public": 9001, "protocol": "tcp"},
    ]
    assert by["web"]["container"] == {"name": "web", "image": "nginx:1.27", "state": "running"}
    assert by["secure"]["suggested"]["url"] == "https://nas.lan:9443"
    assert by["secure"]["suggested"]["icon"] == "layers"
    assert by["tls"]["suggested"]["url"] == "https://nas.lan"
    assert by["plain80"]["suggested"]["url"] == "http://nas.lan"
    assert by["other"]["suggested"]["url"] == "http://nas.lan:2525"  # lowest private port
    assert by["web"]["suggested"]["name"] == "Web"
    assert set(by["web"]["suggested"]) == {"name", "url", "icon", "category"}


def test_suggest_without_public_host_and_ipv6():
    c = [container("web", ports=[tcp(80, 8081)])]
    assert d.suggest(c, public_host=None, existing_urls=set())[0]["suggested"]["url"] is None
    v6 = d.suggest(c, public_host="fd00::2", existing_urls=set())
    assert v6[0]["suggested"]["url"] == "http://[fd00::2]:8081"


# ---- the client -------------------------------------------------------------------------


async def test_client_single_flight(stub):
    calls = []

    def slow(_h, _b):
        calls.append(1)
        time.sleep(0.3)
        return 200, {"Content-Type": "application/json"}, json.dumps([labelled("a")]).encode()

    stub.routes[("GET", "/containers/json")] = slow
    client = d.DockerClient(stub.url)
    try:
        results = []

        async def one():
            results.append(await client.containers())

        async with anyio.create_task_group() as tg:
            for _ in range(10):
                tg.start_soon(one)
        assert len(calls) == 1 and len(results) == 10
        await client.containers()  # still cached
        assert len(calls) == 1
        assert stub.log[0]["path"] == "/containers/json?all=true"
        assert stub.log[0]["method"] == "GET"
    finally:
        await client.aclose()


async def test_client_caches_errors_briefly(stub):
    stub.route("GET", "/containers/json", 500, b"boom")
    client = d.DockerClient(stub.url, error_ttl=30)
    try:
        for _ in range(3):
            with pytest.raises(d.DockerError) as exc:
                await client.containers()
            assert exc.value.kind == "http" and exc.value.status == 500
        assert len(stub.log) == 1
    finally:
        await client.aclose()


@pytest.mark.parametrize(
    ("status", "body", "headers", "kind"),
    [
        (200, b"<html>not json</html>", {}, "protocol"),
        (200, b'{"message": "object, not a list"}', {}, "protocol"),
        (200, b"[" * 100_000, {}, "protocol"),
        (403, b"Forbidden", {}, "denied"),
        (302, b"", {"Location": "http://evil.example/"}, "http"),
        (404, b"page not found", {}, "http"),
    ],
)
async def test_client_bad_responses(stub, status, body, headers, kind):
    stub.route("GET", "/containers/json", status, body, headers)
    client = d.DockerClient(stub.url, **FAST)
    try:
        with pytest.raises(d.DockerError) as exc:
            await client.containers()
        assert exc.value.kind == kind
        assert len(stub.log) == 1  # the redirect was not followed
    finally:
        await client.aclose()


async def test_client_size_cap_declared(stub):
    stub.route("GET", "/containers/json", 200, b"[" + b" " * 5000 + b"]")
    client = d.DockerClient(stub.url, max_body=1000)
    try:
        with pytest.raises(d.DockerError) as exc:
            await client.containers()
        assert exc.value.kind == "too_large"
    finally:
        await client.aclose()


async def test_client_size_cap_streamed():
    async def chunks():
        for _ in range(100):
            yield b" " * 1000

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/containers/json"
        return httpx.Response(200, content=chunks())  # no Content-Length

    client = d.DockerClient(
        "http://docker-proxy:2375", max_body=10_000, transport=httpx.MockTransport(handler)
    )
    try:
        with pytest.raises(d.DockerError) as exc:
            await client.containers()
        assert exc.value.kind == "too_large"
    finally:
        await client.aclose()


async def test_client_slow_and_down(stub):
    def slow(_h, _b):
        time.sleep(1.5)
        return 200, {}, b"[]"

    stub.routes[("GET", "/containers/json")] = slow
    client = d.DockerClient(stub.url, **FAST)
    try:
        started = time.monotonic()
        with pytest.raises(d.DockerError) as exc:
            await client.containers()
        assert exc.value.kind == "timeout" and time.monotonic() - started < 1.4
    finally:
        await client.aclose()
    down = d.DockerClient(f"http://127.0.0.1:{closed_port()}", **FAST)
    try:
        with pytest.raises(d.DockerError) as exc:
            await down.containers()
        # Refused at once on Linux; Windows retries a refused connect until the timeout.
        assert exc.value.kind in ("connect", "timeout")
    finally:
        await down.aclose()


# ---- API: visibility, bootstrap, suggestions --------------------------------------------


def serve(stub, containers: list) -> None:
    stub.route("GET", "/containers/json", 200, containers)


async def test_feature_off(tmp_path):
    async with running(tmp_path, fetcher_options=LOCAL_OK) as c:
        await setup_admin(c)
        await create_user(c, "bob")
        off = {
            "enabled": False,
            "available": False,
            "error": None,
            "stale": False,
            "updated_at": None,
            "services": [],
        }
        assert (await c.get("/api/docker")).json() == off
        assert (await c.get("/api/bootstrap")).json()["docker"] == {"enabled": False}
        r = await c.get("/api/admin/docker/suggestions")
        assert r.json() == {"available": False, "error": None, "suggestions": []}
        # The switch alone does not turn the feature on.
        await c.put("/api/admin/config", json={"docker_visible_to_users": True})
        bob = await new_session(c.app, "bob")
        assert (await bob.get("/api/docker")).json() == off
        assert (await bob.get("/api/bootstrap")).json()["docker"] == {"enabled": False}
        await bob.aclose()


async def test_visibility_matrix(tmp_path, stub):
    serve(stub, [labelled("app"), container("web", ports=[tcp(80, 8081)])])
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=stub.url, docker_options=FAST
    ) as c:
        await setup_admin(c)
        await create_user(c, "bob")
        bob = await new_session(c.app, "bob")
        try:
            # unauthenticated
            anon = httpx.AsyncClient(
                transport=httpx.ASGITransport(app=c.app), base_url="http://testserver"
            )
            for path in ("/api/docker", "/api/admin/docker/suggestions"):
                assert (await anon.get(path)).status_code == 401
            await anon.aclose()

            # admin, switch off (default)
            r = (await c.get("/api/docker")).json()
            assert r["enabled"] is True and r["available"] is True and r["error"] is None
            assert [s["id"] for s in r["services"]] == ["docker:app"]
            assert r["skipped"] == [] and r["warnings"] == []
            assert (await c.get("/api/bootstrap")).json()["docker"] == {"enabled": True}
            assert (await c.get("/api/admin/config")).json()["docker_visible_to_users"] is False

            # user, switch off
            hidden = {
                "enabled": False,
                "available": False,
                "error": None,
                "stale": False,
                "updated_at": None,
                "services": [],
            }
            assert (await bob.get("/api/docker")).json() == hidden
            assert (await bob.get("/api/bootstrap")).json()["docker"] == {"enabled": False}
            assert (await bob.get("/api/admin/docker/suggestions")).status_code == 403

            # switch on
            r = await c.put("/api/admin/config", json={"docker_visible_to_users": True})
            assert r.json() == {"registration_open": False, "docker_visible_to_users": True}
            r = (await bob.get("/api/docker")).json()
            assert r["enabled"] is True and [s["id"] for s in r["services"]] == ["docker:app"]
            assert "skipped" not in r and "warnings" not in r  # admin-only diagnostics
            assert (await bob.get("/api/bootstrap")).json()["docker"] == {"enabled": True}
            assert (await bob.get("/api/admin/docker/suggestions")).status_code == 403

            # and off again
            await c.put("/api/admin/config", json={"docker_visible_to_users": False})
            assert (await bob.get("/api/docker")).json() == hidden
        finally:
            await bob.aclose()


async def test_docker_unavailable_messages(tmp_path):
    host = f"http://127.0.0.1:{closed_port()}"
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=host, docker_options=FAST
    ) as c:
        await setup_admin(c)
        await create_user(c, "bob")
        await c.put("/api/admin/config", json={"docker_visible_to_users": True})
        r = (await c.get("/api/docker")).json()
        assert r["enabled"] is True and r["available"] is False and r["services"] == []
        assert r["error"] in (
            d_api.ADMIN_ERRORS["connect"],
            d_api.ADMIN_ERRORS["timeout"],
        )
        bob = await new_session(c.app, "bob")
        r = (await bob.get("/api/docker")).json()
        assert r == {
            "enabled": True,
            "available": False,
            "error": "Docker discovery is unavailable right now",
            "stale": False,
            "updated_at": None,
            "services": [],
        }
        await bob.aclose()
        r = (await c.get("/api/admin/docker/suggestions")).json()
        assert r["available"] is False and r["suggestions"] == [] and r["error"]
        # Status and bootstrap keep working.
        assert (await c.get("/api/status")).status_code == 200
        assert (await c.get("/api/bootstrap")).status_code == 200


async def test_remote_output_never_echoed(tmp_path, stub):
    stub.route("GET", "/containers/json", 500, b"SECRET-REMOTE-DETAIL /etc/passwd")
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=stub.url, docker_options=FAST
    ) as c:
        await setup_admin(c)
        r = await c.get("/api/docker")
        assert r.json()["error"] == "The Docker API answered HTTP 500"
        assert "SECRET" not in r.text
        stub.route("GET", "/containers/json", 200, b"SECRET-REMOTE garbage")
        r = await c.get("/api/admin/docker/suggestions")
        assert r.json()["error"] == "The Docker API sent an unexpected response"
        assert "SECRET" not in r.text


async def test_admin_diagnostics(tmp_path, stub):
    serve(stub, [labelled("bad", url="javascript:alert(1)"), labelled("ok", icon="nope")])
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=stub.url, docker_options=FAST
    ) as c:
        await setup_admin(c)
        r = (await c.get("/api/docker")).json()
        assert [s["id"] for s in r["services"]] == ["docker:ok"]
        assert r["services"][0]["icon"] == "globe"  # unknown label -> image heuristic (nginx)
        assert r["skipped"] == [
            {"container": "bad", "reason": "serverhub.url is not a valid http(s) URL"}
        ]
        assert [w["container"] for w in r["warnings"]] == ["ok"]


async def test_suggestions_endpoint(tmp_path, stub):
    serve(
        stub,
        [
            labelled("app"),
            container("web", ports=[tcp(80, 8081)]),
            container("jelly", image="jellyfin/jellyfin", ports=[tcp(8096, 8096)]),
        ],
    )
    async with running(
        tmp_path,
        fetcher_options=LOCAL_OK,
        docker_host=stub.url,
        docker_public_host="nas.lan",
        docker_options=FAST,
    ) as c:
        await setup_admin(c)
        r = (await c.get("/api/admin/docker/suggestions")).json()
        assert r["available"] is True and r["error"] is None
        assert [s["container"]["name"] for s in r["suggestions"]] == ["jelly", "web"]
        jelly = r["suggestions"][0]["suggested"]
        assert jelly == {
            "name": "Jelly",
            "url": "http://nas.lan:8096",
            "icon": "film",
            "category": "Media",
        }
        # Adding one is the ordinary service API; it then disappears from the list.
        r = await c.post("/api/services", json={k: jelly[k] for k in ("name", "url", "icon")})
        assert r.status_code == 201
        r = (await c.get("/api/admin/docker/suggestions")).json()
        assert [s["container"]["name"] for s in r["suggestions"]] == ["web"]
        # Another admin still sees it (the filter is per admin).
        await create_user(c, "root2", role="admin")
        other = await new_session(c.app, "root2")
        r = (await other.get("/api/admin/docker/suggestions")).json()
        assert [s["container"]["name"] for s in r["suggestions"]] == ["jelly", "web"]
        await other.aclose()


async def test_status_includes_discovered(tmp_path, docker_stub, stub2):
    stub2.route("GET", "/", 200, b"ok")
    serve(
        docker_stub,
        [
            labelled("up", url=stub2.url + "/"),
            labelled("nocheck", url=stub2.url + "/x", check="false"),
        ],
    )
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=docker_stub.url, docker_options=FAST
    ) as c:
        await setup_admin(c)
        await create_user(c, "bob")
        # /api/status never waits for Docker: nothing is listed before the first load.
        assert (await c.get("/api/status")).json()["statuses"] == {}
        await c.get("/api/docker")
        statuses = (await c.get("/api/status")).json()["statuses"]
        assert set(statuses) == {"docker:up"}
        assert statuses["docker:up"]["state"] == "up"
        assert statuses["docker:up"]["http_status"] == 200  # admin detail

        bob = await new_session(c.app, "bob")
        assert (await bob.get("/api/status")).json()["statuses"] == {}
        await c.put("/api/admin/config", json={"docker_visible_to_users": True})
        st = (await bob.get("/api/status")).json()["statuses"]["docker:up"]
        assert st["state"] == "up" and st["http_status"] is None and st["latency_ms"] is None
        await bob.aclose()


async def test_discovered_services_are_read_only(tmp_path, stub):
    serve(stub, [labelled("app")])
    async with running(
        tmp_path, fetcher_options=LOCAL_OK, docker_host=stub.url, docker_options=FAST
    ) as c:
        await setup_admin(c)
        for sid in ("docker:app", "docker%3Aapp", "docker:" + "x" * 300):
            r = await c.patch(f"/api/services/{sid}", json={"name": "x"})
            assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
            r = await c.delete(f"/api/services/{sid}")
            assert r.status_code == 404
        assert (await c.post("/api/docker", json={})).status_code in (404, 405)
        # Backups contain only stored services.
        await c.post("/api/services", json={"name": "Mine", "url": "http://mine.lan"})
        exported = (await c.get("/api/backup")).json()
        assert [s["name"] for s in exported["services"]] == ["Mine"]
        assert "docker" not in json.dumps(exported["services"])
        exported["services"].append(
            {"name": "App", "url": "http://app.lan:8080", "id": "docker:app"}
        )
        r = await c.post("/api/backup", json=exported)
        assert r.status_code == 200
        ids = [s["id"] for s in r.json()["services"]]
        assert all(not i.startswith("docker:") for i in ids) and len(ids) == 2
        assert r.json()["docker"] == {"enabled": True}


# ---- admin config backward compatibility -------------------------------------------------


async def test_admin_config_partial_put(client):
    await setup_admin(client)
    assert (await client.get("/api/admin/config")).json() == {
        "registration_open": False,
        "docker_visible_to_users": False,
    }
    r = await client.put("/api/admin/config", json={"registration_open": True})
    assert r.json() == {"registration_open": True, "docker_visible_to_users": False}
    r = await client.put("/api/admin/config", json={"docker_visible_to_users": True})
    assert r.json() == {"registration_open": True, "docker_visible_to_users": True}
    r = await client.put(
        "/api/admin/config", json={"registration_open": False, "docker_visible_to_users": False}
    )
    assert r.json() == {"registration_open": False, "docker_visible_to_users": False}
    for bad in (
        {},
        {"docker_visible_to_users": None},
        {"docker_visible_to_users": "yes"},
        {"x": 1},
    ):
        r = await client.put("/api/admin/config", json=bad)
        assert r.status_code == 400 and r.json()["error"]["code"] == "validation", bad
    await create_user(client, "bob")
    bob = await new_session(client.app, "bob")
    r = await bob.put("/api/admin/config", json={"docker_visible_to_users": True})
    assert r.status_code == 403
    await bob.aclose()
    assert (await client.get("/api/admin/config")).json()["docker_visible_to_users"] is False

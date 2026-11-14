from __future__ import annotations

import ipaddress

import pytest

from serverhub.integrations.fetcher import FetchError, SafeFetcher, address_allowed

pytestmark = pytest.mark.anyio


@pytest.mark.parametrize(
    "addr",
    [
        "127.0.0.1",
        "127.1.2.3",
        "0.0.0.0",
        "169.254.169.254",
        "169.254.0.1",
        "100.100.100.200",
        "192.0.0.192",
        "224.0.0.1",
        "255.255.255.255",
        "240.0.0.1",
        "::",
        "::1",
        "fe80::1",
        "ff02::1",
        "fd00:ec2::254",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::7f00:1",
        "64:ff9b::a9fe:a9fe",
        "2002:7f00:1::",
        "2002:a9fe:a9fe::",
        "::127.0.0.1",
        "192.0.2.10",  # documentation range: not global
    ],
)
def test_always_blocked(addr):
    ip = ipaddress.ip_address(addr)
    assert not address_allowed(ip, allow_private=True)
    assert not address_allowed(ip, allow_private=False)


@pytest.mark.parametrize(
    "addr",
    [
        "10.0.0.5",
        "172.16.3.4",
        "192.168.1.10",
        "100.64.1.1",
        "fd12:3456::1",
        "::ffff:10.1.1.1",
        "64:ff9b::c0a8:101",
    ],
)
def test_private_needs_opt_in(addr):
    ip = ipaddress.ip_address(addr)
    assert address_allowed(ip, allow_private=True)
    assert not address_allowed(ip, allow_private=False)


@pytest.mark.parametrize("addr", ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
def test_public_allowed(addr):
    assert address_allowed(ipaddress.ip_address(addr), allow_private=False)


async def test_loopback_target_refused_and_never_contacted(stub):
    stub.route("GET", "/", 200, b"ok")
    f = SafeFetcher(allow_private=True)
    try:
        for url in (
            stub.url,
            f"http://localhost:{stub.port}/",
            f"http://[::1]:{stub.port}/",
            f"http://2130706433:{stub.port}/",
        ):
            with pytest.raises(FetchError) as ei:
                await f.request("GET", url, user_id="u")
            assert ei.value.kind in ("blocked", "dns", "connect"), url
    finally:
        await f.aclose()
    assert stub.log == []


async def test_dns_answer_is_validated_and_pinned(stub):
    """The validated IP is dialled directly: no second lookup, no rebinding window."""
    stub.route("GET", "/", 200, b"hello")
    calls = []

    async def resolver(host, port):
        calls.append(host)
        # Rebinding attempt: first answer is fine, any later one is the metadata IP.
        return ["127.0.0.1"] if len(calls) == 1 else ["169.254.169.254"]

    f = SafeFetcher(allow_private=True, resolver=resolver, extra_allowed=["127.0.0.1/32"])
    try:
        res = await f.request("GET", f"http://stub.invalid:{stub.port}/", user_id="u")
        assert res.status == 200 and res.body == b"hello"
        assert calls == ["stub.invalid"]
        assert stub.log[0]["headers"]["Host"] == f"stub.invalid:{stub.port}"
    finally:
        await f.aclose()

    # A fresh client: the rebinding answer is refused.
    f = SafeFetcher(allow_private=True, resolver=resolver, extra_allowed=["127.0.0.1/32"])
    try:
        with pytest.raises(FetchError) as ei:
            await f.request("GET", f"http://stub.invalid:{stub.port}/", user_id="u")
        assert ei.value.kind == "blocked"
    finally:
        await f.aclose()
    assert len(stub.log) == 1


async def test_mixed_dns_answers_skip_blocked(stub):
    stub.route("GET", "/", 204)

    async def resolver(host, port):
        return ["169.254.169.254", "127.0.0.1"]

    f = SafeFetcher(allow_private=True, resolver=resolver, extra_allowed=["127.0.0.1/32"])
    try:
        res = await f.request("GET", f"http://svc.invalid:{stub.port}/", user_id="u")
        assert res.status == 204
    finally:
        await f.aclose()


async def test_private_targets_blocked_when_disabled():
    async def resolver(host, port):
        return ["192.168.1.20"]

    f = SafeFetcher(allow_private=False, resolver=resolver)
    try:
        with pytest.raises(FetchError) as ei:
            await f.request("GET", "http://nas.lan/", user_id="u")
        assert ei.value.kind == "blocked"
        with pytest.raises(FetchError):
            await f.request("GET", "http://10.0.0.1/", user_id="u")
    finally:
        await f.aclose()


async def test_redirects_are_not_followed(stub, stub2):
    stub2.route("GET", "/latest/meta-data", 200, b"secret")
    stub.route("GET", "/", 302, headers={"Location": f"{stub2.url}/latest/meta-data"})
    f = SafeFetcher(allow_private=True, extra_allowed=["127.0.0.1/32"])
    try:
        res = await f.request("GET", stub.url + "/", user_id="u")
        assert res.status == 302
    finally:
        await f.aclose()
    assert stub2.log == []


async def test_url_validation():
    f = SafeFetcher(allow_private=True)
    try:
        for url in (
            "ftp://x/",
            "file:///etc/passwd",
            "http://user:pw@x.lan/",
            "http:///x",
            "gopher://x",
            "http://x .lan/",
            "http://x:99999/",
        ):
            with pytest.raises(FetchError) as ei:
                await f.request("GET", url, user_id="u")
            assert ei.value.kind == "invalid_url", url
    finally:
        await f.aclose()


async def test_response_size_cap(stub):
    stub.route("GET", "/big", 200, b"x" * 5000)
    f = SafeFetcher(allow_private=True, extra_allowed=["127.0.0.1/32"], max_body=1000)
    try:
        with pytest.raises(FetchError) as ei:
            await f.request("GET", stub.url + "/big", user_id="u")
        assert ei.value.kind == "too_large"
        res = await f.request("GET", stub.url + "/big", user_id="u", read_body=False)
        assert res.status == 200
    finally:
        await f.aclose()


async def test_timeout(stub):
    import time as _time

    def slow(_h, _b):
        _time.sleep(1.5)
        return 200, {}, b"late"

    stub.routes[("GET", "/slow")] = slow
    f = SafeFetcher(
        allow_private=True, extra_allowed=["127.0.0.1/32"], read_timeout=0.3, total_timeout=0.5
    )
    try:
        with pytest.raises(FetchError) as ei:
            await f.request("GET", stub.url + "/slow", user_id="u")
        assert ei.value.kind == "timeout"
        assert ei.value.message == "The request timed out"
    finally:
        await f.aclose()


async def test_per_user_rate_cap(stub):
    stub.route("GET", "/", 200)
    f = SafeFetcher(allow_private=True, extra_allowed=["127.0.0.1/32"], per_user_per_minute=3)
    try:
        for _ in range(3):
            await f.request("GET", stub.url + "/", user_id="alice", read_body=False)
        with pytest.raises(FetchError) as ei:
            await f.request("GET", stub.url + "/", user_id="alice")
        assert ei.value.kind == "busy"
        await f.request("GET", stub.url + "/", user_id="bob", read_body=False)
    finally:
        await f.aclose()

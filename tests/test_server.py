"""Slow-client defences of the real HTTP server (socket level, real uvicorn)."""

from __future__ import annotations

import contextlib
import socket
import sys
import threading
import time
from collections.abc import Iterator

import pytest
import uvicorn

from serverhub.server import ConnectionGate, guarded_protocol

HEADER_TIMEOUT = 0.6


async def tiny_app(scope, receive, send):
    if scope["type"] == "lifespan":
        while True:
            msg = await receive()
            if msg["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif msg["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    body = b""
    more = True
    while more:
        msg = await receive()
        if msg["type"] == "http.disconnect":
            return
        body += msg.get("body", b"")
        more = msg.get("more_body", False)
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok:%d" % len(body)})


@contextlib.contextmanager
def serve(**proto) -> Iterator[int]:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    config = uvicorn.Config(
        tiny_app,
        http=guarded_protocol(**proto),
        lifespan="on",
        log_level="error",
        server_header=False,
        timeout_keep_alive=5,
        timeout_graceful_shutdown=2,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        assert time.monotonic() < deadline, "server did not start"
        time.sleep(0.02)
    try:
        yield port
    finally:
        server.should_exit = True
        thread.join(10)
        sock.close()


def opts(**kw):
    base = {
        "max_connections": 64,
        "max_per_ip": 8,
        "header_timeout": HEADER_TIMEOUT,
        "body_idle_timeout": HEADER_TIMEOUT,
        "body_timeout": 3.0,
    }
    return {**base, **kw}


def connect(port: int, source: str | None = None) -> socket.socket:
    s = socket.create_connection(
        ("127.0.0.1", port), timeout=5, source_address=(source, 0) if source else None
    )
    return s


def closed_by_server(s: socket.socket, within: float) -> bool:
    s.settimeout(within)
    try:
        while True:
            data = s.recv(4096)
            if not data:
                return True
    except (ConnectionResetError, ConnectionAbortedError):
        return True
    except TimeoutError:
        return False


def get(port: int, source: str | None = None, path: str = "/healthz") -> bytes:
    s = connect(port, source)
    try:
        s.sendall(f"GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".encode())
        s.settimeout(5)
        out = b""
        while chunk := s.recv(4096):
            out += chunk
        return out
    finally:
        s.close()


def test_normal_requests_and_no_server_header():
    with serve(**opts()) as port:
        resp = get(port)
        assert resp.startswith(b"HTTP/1.1 200")
        assert b"\r\nserver:" not in resp.lower()


def test_idle_and_partial_heads_are_dropped():
    with serve(**opts()) as port:
        idle = connect(port)
        partial = connect(port)
        partial.sendall(b"GET /healthz HTTP/1.1\r\nHost: x\r\n")
        assert closed_by_server(idle, HEADER_TIMEOUT * 4)
        assert closed_by_server(partial, 1.0)
        assert get(port).startswith(b"HTTP/1.1 200")


def test_trickling_header_bytes_does_not_extend_the_deadline():
    with serve(**opts()) as port:
        s = connect(port)
        start = time.monotonic()
        s.sendall(b"GET /healthz HTTP/1.1\r\n")
        closed = False
        while time.monotonic() - start < HEADER_TIMEOUT * 5:
            try:
                s.sendall(b"X-a: b\r\n")
            except OSError:
                closed = True
                break
            if closed_by_server(s, 0.1):
                closed = True
                break
        assert closed
        assert time.monotonic() - start < HEADER_TIMEOUT * 4


def test_follow_up_request_on_keep_alive_has_a_deadline():
    with serve(**opts()) as port:
        s = connect(port)
        s.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        s.settimeout(5)
        assert s.recv(4096).startswith(b"HTTP/1.1 200")
        s.sendall(b"GET / HTTP/1.1\r\n")  # then stall mid-head
        assert closed_by_server(s, HEADER_TIMEOUT * 4)


def test_stalled_body_is_dropped_but_steady_body_is_fine():
    with serve(**opts()) as port:
        s = connect(port)
        s.sendall(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n0123456789")
        assert closed_by_server(s, HEADER_TIMEOUT * 4)

        s = connect(port)
        s.sendall(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 40\r\n\r\n")
        for _ in range(4):  # 4 x 0.3 s > header timeout, but steady progress
            time.sleep(HEADER_TIMEOUT / 2)
            s.sendall(b"x" * 10)
        s.settimeout(5)
        assert s.recv(4096).startswith(b"HTTP/1.1 200")
        s.close()


def test_body_total_deadline():
    with serve(**opts(body_timeout=1.5)) as port:
        s = connect(port)
        s.sendall(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n")
        start = time.monotonic()
        closed = False
        while time.monotonic() - start < 5:
            try:
                s.sendall(b"x")
            except OSError:
                closed = True
                break
            if closed_by_server(s, 0.2):
                closed = True
                break
        assert closed and time.monotonic() - start < 3


@pytest.mark.skipif(sys.platform == "darwin", reason="127.0.0.2 needs an alias on macOS")
def test_per_ip_cap_keeps_other_clients_served():
    with serve(**opts(max_per_ip=4, exempt_loopback=False)) as port:
        attackers = [connect(port, "127.0.0.2") for _ in range(4)]
        for a in attackers:
            a.sendall(b"GET / HTTP/1.1\r\n")
        time.sleep(0.1)
        extra = connect(port, "127.0.0.2")
        assert closed_by_server(extra, 0.5)  # over the per-IP cap: refused at once
        assert get(port, "127.0.0.1").startswith(b"HTTP/1.1 200")  # others unaffected
        for a in attackers:
            assert closed_by_server(a, HEADER_TIMEOUT * 4)
        # Slots are released when the slow connections are dropped.
        assert get(port, "127.0.0.2").startswith(b"HTTP/1.1 200")


def test_global_cap():
    with serve(**opts(max_connections=5, max_per_ip=100)) as port:
        held = [connect(port) for _ in range(5)]
        time.sleep(0.1)
        extra = connect(port)
        assert closed_by_server(extra, 0.5)
        for h in held:
            h.close()
        time.sleep(0.2)
        assert get(port).startswith(b"HTTP/1.1 200")


def test_gate_buckets():
    import ipaddress

    gate = ConnectionGate(10, 2, exempt=[ipaddress.ip_network("10.0.0.0/8")])
    assert gate.ip_key("127.0.0.1") is None  # loopback: tunnels and local proxies
    assert gate.ip_key("::1") is None
    assert gate.ip_key("10.1.2.3") is None  # trusted proxy
    assert gate.ip_key("::ffff:198.51.100.7") == "198.51.100.7"
    assert gate.ip_key("2001:db8::1") == gate.ip_key("2001:db8::2")
    k = gate.ip_key("198.51.100.7")
    assert gate.acquire(k) and gate.acquire(k) and not gate.acquire(k)
    gate.release(k)
    assert gate.acquire(k)
    assert gate.total == 2

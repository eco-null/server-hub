"""uvicorn's h11 protocol with slow-client (slowloris) defences.

Server Hub is exposed directly, without a reverse proxy, so the HTTP server
itself must refuse to be tied up by clients that open connections and then
send nothing, or send a request a byte at a time. Stock uvicorn has no
request-header or request-body read timeout (its keep-alive timer only runs
*between* requests). This subclass adds:

- a request-head deadline: the complete request line + headers must arrive
  within ``header_timeout`` seconds of the connection opening (or of the first
  byte of a follow-up keep-alive request). Trickling bytes does not extend it;
- a body-progress timeout: while a request body is being received, some bytes
  must arrive at least every ``body_idle_timeout`` seconds, and the whole body
  within ``body_timeout`` seconds (time the server itself paused reading for
  back-pressure does not count against the client);
- connection caps: at most ``max_per_ip`` concurrent connections per client
  address (IPv6 per /64) and ``max_connections`` overall. Loopback and
  trusted-proxy peers are exempt from the per-IP cap (a local tunnel or proxy
  carries many users), never from the global cap. Excess connections are
  closed immediately.

Everything else (TLS, keep-alive timeout, graceful shutdown, no Server header)
is plain uvicorn.
"""

from __future__ import annotations

import asyncio
import ipaddress
from collections.abc import Iterable
from typing import Any

import h11
from uvicorn.protocols.http.h11_impl import H11Protocol

from serverhub.http import limit_ip

Network = ipaddress.IPv4Network | ipaddress.IPv6Network

HEADER_TIMEOUT = 10.0
BODY_IDLE_TIMEOUT = 10.0
BODY_TIMEOUT = 120.0


class ConnectionGate:
    """Counts open connections per client address and in total."""

    def __init__(
        self,
        max_connections: int,
        max_per_ip: int,
        exempt: Iterable[Network] = (),
        exempt_loopback: bool = True,
    ) -> None:
        self.max_connections = max_connections
        self.max_per_ip = max_per_ip
        self.exempt = tuple(exempt)
        self.exempt_loopback = exempt_loopback
        self.total = 0
        self.by_ip: dict[str, int] = {}

    def ip_key(self, peer: str) -> str | None:
        """Per-IP bucket for ``peer``, or None when it is exempt from the per-IP cap."""
        try:
            addr = ipaddress.ip_address(peer.split("%", 1)[0])
        except ValueError:
            return limit_ip(peer)
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
            addr = addr.ipv4_mapped
        if self.exempt_loopback and addr.is_loopback:
            return None
        if any(addr.version == n.version and addr in n for n in self.exempt):
            return None
        return limit_ip(str(addr))

    def acquire(self, ip_key: str | None) -> bool:
        if self.total >= self.max_connections:
            return False
        if ip_key is not None:
            n = self.by_ip.get(ip_key, 0)
            if n >= self.max_per_ip:
                return False
            self.by_ip[ip_key] = n + 1
        self.total += 1
        return True

    def release(self, ip_key: str | None) -> None:
        self.total = max(0, self.total - 1)
        if ip_key is not None:
            n = self.by_ip.get(ip_key, 1) - 1
            if n <= 0:
                self.by_ip.pop(ip_key, None)
            else:
                self.by_ip[ip_key] = n


class GuardedH11Protocol(H11Protocol):
    gate: ConnectionGate
    header_timeout: float = HEADER_TIMEOUT
    body_idle_timeout: float = BODY_IDLE_TIMEOUT
    body_timeout: float = BODY_TIMEOUT

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._held = False
        self._ip_key: str | None = None
        self._timer: asyncio.TimerHandle | None = None
        self._phase: str | None = None  # "head" | "body" | None
        self._body_deadline = 0.0

    # -- connection accounting -------------------------------------------------

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
        super().connection_made(transport)
        peer = self.client[0] if self.client else ""
        self._ip_key = self.gate.ip_key(peer)
        if not self.gate.acquire(self._ip_key):
            self.connections.discard(self)
            transport.abort()
            return
        self._held = True
        self._start_head_phase()

    def connection_lost(self, exc: Exception | None) -> None:
        self._cancel_timer()
        self._phase = None
        if self._held:
            self._held = False
            self.gate.release(self._ip_key)
        super().connection_lost(exc)

    # -- timers ----------------------------------------------------------------

    def _cancel_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _start_head_phase(self) -> None:
        self._cancel_timer()
        self._phase = "head"
        self._timer = self.loop.call_later(self.header_timeout, self._on_timeout)

    def _arm_body_timer(self) -> None:
        self._cancel_timer()
        now = self.loop.time()
        if self._phase != "body":
            self._phase = "body"
            self._body_deadline = now + self.body_timeout
        delay = max(0.0, min(self.body_idle_timeout, self._body_deadline - now))
        self._timer = self.loop.call_later(delay, self._on_timeout)

    def _update_phase(self) -> None:
        if not self._held or self.transport.is_closing():
            self._cancel_timer()
            return
        state = self.conn.their_state
        if state is h11.IDLE:
            # Waiting for a request head. A fresh head phase starts with the
            # first byte of a follow-up request; idle time before that is
            # covered by uvicorn's keep-alive timeout.
            if self._phase != "head" and self.conn.trailing_data[0]:
                self._start_head_phase()
            elif self._phase == "body":
                self._cancel_timer()
                self._phase = None
        elif state is h11.SEND_BODY:
            self._arm_body_timer()
        else:
            self._cancel_timer()
            self._phase = None

    def _on_timeout(self) -> None:
        self._timer = None
        if self.transport.is_closing():
            return
        if self._phase == "body" and self.flow.read_paused:
            # We stopped reading (back-pressure), the client is not at fault.
            self._body_deadline += self.body_idle_timeout
            self._timer = self.loop.call_later(self.body_idle_timeout, self._on_timeout)
            return
        if self._phase in ("head", "body"):
            self.transport.close()

    # -- protocol hooks ----------------------------------------------------------

    def data_received(self, data: bytes) -> None:
        super().data_received(data)
        self._update_phase()

    def on_response_complete(self) -> None:
        super().on_response_complete()
        self._update_phase()


def guarded_protocol(
    *,
    max_connections: int,
    max_per_ip: int,
    exempt: Iterable[Network] = (),
    exempt_loopback: bool = True,
    header_timeout: float = HEADER_TIMEOUT,
    body_idle_timeout: float = BODY_IDLE_TIMEOUT,
    body_timeout: float = BODY_TIMEOUT,
) -> type[GuardedH11Protocol]:
    """A protocol class (for ``uvicorn.run(http=...)``) with its own connection gate."""
    gate = ConnectionGate(max_connections, max_per_ip, exempt, exempt_loopback)
    return type(
        "GuardedH11Protocol",
        (GuardedH11Protocol,),
        {
            "gate": gate,
            "header_timeout": header_timeout,
            "body_idle_timeout": body_idle_timeout,
            "body_timeout": body_timeout,
        },
    )

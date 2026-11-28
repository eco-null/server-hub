"""The single hardened outbound HTTP client (status checks and Beszel).

Defences:
- only http/https URLs with a host and without credentials;
- DNS is resolved exactly once per connection inside the transport, every
  address is checked, and the socket connects to the validated IP itself
  (the hostname stays in the URL for SNI, certificate checks and Host), so
  there is no window for DNS rebinding;
- loopback, link-local / cloud metadata, multicast, unspecified, reserved and
  IPv4-mapped / NAT64 / 6to4 / Teredo forms of those are always refused;
  RFC 1918 / ULA / CGNAT ranges are allowed only with
  SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS=true (the default);
- redirects are never followed, environment proxies are ignored, and response cookies are not
  retained between requests;
- URLs are parsed with the HTTP client's own parser before use (IDNA, control
  characters, port 0 are rejected), and any unexpected error becomes FetchError;
- strict timeouts, a total deadline and a response size cap; responses are
  requested with ``Accept-Encoding: identity`` so the cap applies to real bytes;
- the configured Docker API endpoint (SERVERHUB_DOCKER_HOST: its host name and
  every address it resolves to, on any port) is always refused, whatever
  SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS says, so a user- or label-supplied
  URL can never reach the socket proxy;
- per-user concurrency and request-rate caps plus a global concurrency cap;
  internal identities (Docker discovery status checks) can get their own caps;
- callers only ever see a short generic error message.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
import ssl
import time
import unicodedata
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable, Iterable
from contextvars import ContextVar
from dataclasses import dataclass
from http.cookiejar import CookieJar, DefaultCookiePolicy
from urllib.parse import SplitResult, urlsplit

import anyio
import httpcore
import httpx

log = logging.getLogger(__name__)

_QUIET_HTTP_LOGS: ContextVar[bool] = ContextVar("quiet_outbound_http_logs", default=False)


class _SensitiveUrlFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not _QUIET_HTTP_LOGS.get()


# HTTPX and httpcore log addresses and request details internally. Suppress
# those messages only in the coroutine handling a write-only destination.
_sensitive_url_filter = _SensitiveUrlFilter()
for _logger_name in (
    "httpx",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
    "httpcore.socks",
):
    logging.getLogger(_logger_name).addFilter(_sensitive_url_filter)

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Resolver = Callable[[str, int], Awaitable[list[str]]]

_N = ipaddress.ip_network
ALWAYS_BLOCKED = [
    _N("0.0.0.0/8"),  # "this network" / unspecified
    _N("127.0.0.0/8"),  # loopback
    _N("169.254.0.0/16"),  # link-local, cloud metadata
    _N("100.100.100.200/32"),  # Alibaba Cloud metadata (inside CGNAT)
    _N("192.0.0.0/24"),  # IETF protocol assignments (incl. 192.0.0.192 metadata)
    _N("224.0.0.0/4"),  # multicast
    _N("240.0.0.0/4"),  # reserved + broadcast
    _N("::/128"),  # unspecified
    _N("::1/128"),  # loopback
    _N("fe80::/10"),  # link-local
    _N("fec0::/10"),  # deprecated site-local
    _N("ff00::/8"),  # multicast
    _N("fd00:ec2::254/128"),  # AWS IMDS over IPv6 (inside ULA)
    _N("::ffff:0:0:0/96"),  # IPv4-translated ::ffff:0:a.b.c.d (RFC 2765 SIIT)
    _N("5f00::/16"),  # SRv6 SIDs (RFC 9602), never a public web host
]
PRIVATE_RANGES = [
    _N("10.0.0.0/8"),
    _N("172.16.0.0/12"),
    _N("192.168.0.0/16"),
    _N("100.64.0.0/10"),  # CGNAT (Tailscale etc.)
    _N("fc00::/7"),  # unique local
]
_NAT64 = _N("64:ff9b::/96")
_NAT64_LOCAL = _N("64:ff9b:1::/48")
_6TO4 = _N("2002::/16")


class FetchError(Exception):
    """Outbound request failed. ``message`` is safe to show to users."""

    MESSAGES = {
        "invalid_url": "The URL is not a valid http(s) address",
        "blocked": "That address is not allowed",
        "dns": "The host name could not be resolved",
        "timeout": "The request timed out",
        "connect": "Could not connect",
        "tls": "TLS handshake or certificate check failed",
        "too_large": "The response was too large",
        "protocol": "The server sent an invalid response",
        "busy": "Too many outbound requests, try again shortly",
    }

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind
        self.message = self.MESSAGES.get(kind, "Request failed")


DENY_RESOLVE_TTL = 30.0  # seconds a lookup of a refused host name is reused


def _host_key(host: str) -> str:
    return host.strip().strip("[]").lower().rstrip(".")


def _canonical_ip(ip: IPAddress) -> IPAddress:
    """IPv4 for IPv4-mapped / NAT64 / 6to4 / Teredo forms, else the address itself."""
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            return embedded
    return ip


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip in _NAT64 or ip in _NAT64_LOCAL:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip.teredo is not None:
        return ip.teredo[1]
    # IPv4-compatible (deprecated) ::a.b.c.d
    if int(ip) >> 32 == 0 and int(ip) > 1:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def address_allowed(
    ip: IPAddress,
    *,
    allow_private: bool,
    extra_allowed: Iterable[ipaddress.IPv4Network | ipaddress.IPv6Network] = (),
) -> bool:
    """Decide whether an outbound connection to ``ip`` is permitted."""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.scope_id:
            return False
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            return address_allowed(
                embedded, allow_private=allow_private, extra_allowed=extra_allowed
            )
    for net in extra_allowed:  # test hook only, never configurable at runtime
        if ip.version == net.version and ip in net:
            return True
    for net in ALWAYS_BLOCKED:
        if ip.version == net.version and ip in net:
            return False
    for net in PRIVATE_RANGES:
        if ip.version == net.version and ip in net:
            return allow_private
    # Everything left must be globally routable (rejects documentation,
    # benchmarking and other special-purpose ranges).
    return ip.is_global


async def system_resolver(host: str, port: int) -> list[str]:
    infos = await anyio.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


class _GuardedBackend(httpcore.AsyncNetworkBackend):
    """Resolves + validates the host, then dials the validated IP directly."""

    def __init__(self, fetcher: SafeFetcher) -> None:
        self._inner = httpcore.AnyIOBackend()
        self._fetcher = fetcher

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        ip = await self._fetcher.pick_address(host, port)
        return await self._inner.connect_tcp(
            ip, port, timeout=timeout, local_address=local_address, socket_options=socket_options
        )

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise httpcore.ConnectError("unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class _GuardedTransport(httpx.AsyncHTTPTransport):
    def __init__(self, fetcher: SafeFetcher, ssl_context: ssl.SSLContext) -> None:
        super().__init__(verify=ssl_context, trust_env=False, retries=0)
        if not isinstance(getattr(self, "_pool", None), httpcore.AsyncConnectionPool):
            raise RuntimeError(
                "httpx.AsyncHTTPTransport no longer has a '_pool' attribute; the SSRF guard "
                "cannot be installed with this httpx version (pin the version in requirements.lock)"
            )
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl_context,
            max_connections=64,
            max_keepalive_connections=16,
            keepalive_expiry=30.0,
            http1=True,
            http2=False,
            retries=0,
            network_backend=_GuardedBackend(fetcher),
        )


class _Blocked(Exception):
    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


@dataclass
class FetchResult:
    status: int
    headers: httpx.Headers
    body: bytes


def _bad_char(c: str) -> bool:
    return c.isspace() or unicodedata.category(c) in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp")


def check_url_syntax(url: str) -> SplitResult:
    """Parse ``url`` exactly as the fetcher will, or raise FetchError('invalid_url').

    Used both at input validation time and before every request, so a stored
    URL can never reach the HTTP client in a shape it cannot handle (IDNA
    failures, control characters, port 0, ...).
    """
    if not isinstance(url, str) or not url or len(url) > 2000 or any(_bad_char(c) for c in url):
        raise FetchError("invalid_url")
    try:
        parts = urlsplit(url)
        port = parts.port
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname or port == 0:
            raise FetchError("invalid_url")
        parsed = httpx.URL(url)  # the HTTP client's own parser (IDNA etc.)
        if not parsed.host:
            raise FetchError("invalid_url")
    except FetchError:
        raise
    except Exception:  # ValueError, httpx.InvalidURL, idna errors, ...
        raise FetchError("invalid_url") from None
    return parts


def validate_url(url: str) -> str:
    """Return an http(s) URL safe to hand to the client, or raise FetchError('invalid_url')."""
    parts = check_url_syntax(url)
    if parts.scheme not in ("http", "https"):
        raise FetchError("invalid_url")
    if parts.username is not None or parts.password is not None:
        raise FetchError("invalid_url")
    return url


class SafeFetcher:
    def __init__(
        self,
        *,
        allow_private: bool,
        resolver: Resolver | None = None,
        extra_allowed: Iterable[str] = (),
        connect_timeout: float = 4.0,
        read_timeout: float = 6.0,
        total_timeout: float = 10.0,
        max_body: int = 2 * 1024 * 1024,
        global_concurrency: int = 32,
        per_user_concurrency: int = 8,
        per_user_per_minute: int = 240,
        identity_limits: dict[str, tuple[int, int]] | None = None,
        deny_hosts: Iterable[str] = (),
        ssl_context: ssl.SSLContext | None = None,
    ) -> None:
        self.allow_private = allow_private
        self._resolver = resolver or system_resolver
        self._extra = [ipaddress.ip_network(n) for n in extra_allowed]
        # {identity: (concurrency, requests per minute)} overriding the per-user caps.
        self._identity_limits = dict(identity_limits or {})
        # Host names / IP literals that are never contacted (the Docker API endpoint).
        self._deny_names: frozenset[str] = frozenset()
        self._deny_ips: frozenset[IPAddress] = frozenset()
        self._deny_resolved: tuple[float, frozenset[IPAddress]] | None = None
        self.deny_hosts(deny_hosts)
        self._total = total_timeout
        self._max_body = max_body
        self._global = anyio.Semaphore(global_concurrency)
        self._per_user_conc = per_user_concurrency
        self._per_user_rate = per_user_per_minute
        self._users: OrderedDict[str, tuple[anyio.Semaphore, deque[float]]] = OrderedDict()
        ctx = ssl_context or ssl.create_default_context()
        self._client = httpx.AsyncClient(
            transport=_GuardedTransport(self, ctx),
            follow_redirects=False,
            trust_env=False,
            # The connection pool is shared across owners and integrations.
            cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=())),
            timeout=httpx.Timeout(read_timeout, connect=connect_timeout, pool=connect_timeout),
            # identity: the size cap applies to what we actually read, and no
            # decompression bomb can expand behind it.
            headers={"User-Agent": "ServerHub/2", "Accept": "*/*", "Accept-Encoding": "identity"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # -- refused hosts (the Docker API endpoint) -----------------------------------

    def deny_hosts(self, hosts: Iterable[str]) -> None:
        """Never contact these hosts: names (and every address they resolve to) or IPs."""
        names, ips = set(), set()
        for raw in hosts:
            key = _host_key(raw)
            if not key:
                continue
            try:
                ips.add(_canonical_ip(ipaddress.ip_address(key)))
            except ValueError:
                names.add(key)
        self._deny_names = frozenset(names)
        self._deny_ips = frozenset(ips)
        self._deny_resolved = None

    def host_denied(self, host: str) -> bool:
        key = _host_key(host)
        if key in self._deny_names:
            return True
        try:
            return _canonical_ip(ipaddress.ip_address(key)) in self._deny_ips
        except ValueError:
            return False

    async def _denied_addresses(self) -> frozenset[IPAddress]:
        if not self._deny_names:
            return self._deny_ips
        now = time.monotonic()
        cached = self._deny_resolved
        if cached is not None and now - cached[0] < DENY_RESOLVE_TTL:
            return self._deny_ips | cached[1]
        # Addresses seen before are kept (a failed lookup must not open a gap
        # while the endpoint is restarting); bounded.
        found: set[IPAddress] = set(cached[1]) if cached is not None else set()
        for name in self._deny_names:
            try:
                for cand in await self._resolver(name, 80):
                    try:
                        found.add(_canonical_ip(ipaddress.ip_address(cand.split("%", 1)[0])))
                    except ValueError:
                        continue
            except (OSError, UnicodeError):
                continue
        if len(found) > 64:
            found = set(list(found)[-64:])
        self._deny_resolved = (now, frozenset(found))
        return self._deny_ips | self._deny_resolved[1]

    # -- address selection (called from the transport for every new connection)

    async def pick_address(self, host: str, port: int) -> str:
        if self.host_denied(host):
            raise _Blocked("blocked")
        denied = await self._denied_addresses()
        literal = host.strip("[]")
        try:
            candidates = [str(ipaddress.ip_address(literal))]
        except ValueError:
            try:
                candidates = await self._resolver(host, port)
            except (OSError, UnicodeError):
                raise _Blocked("dns") from None
        if not candidates:
            raise _Blocked("dns")
        for cand in candidates:
            try:
                ip = ipaddress.ip_address(cand.split("%", 1)[0] if "%" in cand else cand)
            except ValueError:
                continue
            if "%" in cand:
                continue  # scoped (link-local) addresses are never allowed
            if _canonical_ip(ip) in denied:
                continue  # the Docker API endpoint, whatever the port
            if address_allowed(ip, allow_private=self.allow_private, extra_allowed=self._extra):
                return str(ip)
        raise _Blocked("blocked")

    # -- per-user caps ---------------------------------------------------------

    def _user_slot(self, user_id: str) -> tuple[anyio.Semaphore, deque[float]]:
        slot = self._users.get(user_id)
        if slot is None:
            conc = self._identity_limits.get(user_id, (self._per_user_conc, 0))[0]
            slot = (anyio.Semaphore(conc), deque())
            self._users[user_id] = slot
            while len(self._users) > 1024:
                self._users.popitem(last=False)
        else:
            self._users.move_to_end(user_id)
        return slot

    def _take_rate(self, stamps: deque[float], user_id: str) -> None:
        now = time.monotonic()
        while stamps and now - stamps[0] > 60:
            stamps.popleft()
        rate = self._identity_limits.get(user_id, (0, self._per_user_rate))[1]
        if len(stamps) >= rate:
            raise FetchError("busy")
        stamps.append(now)

    # -- the request -------------------------------------------------------------

    async def request(
        self,
        method: str,
        url: str,
        *,
        user_id: str,
        json: object | None = None,
        headers: dict[str, str] | None = None,
        read_body: bool = True,
        max_body: int | None = None,
        sensitive_url: bool = False,
    ) -> FetchResult:
        try:
            url = validate_url(url)
        except FetchError:
            raise
        except Exception:
            raise FetchError("invalid_url") from None
        if self.host_denied(urlsplit(url).hostname or ""):
            raise FetchError("blocked")
        sem, stamps = self._user_slot(user_id)
        self._take_rate(stamps, user_id)
        limit = self._max_body if max_body is None else max_body
        quiet_logs = _QUIET_HTTP_LOGS.set(True) if sensitive_url else None
        try:
            async with sem, self._global:
                with anyio.fail_after(self._total):
                    req = self._client.build_request(method, url, json=json, headers=headers)
                    resp = await self._client.send(req, stream=True)
                    try:
                        body = b""
                        if read_body:
                            declared = resp.headers.get("content-length")
                            if declared and declared.isdigit() and int(declared) > limit:
                                raise FetchError("too_large")
                            chunks, size = [], 0
                            async for chunk in resp.aiter_raw():
                                size += len(chunk)
                                if size > limit:
                                    raise FetchError("too_large")
                                chunks.append(chunk)
                            body = b"".join(chunks)
                        return FetchResult(resp.status_code, resp.headers, body)
                    finally:
                        await resp.aclose()
        except FetchError:
            raise
        except TimeoutError:
            raise FetchError("timeout") from None
        except httpx.TimeoutException:
            raise FetchError("timeout") from None
        except httpx.ConnectError as exc:
            raise FetchError(_classify_connect(exc)) from None
        except httpx.HTTPError:
            raise FetchError("protocol") from None
        except _Blocked as exc:
            raise FetchError(exc.kind) from None
        except Exception:
            # Anything unexpected (parser edge cases, library bugs) becomes our
            # own error type so callers never see a raw exception.
            log.warning("outbound request failed unexpectedly", exc_info=not sensitive_url)
            raise FetchError("protocol") from None
        finally:
            if quiet_logs is not None:
                _QUIET_HTTP_LOGS.reset(quiet_logs)


def _classify_connect(exc: BaseException) -> str:
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, _Blocked):
            return cur.kind
        if isinstance(cur, ssl.SSLError):
            return "tls"
        cur = cur.__cause__ or cur.__context__
    return "connect"

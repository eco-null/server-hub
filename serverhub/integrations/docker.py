"""Docker auto-discovery: a read-only Docker Engine API client and label parsing.

The client talks to an operator-configured endpoint (SERVERHUB_DOCKER_HOST),
normally a socket proxy that only allows ``GET /containers/json``. That target
is never user-supplied, so it does not go through the SSRF fetcher, but:

- the only request ever made is ``GET /containers/json?all=true`` (a fixed path,
  no user input reaches the URL);
- redirects are not followed, environment proxies are ignored;
- strict connect/read timeouts plus a total deadline, and a response size cap;
- a short TTL cache with single flight: concurrent callers share one upstream
  call, and failures are cached briefly so a dead endpoint is not hammered;
- callers only see an error *kind*; the API layer maps it to a safe message.

Everything returned by the Docker API is untrusted: label values come from
whoever can start containers. The number of containers processed, label
lengths and every string copied into a response are capped, and label values
go through the same validators as an ordinary service.

API reference: Docker Engine API v1.56 (``ContainerList`` /
``ContainerSummary``). The request uses the unversioned path, so the daemon
answers in its own (current) version; only fields that exist since long before
v1.41 are required, and the v1.52+ ``Health`` object is used when present
(older daemons: parsed from the ``Status`` text).
"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
import socket
import time
import unicodedata
from collections.abc import Collection
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import anyio
import httpx
from pydantic import ValidationError

from serverhub.api.schemas import KNOWN_CATEGORIES, KNOWN_ICONS, ServiceCreate

log = logging.getLogger(__name__)

CACHE_TTL = 10.0  # seconds a successful container list is reused
ERROR_TTL = 5.0  # seconds a failure is reused (no hammering of a dead endpoint)
MAX_BODY = 4 * 1024 * 1024
MAX_CONTAINERS = 500  # containers processed per listing; the rest are ignored
MAX_LABEL_VALUE = 2048  # longer serverhub.* label values are treated as invalid
MAX_PORTS = 64  # published ports looked at per container
CONNECT_TIMEOUT = 3.0
READ_TIMEOUT = 5.0
TOTAL_TIMEOUT = 8.0

LABEL_PREFIX = "serverhub."
STATES = frozenset({"running", "exited", "paused", "restarting", "created", "dead", "removing"})
_CONTAINER_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
_HEALTH_IN_STATUS = re.compile(r"\((healthy|unhealthy|health: starting)\)")

# Ports most likely to be a web UI, in order of preference.
WEB_PORTS = (
    80, 443, 8080, 3000, 8000, 8443, 5000, 8081, 8888, 9000, 8096, 8123, 9090,
    3001, 8001, 8082, 5001, 7878, 8989, 9443, 2283, 5678, 8384,
)  # fmt: skip
HTTPS_PORTS = frozenset({443, 8443, 9443})

# (substring of the image or container name, icon, category). First match wins.
HEURISTICS: tuple[tuple[str, str, str | None], ...] = (
    ("grafana", "chart", "Monitoring"),
    ("prometheus", "pulse", "Monitoring"),
    ("uptime-kuma", "activity", "Monitoring"),
    ("beszel", "activity", "Monitoring"),
    ("netdata", "activity", "Monitoring"),
    ("portainer", "layers", "Dev"),
    ("dozzle", "terminal", "Dev"),
    ("gitea", "git", "Dev"),
    ("forgejo", "git", "Dev"),
    ("gitlab", "git", "Dev"),
    ("code-server", "code", "Dev"),
    ("jenkins", "cog", "Dev"),
    ("postgres", "database", "Database"),
    ("mariadb", "database", "Database"),
    ("mysql", "database", "Database"),
    ("mongo", "database", "Database"),
    ("redis", "database", "Database"),
    ("adminer", "database", "Database"),
    ("vaultwarden", "key", "Security"),
    ("bitwarden", "key", "Security"),
    ("authelia", "shield", "Security"),
    ("authentik", "shield", "Security"),
    ("crowdsec", "shield", "Security"),
    ("pihole", "shield", "Network"),
    ("adguard", "shield", "Network"),
    ("wireguard", "lock", "Network"),
    ("wg-easy", "lock", "Network"),
    ("unifi", "wifi", "Network"),
    ("jellyfin", "film", "Media"),
    ("plex", "film", "Media"),
    ("emby", "film", "Media"),
    ("sonarr", "film", "Media"),
    ("radarr", "film", "Media"),
    ("navidrome", "music", "Media"),
    ("lidarr", "music", "Media"),
    ("audiobookshelf", "headphones", "Books"),
    ("calibre", "book", "Books"),
    ("kavita", "book", "Books"),
    ("immich", "image", "Media"),
    ("photoprism", "camera", "Media"),
    ("qbittorrent", "download", "Media"),
    ("transmission", "download", "Media"),
    ("sabnzbd", "download", "Media"),
    ("nextcloud", "cloud", "Files"),
    ("seafile", "cloud", "Files"),
    ("syncthing", "refresh", "Files"),
    ("filebrowser", "folder", "Files"),
    ("paperless", "file", "Productivity"),
    ("bookstack", "book", "Productivity"),
    ("wiki", "book", "Productivity"),
    ("vikunja", "calendar", "Productivity"),
    ("homeassistant", "home", "Home"),
    ("home-assistant", "home", "Home"),
    ("node-red", "zap", "Home"),
    ("mosquitto", "broadcast", "Home"),
    ("ollama", "sparkles", "AI"),
    ("open-webui", "sparkles", "AI"),
    ("searxng", "globe", "Search"),
    ("matrix", "message", "Communication"),
    ("synapse", "message", "Communication"),
    ("mailu", "mail", "Communication"),
    ("firefly", "wallet", "Finance"),
    ("actual", "wallet", "Finance"),
    ("n8n", "zap", "Productivity"),
    ("nginx", "globe", None),
    ("httpd", "globe", None),
    ("caddy", "globe", None),
)
_CATEGORY_BY_LOWER = {c.lower(): c for c in KNOWN_CATEGORIES}


class DockerError(Exception):
    """The Docker API could not be used. ``kind`` is mapped to a safe message."""

    def __init__(self, kind: str, status: int | None = None) -> None:
        super().__init__(kind)
        self.kind = kind
        self.status = status


# ---- small helpers ---------------------------------------------------------------


def clean_text(v: object, limit: int) -> str:
    """A printable, single-line, length-capped copy of an untrusted value."""
    if not isinstance(v, str):
        return ""
    out = []
    for c in v[: limit * 2]:
        cat = unicodedata.category(c)
        if cat in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"):
            if c in "\t\n\r":
                out.append(" ")
            continue
        out.append(c)
    return "".join(out).strip()[:limit]


def container_name(c: dict) -> str | None:
    """The container's own name (Docker's ``/name``), or None if unusable."""
    names = c.get("Names")
    if not isinstance(names, list):
        return None
    for n in names[:16]:
        if isinstance(n, str) and n.count("/") == 1 and n.startswith("/"):
            name = n[1:]
            if _CONTAINER_NAME.match(name):
                return name
    return None


def prettify(name: str) -> str:
    """``my_app-1`` -> ``My App``; ``server-hub`` -> ``Server Hub``."""
    base = re.sub(r"[-_]\d+$", "", name) or name
    words = [w for w in re.split(r"[-_.\s]+", base) if w]
    pretty = " ".join(w[:1].upper() + w[1:] for w in words)
    return (pretty or name)[:200]


def guess_icon_category(*hints: str) -> tuple[str, str | None]:
    hay = " ".join(h.lower() for h in hints if h)
    for needle, icon, category in HEURISTICS:
        if needle in hay:
            return icon, category
    return "box", None


def _image(c: dict) -> str:
    return clean_text(c.get("Image"), 300)


def _image_base(image: str) -> str:
    """``ghcr.io/org/app:1.2@sha256:..`` -> ``app``."""
    ref = image.split("@", 1)[0]
    last = ref.rsplit("/", 1)[-1]
    return last.split(":", 1)[0]


def _labels(c: dict) -> dict:
    labels = c.get("Labels")
    return labels if isinstance(labels, dict) else {}


def _state(c: dict) -> str | None:
    state = c.get("State")
    return state if isinstance(state, str) and state in STATES else None


def _health(c: dict) -> str | None:
    h = c.get("Health")
    if isinstance(h, dict) and isinstance(h.get("Status"), str):
        status = h["Status"]
        return status if status in ("healthy", "unhealthy", "starting") else None
    status = c.get("Status")
    if isinstance(status, str):
        m = _HEALTH_IN_STATUS.search(status[:300])
        if m:
            return "starting" if m.group(1) == "health: starting" else m.group(1)
    return None


def _flag(raw: str) -> bool | None:
    v = raw.strip().lower()
    if v in ("true", "1", "yes", "on"):
        return True
    if v in ("false", "0", "no", "off"):
        return False
    return None


def published_ports(c: dict) -> list[dict]:
    """Published ports, de-duplicated (IPv4 + IPv6 bindings), loopback-only ones dropped."""
    ports = c.get("Ports")
    if not isinstance(ports, list):
        return []
    seen: set[tuple[int, int, str]] = set()
    out = []
    for p in ports[:MAX_PORTS]:
        if not isinstance(p, dict):
            continue
        private, public, proto = p.get("PrivatePort"), p.get("PublicPort"), p.get("Type")
        if not all(isinstance(x, int) and not isinstance(x, bool) for x in (private, public)):
            continue
        if not (0 < private < 65536 and 0 < public < 65536) or proto not in ("tcp", "udp"):
            continue
        ip = p.get("IP")
        if isinstance(ip, str) and ip:
            try:
                if ipaddress.ip_address(ip).is_loopback:
                    continue  # bound to the Docker host's loopback only
            except ValueError:
                pass
        key = (private, public, proto)
        if key not in seen:
            seen.add(key)
            out.append({"private": private, "public": public, "protocol": proto})
    out.sort(key=lambda p: (p["protocol"], p["private"], p["public"]))
    return out


def web_port(ports: list[dict]) -> dict | None:
    """The published TCP port most likely to be a web UI."""
    tcp = [p for p in ports if p["protocol"] == "tcp"]
    if not tcp:
        return None
    rank = {port: i for i, port in enumerate(WEB_PORTS)}
    return min(tcp, key=lambda p: (rank.get(p["private"], len(rank)), p["private"], p["public"]))


def url_host(public_host: str) -> str:
    try:
        if ipaddress.ip_address(public_host).version == 6:
            return f"[{public_host}]"
    except ValueError:
        pass
    return public_host


def suggested_url(public_host: str | None, port: dict | None) -> str | None:
    if not public_host or port is None:
        return None
    https = port["private"] in HTTPS_PORTS or port["public"] in HTTPS_PORTS
    scheme = "https" if https else "http"
    default = 443 if https else 80
    suffix = "" if port["public"] == default else f":{port['public']}"
    return f"{scheme}://{url_host(public_host)}{suffix}"


def normalize_url(url: str) -> str:
    """Comparison key for "is this URL already one of my services?"."""
    try:
        parts = urlsplit(url.strip())
        scheme = parts.scheme.lower()
        host = (parts.hostname or "").lower()
        port = parts.port or (443 if scheme == "https" else 80)
    except ValueError:
        return url.strip().lower()
    path = parts.path.rstrip("/")
    return f"{scheme}://{host}:{port}{path}"


# ---- discovery -------------------------------------------------------------------


@dataclass
class Discovery:
    services: list[dict] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)


def _label(labels: dict, key: str) -> tuple[str | None, bool]:
    """(value, present). Over-long or non-string values count as present but invalid."""
    if LABEL_PREFIX + key not in labels:
        return None, False
    v = labels[LABEL_PREFIX + key]
    if not isinstance(v, str) or len(v) > MAX_LABEL_VALUE:
        return None, True
    return v, True


def _service_from_labels(c: dict, name: str, labels: dict, out: Discovery) -> dict | None:
    def warn(reason: str) -> None:
        out.warnings.append({"container": name, "reason": reason})

    image = _image(c)
    default_icon, _ = guess_icon_category(_image_base(image), name)

    url, present = _label(labels, "url")
    if url is None:
        reason = "serverhub.url is missing" if not present else "serverhub.url is invalid"
        out.skipped.append({"container": name, "reason": reason})
        return None

    fields: dict[str, Any] = {"url": url, "name": prettify(name), "icon": default_icon}

    raw, present = _label(labels, "name")
    if present:
        value = clean_text(raw, 400) if raw is not None else ""
        if value:
            fields["name"] = value
        else:
            warn("serverhub.name is empty or invalid; using the container name")

    raw, present = _label(labels, "description")
    if present:
        if raw is None:
            warn("serverhub.description is invalid; ignored")
        else:
            fields["description"] = clean_text(raw, 1000)

    raw, present = _label(labels, "icon")
    if present:
        value = (raw or "").strip().lower()
        if value in KNOWN_ICONS:
            fields["icon"] = value
        else:
            warn("serverhub.icon is not a known icon id; using a default")

    raw, present = _label(labels, "category")
    if present:
        value = _CATEGORY_BY_LOWER.get((raw or "").strip().lower())
        if value is not None:
            fields["category"] = value
        elif (raw or "").strip():
            warn("serverhub.category is not a known category id; using auto")

    raw, present = _label(labels, "check")
    if present:
        flag = _flag(raw) if raw is not None else None
        if flag is None:
            warn("serverhub.check must be true or false; using true")
        else:
            fields["check"] = flag

    # The same validators as an ordinary service. A bad URL skips the container;
    # any other bad field falls back to its default.
    defaults = {"name": prettify(name), "description": "", "icon": "box", "category": None}
    for _ in range(len(defaults) + 1):
        try:
            svc = ServiceCreate.model_validate(fields)
            break
        except ValidationError as exc:
            bad = {str(e["loc"][0]) for e in exc.errors() if e["loc"]}
            if "url" in bad or not bad or not bad <= defaults.keys():
                out.skipped.append(
                    {"container": name, "reason": "serverhub.url is not a valid http(s) URL"}
                )
                return None
            for f in sorted(bad):
                warn(f"serverhub.{f} is invalid; using a default")
                fields[f] = defaults[f]
    else:  # pragma: no cover - defaults always validate
        return None

    status = clean_text(c.get("Status"), 200)
    return {
        "id": f"docker:{name}",
        "name": svc.name,
        "url": svc.url,
        "description": svc.description,
        "icon": svc.icon,
        "category": svc.category,
        "check": svc.check,
        "container": {
            "name": name,
            "image": image,
            "state": _state(c),
            "status": status,
            "health": _health(c),
        },
    }


def discover(containers: list[Any]) -> Discovery:
    """Service cards for every container labelled ``serverhub.enable=true``."""
    out = Discovery()
    for c in containers[:MAX_CONTAINERS]:
        if not isinstance(c, dict):
            continue
        labels = _labels(c)
        enable = labels.get(LABEL_PREFIX + "enable")
        if not isinstance(enable, str) or _flag(enable[:16]) is not True:
            continue
        name = container_name(c)
        if name is None:
            out.skipped.append({"container": "?", "reason": "container has no usable name"})
            continue
        if _state(c) is None:
            out.skipped.append({"container": name, "reason": "unknown container state"})
            continue
        svc = _service_from_labels(c, name, labels, out)
        if svc is not None:
            out.services.append(svc)
    if len(containers) > MAX_CONTAINERS:
        out.warnings.append(
            {
                "container": "*",
                "reason": f"only the first {MAX_CONTAINERS} containers were examined",
            }
        )
    out.services.sort(key=lambda s: (s["name"].lower(), s["id"]))
    return out


def suggest(
    containers: list[Any],
    *,
    public_host: str | None,
    existing_urls: set[str],
    exclude_names: Collection[str] = (),
    exclude_id_prefix: str | None = None,
) -> list[dict]:
    """Running, unlabelled containers that publish at least one TCP port."""
    existing = {normalize_url(u) for u in existing_urls}
    out = []
    for c in containers[:MAX_CONTAINERS]:
        if not isinstance(c, dict) or _state(c) != "running":
            continue
        if LABEL_PREFIX + "enable" in _labels(c):
            continue  # labelled (either way): discovered or explicitly opted out
        name = container_name(c)
        if name is None or name in exclude_names:
            continue
        cid = c.get("Id")
        if exclude_id_prefix and isinstance(cid, str) and cid.startswith(exclude_id_prefix):
            continue  # Server Hub's own container
        ports = published_ports(c)
        best = web_port(ports)
        if best is None:
            continue
        url = suggested_url(public_host, best)
        if url is not None and normalize_url(url) in existing:
            continue
        image = _image(c)
        icon, category = guess_icon_category(_image_base(image), name)
        out.append(
            {
                "container": {"name": name, "image": image, "state": "running"},
                "ports": ports,
                "suggested": {
                    "name": prettify(name),
                    "url": url,
                    "icon": icon,
                    "category": category,
                },
            }
        )
    out.sort(key=lambda s: s["container"]["name"].lower())
    return out


# ---- the client ------------------------------------------------------------------


def own_container_id_prefix() -> str | None:
    """Docker sets a container's hostname to its short id unless overridden."""
    try:
        host = socket.gethostname().strip().lower()
    except OSError:
        return None
    return host if re.fullmatch(r"[0-9a-f]{12,64}", host) else None


class DockerClient:
    def __init__(
        self,
        base_url: str,
        *,
        connect_timeout: float = CONNECT_TIMEOUT,
        read_timeout: float = READ_TIMEOUT,
        total_timeout: float = TOTAL_TIMEOUT,
        max_body: int = MAX_BODY,
        ttl: float = CACHE_TTL,
        error_ttl: float = ERROR_TTL,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.host = urlsplit(self.base_url).hostname or ""
        self._total = total_timeout
        self._max_body = max_body
        self._ttl = ttl
        self._error_ttl = error_ttl
        self._lock = anyio.Lock()
        self._cache: tuple[float, list | DockerError] | None = None
        self.self_id_prefix = own_container_id_prefix()
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(read_timeout, connect=connect_timeout, pool=connect_timeout),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
            headers={
                "User-Agent": "ServerHub/2",
                "Accept": "application/json",
                "Accept-Encoding": "identity",
            },
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _cached(self) -> list | DockerError | None:
        if self._cache is None:
            return None
        ts, value = self._cache
        ttl = self._error_ttl if isinstance(value, DockerError) else self._ttl
        return value if time.monotonic() - ts < ttl else None

    async def containers(self) -> list:
        """All containers (``all=true``), cached; raises DockerError."""
        hit = self._cached()
        if hit is None:
            async with self._lock:  # single flight
                hit = self._cached()
                if hit is None:
                    try:
                        hit = await self._fetch()
                    except DockerError as exc:
                        hit = exc
                    self._cache = (time.monotonic(), hit)
        if isinstance(hit, DockerError):
            raise DockerError(hit.kind, hit.status)
        return hit

    async def _fetch(self) -> list:
        try:
            with anyio.fail_after(self._total):
                req = self._client.build_request("GET", "/containers/json", params={"all": "true"})
                resp = await self._client.send(req, stream=True)
                try:
                    if resp.status_code != 200:
                        kind = "denied" if resp.status_code in (401, 403) else "http"
                        raise DockerError(kind, resp.status_code)
                    declared = resp.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > self._max_body:
                        raise DockerError("too_large")
                    chunks, size = [], 0
                    async for chunk in resp.aiter_raw():
                        size += len(chunk)
                        if size > self._max_body:
                            raise DockerError("too_large")
                        chunks.append(chunk)
                finally:
                    await resp.aclose()
        except DockerError:
            raise
        except TimeoutError:
            raise DockerError("timeout") from None
        except httpx.TimeoutException:
            raise DockerError("timeout") from None
        except httpx.ConnectError:
            raise DockerError("connect") from None
        except httpx.HTTPError:
            raise DockerError("protocol") from None
        except Exception:
            log.warning("Docker API request failed unexpectedly", exc_info=True)
            raise DockerError("protocol") from None
        try:
            data = json.loads(b"".join(chunks))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise DockerError("protocol") from None
        if not isinstance(data, list):
            raise DockerError("protocol")
        return data

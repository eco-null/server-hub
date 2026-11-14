"""Beszel (PocketBase) client: auth, systems listing and normalisation.

Tokens are reused per instance and results cached briefly. Cache keys are
``(instance_id, revision)``: they never contain URLs or credentials, and any
edit to the instance bumps the revision so stale tokens are never reused.
Only plain dicts and short strings are cached, never exception objects.
"""

from __future__ import annotations

import json
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import anyio

from serverhub.integrations.fetcher import FetchError, SafeFetcher, check_url_syntax

log = logging.getLogger(__name__)

TOKEN_TTL = 15 * 60.0
RESULT_TTL = 15.0
ERROR_TTL = 5.0
CACHE_MAX = 256
MAX_BODY = 4 * 1024 * 1024


class BeszelError(Exception):
    """Failure with a message that is safe to show to the user."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Target:
    url: str
    username: str
    password: str


GENERIC_ERROR = "Could not reach Beszel or sign in; check the URL and credentials"


def base_url(url: str) -> str:
    """scheme://host[:port][/prefix] of a stored Beszel URL.

    Query, fragment and credentials are dropped (rows saved before they were
    rejected at input), and API paths are always joined onto this base.
    """
    try:
        check_url_syntax(url)
        parts = urlsplit(url)
        if "@" in parts.netloc:
            raise BeszelError(FetchError.MESSAGES["invalid_url"])
    except FetchError as exc:
        raise BeszelError(exc.message) from None
    return f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")


def _pct(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    return round(min(100.0, max(0.0, float(v))), 1)


def normalize_system(rec: dict) -> dict:
    """Map a PocketBase ``systems`` record to the API ``System`` shape.

    Live stats sit in ``info`` (an object or a JSON string): ``cpu`` (%),
    ``mp`` (memory %), ``dp`` (disk %), ``u`` (uptime seconds).
    """
    info = rec.get("info") or {}
    if isinstance(info, str):
        try:
            info = json.loads(info)
        except ValueError:
            info = {}
    if not isinstance(info, dict):
        info = {}
    uptime = info.get("u")
    status = rec.get("status")
    return {
        "name": str(rec.get("name") or "")[:200],
        "status": str(status)[:32] if isinstance(status, str) and status else "unknown",
        "host": str(rec.get("host"))[:255] if isinstance(rec.get("host"), str) else None,
        "cpu": _pct(info.get("cpu")),
        "memory": _pct(info.get("mp")),
        "disk": _pct(info.get("dp")),
        "uptime_seconds": int(uptime)
        if isinstance(uptime, int | float) and not isinstance(uptime, bool) and uptime >= 0
        else None,
    }


class _LRU:
    def __init__(self, maxlen: int) -> None:
        self._d: OrderedDict = OrderedDict()
        self._max = maxlen

    def get(self, key, ttl: float):
        hit = self._d.get(key)
        if hit is None:
            return None
        ts, value, value_ttl = hit
        if time.monotonic() - ts >= (value_ttl if value_ttl is not None else ttl):
            self._d.pop(key, None)
            return None
        return value

    def put(self, key, value, ttl: float | None = None) -> None:
        self._d[key] = (time.monotonic(), value, ttl)
        self._d.move_to_end(key)
        while len(self._d) > self._max:
            self._d.popitem(last=False)

    def drop(self, key) -> None:
        self._d.pop(key, None)

    def drop_instance(self, instance_id: str) -> None:
        for k in [k for k in self._d if k[0] == instance_id]:
            self._d.pop(k, None)


class BeszelClient:
    def __init__(self, fetcher: SafeFetcher) -> None:
        self._fetcher = fetcher
        self._tokens = _LRU(CACHE_MAX)
        self._results = _LRU(CACHE_MAX)

    def forget(self, instance_id: str) -> None:
        self._tokens.drop_instance(instance_id)
        self._results.drop_instance(instance_id)

    async def _call(self, method: str, url: str, user_id: str, **kw: Any) -> tuple[int, Any]:
        try:
            res = await self._fetcher.request(method, url, user_id=user_id, max_body=MAX_BODY, **kw)
        except FetchError as exc:
            raise BeszelError(exc.message) from None
        if 300 <= res.status < 400:
            raise BeszelError("The Beszel URL redirects; use the final address")
        try:
            data = json.loads(res.body) if res.body else None
        except ValueError:
            data = None
        return res.status, data

    async def login(self, target: Target, user_id: str) -> tuple[str, str | None]:
        """Authenticate; returns (token, display name). Tries users, then _superusers."""
        base = base_url(target.url)
        payload = {"identity": target.username, "password": target.password}
        for collection in ("users", "_superusers"):
            status, data = await self._call(
                "POST",
                f"{base}/api/collections/{collection}/auth-with-password",
                user_id,
                json=payload,
            )
            if status == 200 and isinstance(data, dict) and isinstance(data.get("token"), str):
                rec = data.get("record") if isinstance(data.get("record"), dict) else {}
                name = rec.get("username") or rec.get("name") or rec.get("email")
                return data["token"], (str(name)[:200] if name else None)
            if status in (400, 401, 403, 404) and collection == "users":
                continue
            if status in (400, 401, 403):
                raise BeszelError("Beszel rejected the username or password")
            if status == 404:
                raise BeszelError("No Beszel API found at that URL")
            if status == 429:
                raise BeszelError("Beszel is rate limiting sign-ins, try again later")
            raise BeszelError(f"Beszel returned HTTP {status}")
        raise BeszelError("Beszel rejected the username or password")

    async def _systems_with_token(self, base: str, token: str, user_id: str) -> list[dict] | None:
        status, data = await self._call(
            "GET",
            f"{base}/api/collections/systems/records?perPage=200&sort=name",
            user_id,
            headers={"Authorization": token, "Accept": "application/json"},
        )
        if status in (401, 403):
            return None
        if status != 200 or not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise BeszelError(f"Unexpected response from Beszel (HTTP {status})")
        return [normalize_system(r) for r in data["items"] if isinstance(r, dict)]

    async def systems(self, key: tuple[str, int], target: Target, user_id: str) -> list[dict]:
        """Systems for a stored instance, using cached token/results under ``key``."""
        cached = self._results.get(key, RESULT_TTL)
        if cached is not None:
            if isinstance(cached, str):
                raise BeszelError(cached)
            return cached
        try:
            base = base_url(target.url)
            token = self._tokens.get(key, TOKEN_TTL)
            items = None
            if token:
                items = await self._systems_with_token(base, token, user_id)
            if items is None:
                token, _ = await self.login(target, user_id)
                self._tokens.put(key, token)
                items = await self._systems_with_token(base, token, user_id)
                if items is None:
                    self._tokens.drop(key)
                    raise BeszelError("Beszel denied access to the systems list")
        except BeszelError as exc:
            self._results.put(key, exc.message, ERROR_TTL)
            raise
        self._results.put(key, items)
        return items

    async def test(self, target: Target, user_id: str) -> tuple[str | None, int]:
        """Check credentials and API access without caching. Returns (name, system count)."""
        base = base_url(target.url)
        token, name = await self.login(target, user_id)
        items = await self._systems_with_token(base, token, user_id)
        if items is None:
            raise BeszelError("Beszel denied access to the systems list")
        return name, len(items)

    async def fan_out(
        self, user_id: str, instances: list[tuple[dict, Target | None]]
    ) -> list[dict]:
        """Query all instances in parallel; one failing never affects the others."""
        results: list[dict] = []
        for inst, _ in instances:
            results.append(
                {"id": inst["id"], "name": inst["name"], "ok": False, "error": None, "systems": []}
            )

        async def run(i: int, inst: dict, target: Target | None) -> None:
            if target is None:
                results[i]["error"] = "Stored password cannot be decrypted; re-enter it"
                return
            try:
                results[i]["systems"] = await self.systems(
                    (inst["id"], inst["revision"]), target, user_id
                )
                results[i]["ok"] = True
            except BeszelError as exc:
                results[i]["error"] = exc.message
            except Exception:
                log.warning("Beszel query failed unexpectedly", exc_info=True)
                results[i]["error"] = GENERIC_ERROR

        async with anyio.create_task_group() as tg:
            for i, (inst, target) in enumerate(instances):
                tg.start_soon(run, i, inst, target)
        return results

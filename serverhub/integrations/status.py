"""Server-side service status checks with a TTL cache and bounded concurrency.

Two kinds of targets:

- a user's own services are checked under that user's identity (the fetcher's
  per-user budget) and cached per (user, URL), so one user's results never
  answer another user's check;
- discovered Docker services are checked under ONE internal identity
  (``DISCOVERY_IDENTITY``) with its own fetcher budget, and cached per URL,
  shared by every viewer allowed to see them. Any number of viewers causes at
  most one outbound request per URL per TTL, and a large number of labelled
  containers can never use up a user's own budget. Per-role detail stripping
  happens at response time, not here.

Concurrent checks of the same cache key share one request (single flight).
"""

from __future__ import annotations

import logging
import time
from collections import OrderedDict
from datetime import UTC, datetime
from operator import itemgetter

import anyio

from serverhub.integrations.fetcher import FetchError, SafeFetcher

log = logging.getLogger(__name__)

CACHE_TTL = 20.0
CACHE_MAX = 4096
SWEEP_DEADLINE = 12.0
SWEEP_CONCURRENCY = 12
# Internal fetcher identity for discovered services (not a user id: user ids are UUIDs).
DISCOVERY_IDENTITY = "docker-discovery"
# Its own fetcher budget: (concurrency, requests per minute). At most
# MAX_DISCOVERED_CHECKS URLs are checked, each at most once per CACHE_TTL
# (100 * 60 / 20 = 300 per minute), so 600 leaves headroom.
DISCOVERY_LIMITS = (8, 600)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def unknown() -> dict:
    return {"state": "unknown", "http_status": None, "latency_ms": None, "checked_at": None}


def not_running() -> dict:
    """A discovered service whose container is not running: down, no request made."""
    return {
        "state": "down",
        "http_status": None,
        "latency_ms": None,
        "checked_at": _iso(time.time()),
    }


class StatusChecker:
    def __init__(self, fetcher: SafeFetcher, ttl: float = CACHE_TTL) -> None:
        self._fetcher = fetcher
        self._ttl = ttl
        # Keyed by (identity, URL). Values hold no secrets. Bounded LRU.
        self._cache: OrderedDict[tuple[str, str], tuple[float, dict]] = OrderedDict()
        self._user_locks: OrderedDict[str, anyio.Lock] = OrderedDict()
        self._inflight: dict[tuple[str, str], anyio.Event] = {}

    def _cached(self, key: tuple[str, str]) -> dict | None:
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < self._ttl:
            return hit[1]
        return None

    def _store(self, key: tuple[str, str], result: dict) -> None:
        self._cache[key] = (time.monotonic(), result)
        self._cache.move_to_end(key)
        while len(self._cache) > CACHE_MAX:
            self._cache.popitem(last=False)

    def _lock_for(self, user_id: str) -> anyio.Lock:
        lock = self._user_locks.get(user_id)
        if lock is None:
            lock = self._user_locks[user_id] = anyio.Lock()
            while len(self._user_locks) > 1024:
                self._user_locks.popitem(last=False)
        return lock

    async def check_one(self, url: str, user_id: str) -> dict:
        key = (user_id, url)
        cached = self._cached(key)
        if cached is not None:
            return cached
        pending = self._inflight.get(key)
        if pending is not None:  # somebody is already checking this key
            await pending.wait()
            return self._cached(key) or unknown()
        done = self._inflight[key] = anyio.Event()
        try:
            return await self._check(key)
        finally:
            del self._inflight[key]
            done.set()

    async def _check(self, key: tuple[str, str]) -> dict:
        user_id, url = key
        started = time.monotonic()
        try:
            res = await self._fetcher.request("GET", url, user_id=user_id, read_body=False)
            latency = round((time.monotonic() - started) * 1000)
            result = {
                "state": "up" if res.status < 500 else "down",
                "http_status": res.status,
                "latency_ms": latency,
                "checked_at": _iso(time.time()),
            }
        except FetchError as exc:
            # Refused targets are "unknown" (we did not try); failures are "down".
            state = "unknown" if exc.kind in ("blocked", "invalid_url", "busy") else "down"
            result = {
                "state": state,
                "http_status": None,
                "latency_ms": None,
                "checked_at": _iso(time.time()),
            }
            if exc.kind == "busy":
                return result  # do not cache throttling
        self._store(key, result)
        return result

    async def _sweep(self, identity: str, targets: list[tuple[str, str]], out: dict) -> None:
        due = []
        for sid, url in targets:
            key = (identity, url)
            cached = self._cached(key)
            if cached is not None:
                out[sid] = cached
            else:
                last = self._cache.get(key)
                due.append((last[0] if last else float("-inf"), sid, url))
        if not due:
            return

        limiter = anyio.Semaphore(SWEEP_CONCURRENCY)

        async def run(sid: str, url: str) -> None:
            async with limiter:
                try:
                    out[sid] = await self.check_one(url, identity)
                except Exception:
                    # One bad target must never break the whole sweep.
                    log.warning("status check failed unexpectedly", exc_info=True)

        with anyio.move_on_after(SWEEP_DEADLINE):
            async with anyio.create_task_group() as tg:
                # Under load, give unchecked and oldest targets the first available slots.
                for _, sid, url in sorted(due, key=itemgetter(0)):
                    tg.start_soon(run, sid, url)

    async def check_many(self, user_id: str, targets: list[tuple[str, str]]) -> dict[str, dict]:
        """``targets`` = [(service_id, url)]; anything unfinished at the deadline is unknown."""
        out: dict[str, dict] = {sid: unknown() for sid, _ in targets}
        if not targets:
            return out
        # One sweep per user at a time; concurrent polls wait and then hit the cache.
        async with self._lock_for(user_id):
            await self._sweep(user_id, targets, out)
        return out

    async def check_discovered(self, targets: list[tuple[str, str]]) -> dict[str, dict]:
        """Discovered services, under the shared discovery identity and cache.

        No per-viewer lock: concurrent viewers share in-flight checks per URL.
        """
        out: dict[str, dict] = {sid: unknown() for sid, _ in targets}
        if targets:
            await self._sweep(DISCOVERY_IDENTITY, targets, out)
        return out

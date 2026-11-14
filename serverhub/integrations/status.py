"""Server-side service status checks with a TTL cache and bounded concurrency."""

from __future__ import annotations

import time
from collections import OrderedDict
from datetime import UTC, datetime

import anyio

from serverhub.integrations.fetcher import FetchError, SafeFetcher

CACHE_TTL = 20.0
CACHE_MAX = 4096
SWEEP_DEADLINE = 12.0
SWEEP_CONCURRENCY = 12


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class StatusChecker:
    def __init__(self, fetcher: SafeFetcher, ttl: float = CACHE_TTL) -> None:
        self._fetcher = fetcher
        self._ttl = ttl
        # Keyed by URL only; values hold no secrets. Bounded LRU.
        self._cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
        self._user_locks: OrderedDict[str, anyio.Lock] = OrderedDict()

    def _cached(self, url: str) -> dict | None:
        hit = self._cache.get(url)
        if hit and time.monotonic() - hit[0] < self._ttl:
            return hit[1]
        return None

    def _store(self, url: str, result: dict) -> None:
        self._cache[url] = (time.monotonic(), result)
        self._cache.move_to_end(url)
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
        cached = self._cached(url)
        if cached is not None:
            return cached
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
        self._store(url, result)
        return result

    async def check_many(self, user_id: str, targets: list[tuple[str, str]]) -> dict[str, dict]:
        """``targets`` = [(service_id, url)]; anything unfinished at the deadline is unknown."""
        out: dict[str, dict] = {
            sid: {"state": "unknown", "http_status": None, "latency_ms": None, "checked_at": None}
            for sid, _ in targets
        }
        if not targets:
            return out
        limiter = anyio.Semaphore(SWEEP_CONCURRENCY)

        async def run(sid: str, url: str) -> None:
            async with limiter:
                out[sid] = await self.check_one(url, user_id)

        # One sweep per user at a time; concurrent polls wait and then hit the cache.
        async with self._lock_for(user_id):
            with anyio.move_on_after(SWEEP_DEADLINE):
                async with anyio.create_task_group() as tg:
                    for sid, url in targets:
                        tg.start_soon(run, sid, url)
        return out

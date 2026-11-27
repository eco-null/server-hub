"""Run due service checks inside the application's lifespan."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime

import anyio

from serverhub.db import Database, monitoring
from serverhub.integrations.monitor_state import INTERVAL_SECONDS
from serverhub.integrations.status import StatusChecker, unknown

log = logging.getLogger(__name__)
CONCURRENCY = 10
PRUNE_INTERVAL_SECONDS = 3600


class MonitoringWorker:
    def __init__(
        self, db: Database, status: StatusChecker, *, clock: Callable[[], float] = time.time
    ) -> None:
        self._db = db
        self._status = status
        self._clock = clock

    async def run(self) -> None:
        prune_after = 0
        while True:
            slot = monitoring.minute_slot(self._clock())
            try:
                await self._tick(slot)
            except Exception:
                log.exception("monitoring tick failed")
            if slot >= prune_after:
                more = False
                try:
                    more = await self._db.run(monitoring.prune, slot - monitoring.RETENTION_SECONDS)
                except Exception:
                    log.exception("monitoring retention failed")
                prune_after = slot + (INTERVAL_SECONDS if more else PRUNE_INTERVAL_SECONDS)
            # Use the current slot after overrun. Recheck within a minute after rewind.
            until_next = slot + INTERVAL_SECONDS - self._clock()
            await anyio.sleep(min(INTERVAL_SECONDS, max(0, until_next)))

    async def tick(self) -> None:
        await self._tick(monitoring.minute_slot(self._clock()))

    async def _tick(self, slot: int) -> None:
        epoch, targets = await self._db.run(monitoring.due_targets, slot)
        if epoch is None or not targets:
            return

        remaining = slot + INTERVAL_SECONDS - self._clock()
        if remaining <= 0:
            return
        limit = anyio.Semaphore(CONCURRENCY)
        with anyio.move_on_after(remaining):
            async with anyio.create_task_group() as tasks:
                for target in targets:
                    tasks.start_soon(self._probe, limit, epoch, target, slot)

    async def _probe(
        self, limit: anyio.Semaphore, epoch: str, target: monitoring.Target, slot: int
    ) -> None:
        async with limit:
            if not await self._db.run(monitoring.target_current, epoch, target, slot):
                return
            if monitoring.minute_slot(self._clock()) != slot:
                return
            checked_since = datetime.fromtimestamp(slot, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            try:
                result = await self._status.check_one(
                    target.url, target.user_id, checked_since=checked_since
                )
            except Exception:
                log.warning("monitoring check failed for service %s", target.service_id)
                result = unknown()
            if monitoring.minute_slot(self._clock()) != slot:
                return
            await self._db.run(monitoring.record_result, epoch, target, slot, _fresh(result, slot))


def _fresh(result: dict, slot: int) -> dict:
    """An on-demand check of the same URL may have populated an earlier slot's cache."""
    if result["checked_at"] is None and result["state"] == "unknown":
        return result
    try:
        checked_at = datetime.fromisoformat(result["checked_at"])
        if checked_at.tzinfo is not None and monitoring.minute_slot(checked_at.timestamp()) == slot:
            return result
    except (TypeError, ValueError, OverflowError, OSError):
        pass
    return unknown()

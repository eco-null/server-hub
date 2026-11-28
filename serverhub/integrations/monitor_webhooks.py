"""Deliver queued monitoring events through the guarded HTTP client."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

import anyio

from serverhub.auth.crypto import Keys
from serverhub.db import Database, monitor_webhooks
from serverhub.integrations.fetcher import FetchError, SafeFetcher

log = logging.getLogger(__name__)
WEBHOOK_IDENTITY = "monitoring-webhook"
MAX_CONCURRENT_SENDS = 4
POLL_INTERVAL_SECONDS = 5
# Include time waiting for a shared fetcher slot and finish before the outbox lease expires.
SEND_TIMEOUT_SECONDS = 15


class WebhookWorker:
    def __init__(
        self,
        db: Database,
        fetcher: SafeFetcher,
        keys: Keys,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._db = db
        self._fetcher = fetcher
        self._keys = keys
        self._clock = clock
        self._slots = anyio.Semaphore(MAX_CONCURRENT_SENDS)

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                log.warning("monitoring webhook queue could not be read")
            await anyio.sleep(POLL_INTERVAL_SECONDS)

    async def tick(self) -> None:
        events = await self._db.run(monitor_webhooks.due_ids, int(self._clock()))
        async with anyio.create_task_group() as tasks:
            for event_id in events:
                tasks.start_soon(self._deliver, event_id)

    async def _deliver(self, event_id: str) -> None:
        async with self._slots:
            try:
                delivery = await self._db.run(monitor_webhooks.claim, event_id, int(self._clock()))
                if delivery is None:
                    return
                error = await self._send(delivery)
                await self._db.run(monitor_webhooks.finish, delivery, int(self._clock()), error)
            except Exception:
                # The lease allows another attempt after an unexpected database error.
                log.warning("monitoring webhook attempt could not be recorded")

    async def _send(self, delivery: monitor_webhooks.Delivery) -> str | None:
        try:
            url = self._keys.decrypt(delivery.url_enc)
            if url is None:
                return "invalid_destination"
            payload = {
                "id": delivery.id,
                "event": delivery.kind,
                "occurred_at": delivery.occurred_at,
                "service": {"id": delivery.service_id, "name": delivery.service_name},
                "incident_id": delivery.incident_id,
            }
            with anyio.fail_after(SEND_TIMEOUT_SECONDS):
                response = await self._fetcher.request(
                    "POST",
                    url,
                    user_id=WEBHOOK_IDENTITY,
                    json=payload,
                    headers={"Idempotency-Key": delivery.id},
                    read_body=False,
                    sensitive_url=True,
                )
            if 200 <= response.status < 300:
                return None
            return f"http_{response.status}"
        except FetchError as exc:
            return exc.kind if exc.kind in FetchError.MESSAGES else "protocol"
        except TimeoutError:
            return "timeout"
        except Exception:
            log.warning("monitoring webhook send failed unexpectedly")
            return "internal"

from __future__ import annotations

import sqlite3
from contextlib import aclosing

import anyio
import httpx
import pytest

from serverhub.db import monitor_webhooks, monitoring
from serverhub.integrations.fetcher import FetchResult, SafeFetcher
from serverhub.integrations.monitor_webhooks import WebhookWorker
from tests.conftest import create_user, new_session, running, setup_admin

pytestmark = pytest.mark.anyio
PATH = "/api/admin/monitoring/webhook"
URL = "https://receiver.example.test/alerts/private-test-key?test=secret"
SLOT = 4_200_000_000


async def test_webhook_config_is_admin_only_encrypted_and_write_only(client):
    assert (await client.get(PATH)).status_code == 401
    await setup_admin(client)
    user = await create_user(client, "regular")
    async with aclosing(await new_session(client.app, user["username"])) as regular:
        assert (await regular.get(PATH)).status_code == 403
        assert (await regular.put(PATH, json={"url": URL})).status_code == 403
        assert (await regular.delete(PATH)).status_code == 403
    assert (await client.get(PATH)).json() == {"configured": False, "last_delivery": None}
    assert (
        await client.put(PATH, json={"url": URL}, headers={"Origin": "https://other.example"})
    ).status_code == 403
    reply = await client.put(PATH, json={"url": URL})
    assert (
        reply.json()
        == (await client.get(PATH)).json()
        == {
            "configured": True,
            "last_delivery": None,
        }
    )
    h = client.app.state.hub
    stored = await h.db.run(
        lambda conn: conn.execute("SELECT url_enc FROM monitor_webhook").fetchone()[0]
    )
    assert stored != URL and h.keys.decrypt(stored) == URL
    assert "private-test-key" not in (await client.get("/api/backup")).text
    assert (await client.delete(PATH)).json() == {"configured": False, "last_delivery": None}


@pytest.mark.parametrize(
    "body",
    [
        {"url": "http://example.test/"},
        {"url": "https://user:password@example.test/"},
        {"url": "https://example.test/#test-fragment"},
        {"url": "https:///bad"},
        {"url": "https://example.test/", "extra": True},
        {"url": None},
    ],
)
async def test_webhook_rejects_invalid_config_before_storing(client, body):
    await setup_admin(client)
    response = await client.put(PATH, json=body)
    assert response.status_code == 400
    assert (await client.get(PATH)).json()["configured"] is False


async def test_outbox_follows_persisted_transitions_atomically_and_sends_in_order(
    tmp_path, monkeypatch
):
    async def idle(_self):
        await anyio.sleep_forever()

    monkeypatch.setattr(WebhookWorker, "run", idle)
    async with running(tmp_path) as client:
        user = await setup_admin(client)
        h = client.app.state.hub
        assert (await client.put(PATH, json={"url": URL})).status_code == 200
        assert (
            await client.put("/api/admin/monitoring", json={"enabled": True})
        ).status_code == 200
        service = (
            await client.post(
                "/api/services",
                json={"name": "Test service", "url": "https://target.example.test/"},
            )
        ).json()["service"]
        assert await h.db.run(monitoring.set_service_enabled, user["id"], service["id"], True, SLOT)
        epoch, targets = await h.db.run(monitoring.due_targets, SLOT)

        def record(offset, state):
            result = {"state": state, "checked_at": None, "http_status": None, "latency_ms": None}
            return h.db.run(monitoring.record_result, epoch, targets[0], SLOT + offset, result)

        assert await record(0, "down")
        assert await record(60, "down")
        await h.db.run(
            lambda conn: conn.execute(
                "CREATE TRIGGER outbox_write_failure BEFORE INSERT ON monitor_deliveries "
                "BEGIN SELECT RAISE(ABORT, 'outbox write failure'); END"
            )
        )
        with pytest.raises(sqlite3.IntegrityError, match="outbox write failure"):
            await record(120, "down")
        assert (await h.db.run(monitor_webhooks.read_config))["last_delivery"] is None
        await h.db.run(lambda conn: conn.execute("DROP TRIGGER outbox_write_failure"))
        assert await record(120, "down")  # The failed queue write rolled back the sample as well.
        assert await record(180, "up")

        sent = []

        async def fetch(_self, method, url, **options):
            assert method == "POST" and url == URL
            sent.append(options)
            return FetchResult(204, httpx.Headers(), b"")

        monkeypatch.setattr(SafeFetcher, "request", fetch)
        worker = WebhookWorker(h.db, h.fetcher, h.keys, clock=lambda: SLOT + 180)
        await worker.tick()
        await worker.tick()
        assert [p["json"]["event"] for p in sent] == ["down", "recovered"]
        assert sent[0]["json"]["incident_id"] == sent[1]["json"]["incident_id"]
        assert len({p["headers"]["Idempotency-Key"] for p in sent}) == 2
        for payload in sent:
            assert payload["json"]["id"] == payload["headers"]["Idempotency-Key"]
            assert payload["json"]["service"] == {"id": service["id"], "name": "Test service"}
            assert not payload["read_body"] and payload["sensitive_url"]
        assert (await client.get(PATH)).json()["last_delivery"]["status"] == "delivered"

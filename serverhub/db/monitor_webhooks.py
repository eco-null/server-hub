"""One encrypted monitoring webhook destination and its durable delivery queue."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from uuid import uuid4

from serverhub.db import transaction

RETRY_DELAYS = (15, 60, 300)
MAX_ATTEMPTS = len(RETRY_DELAYS) + 1
MAX_EVENT_AGE = 3600
LEASE_SECONDS = 30
BATCH_SIZE = 20

_READY = (
    " FROM monitor_deliveries AS d"
    " JOIN monitor_webhook AS w ON w.revision = d.webhook_revision"
    " JOIN service_monitors AS m ON m.service_id = d.service_id AND m.enabled = 1"
    " JOIN services AS s ON s.id = d.service_id AND s.check_enabled = 1"
    " WHERE d.status = 'pending' AND d.next_attempt <= ? AND d.attempts < ?"
    " AND d.occurred_at > ?"
    " AND (d.kind = 'down' OR NOT EXISTS ("
    " SELECT 1 FROM monitor_deliveries AS down"
    " WHERE down.incident_id = d.incident_id AND down.kind = 'down'"
    " AND down.status = 'pending'))"
)


@dataclass(frozen=True)
class Delivery:
    id: str
    url_enc: str = field(repr=False)
    kind: str
    occurred_at: int
    attempts: int
    service_id: str
    service_name: str
    incident_id: str
    _lease_until: int = field(repr=False)


def read_config(conn: sqlite3.Connection) -> dict:
    target = conn.execute("SELECT revision FROM monitor_webhook WHERE id = 1").fetchone()
    last = None
    if target is not None:
        last = conn.execute(
            "SELECT status, kind, occurred_at, attempts, last_error FROM monitor_deliveries"
            " WHERE webhook_revision = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
            (target["revision"],),
        ).fetchone()
    return {"configured": target is not None, "last_delivery": dict(last) if last else None}


def configure(conn: sqlite3.Connection, url_enc: str) -> dict:
    with transaction(conn):
        conn.execute(
            "INSERT INTO monitor_webhook (id, url_enc, revision) VALUES (1, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET"
            " url_enc = excluded.url_enc, revision = excluded.revision",
            (url_enc, uuid4().hex),
        )
        conn.execute("DELETE FROM monitor_deliveries WHERE status = 'pending'")
        return read_config(conn)


def remove(conn: sqlite3.Connection) -> dict:
    with transaction(conn):
        conn.execute("DELETE FROM monitor_webhook WHERE id = 1")
        conn.execute("DELETE FROM monitor_deliveries WHERE status = 'pending'")
        return read_config(conn)


def enqueue(
    conn: sqlite3.Connection, service_id: str, incident_id: str, kind: str, occurred_at: int
) -> None:
    """Queue a transition in the caller's incident transaction when a destination exists."""
    conn.execute(
        "INSERT INTO monitor_deliveries"
        " (id, service_id, incident_id, webhook_revision, kind, occurred_at, next_attempt)"
        " SELECT ?, ?, ?, revision, ?, ?, ? FROM monitor_webhook WHERE id = 1"
        " ON CONFLICT(incident_id, kind) DO NOTHING",
        (uuid4().hex, service_id, incident_id, kind, occurred_at, occurred_at),
    )


def due_ids(conn: sqlite3.Connection, now: int) -> list[str]:
    """Return a bounded batch, dropping retries past their lease or delivery window."""
    with transaction(conn):
        conn.execute(
            "UPDATE monitor_deliveries"
            " SET status = 'failed', last_error = coalesce(last_error, 'expired')"
            " WHERE status = 'pending' AND next_attempt <= ?"
            " AND (attempts >= ? OR occurred_at <= ?)",
            (now, MAX_ATTEMPTS, now - MAX_EVENT_AGE),
        )
        rows = conn.execute(
            "SELECT d.id" + _READY + " ORDER BY d.next_attempt, d.occurred_at, d.rowid LIMIT ?",
            (now, MAX_ATTEMPTS, now - MAX_EVENT_AGE, BATCH_SIZE),
        )
        return [row["id"] for row in rows]


def claim(conn: sqlite3.Connection, event_id: str, now: int) -> Delivery | None:
    """Lease a still-current event before doing any network I/O."""
    with transaction(conn):
        row = conn.execute(
            "SELECT d.id, w.url_enc, d.kind, d.occurred_at, d.attempts + 1 AS attempts,"
            " d.service_id, s.name AS service_name, d.incident_id" + _READY + " AND d.id = ?",
            (now, MAX_ATTEMPTS, now - MAX_EVENT_AGE, event_id),
        ).fetchone()
        if row is None:
            return None
        lease_until = now + LEASE_SECONDS
        conn.execute(
            "UPDATE monitor_deliveries SET attempts = ?, next_attempt = ? WHERE id = ?",
            (row["attempts"], lease_until, event_id),
        )
        return Delivery(**dict(row), _lease_until=lease_until)


def finish(conn: sqlite3.Connection, delivery: Delivery, now: int, error: str | None) -> None:
    """Complete only this attempt. A later claim or configuration change wins."""
    if now >= delivery._lease_until:
        return
    status = "delivered"
    next_attempt = now
    if error is not None:
        status = "failed"
        if delivery.attempts < MAX_ATTEMPTS:
            retry_at = now + RETRY_DELAYS[delivery.attempts - 1]
            if retry_at < delivery.occurred_at + MAX_EVENT_AGE:
                status = "pending"
                next_attempt = retry_at
    conn.execute(
        "UPDATE monitor_deliveries SET status = ?, next_attempt = ?, last_error = ?"
        " WHERE id = ? AND status = 'pending' AND attempts = ? AND next_attempt = ?",
        (status, next_attempt, error, delivery.id, delivery.attempts, delivery._lease_until),
    )

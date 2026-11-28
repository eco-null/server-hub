"""Persistent scheduling, results and incidents for opted-in services."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from uuid import uuid4

from serverhub.db import repo, transaction
from serverhub.db.monitor_webhooks import enqueue
from serverhub.integrations.monitor_state import INTERVAL_SECONDS, transition
from serverhub.integrations.status import unknown

MAX_MONITORS = 50
MAX_USER_MONITORS = 10
RETENTION_SECONDS = 7 * 86400
PRUNE_BATCH = 1000
_EPOCH_KEY = "monitoring_epoch"


@dataclass(frozen=True)
class Target:
    service_id: str
    user_id: str
    url: str
    generation: str


def minute_slot(now: float) -> int:
    return int(now // INTERVAL_SECONDS) * INTERVAL_SECONDS


def global_enabled(conn: sqlite3.Connection) -> bool:
    return repo.get_config(conn, _EPOCH_KEY) is not None


def set_global_enabled(conn: sqlite3.Connection, enabled: bool) -> bool:
    with transaction(conn):
        if global_enabled(conn) == enabled:
            return enabled
        repo.set_config(conn, _EPOCH_KEY, uuid4().hex if enabled else None)
        if not enabled:
            conn.execute("UPDATE service_monitors SET down_streak = 0, first_down_at = NULL")
            conn.execute("DELETE FROM monitor_deliveries WHERE status = 'pending'")
    return enabled


def set_service_enabled(
    conn: sqlite3.Connection, user_id: str, service_id: str, enabled: bool, now: float
) -> bool | None:
    """Set the owner's opt-in, preserving history across an explicit pause."""
    with transaction(conn):
        service = conn.execute(
            "SELECT s.check_enabled, m.enabled AS monitoring"
            " FROM services AS s LEFT JOIN service_monitors AS m ON m.service_id = s.id"
            " WHERE s.id = ? AND s.user_id = ?",
            (service_id, user_id),
        ).fetchone()
        if service is None:
            return None
        if enabled:
            if not global_enabled(conn):
                raise ValueError("monitoring_disabled")
            if not service["check_enabled"]:
                raise ValueError("checks_disabled")
        if bool(service["monitoring"]) == enabled:
            return enabled

        generation = uuid4().hex
        if enabled:
            total, own = conn.execute(
                "SELECT count(*), count(*) FILTER (WHERE s.user_id = ?)"
                " FROM service_monitors AS m JOIN services AS s ON s.id = m.service_id"
                " WHERE m.enabled = 1",
                (user_id,),
            ).fetchone()
            if own >= MAX_USER_MONITORS:
                raise ValueError("owner_limit")
            if total >= MAX_MONITORS:
                raise ValueError("monitor_limit")
            conn.execute(
                "INSERT INTO service_monitors (service_id, enabled, generation, started_at)"
                " VALUES (?, 1, ?, ?)"
                " ON CONFLICT(service_id) DO UPDATE"
                " SET enabled = 1, generation = excluded.generation",
                (service_id, generation, minute_slot(now)),
            )
        else:
            conn.execute(
                "UPDATE service_monitors"
                " SET enabled = 0, generation = ?, down_streak = 0, first_down_at = NULL"
                " WHERE service_id = ?",
                (generation, service_id),
            )
            conn.execute(
                "UPDATE monitor_incidents SET ended_at = max(started_at, ?), end_reason = 'paused'"
                " WHERE service_id = ? AND ended_at IS NULL",
                (int(now), service_id),
            )
            conn.execute(
                "DELETE FROM monitor_deliveries WHERE service_id = ? AND status = 'pending'",
                (service_id,),
            )
    return enabled


def due_targets(conn: sqlite3.Connection, slot: int) -> tuple[str | None, list[Target]]:
    epoch = repo.get_config(conn, _EPOCH_KEY)
    if epoch is None:
        return None, []
    rows = conn.execute(
        "SELECT m.service_id, s.user_id, s.url, m.generation"
        " FROM service_monitors AS m JOIN services AS s ON s.id = m.service_id"
        " WHERE m.enabled = 1 AND s.check_enabled = 1 AND m.started_at <= ?"
        " AND (m.last_slot IS NULL OR m.last_slot < ?)"
        " ORDER BY coalesce(m.last_slot, m.started_at), m.service_id"
        " LIMIT ?",
        (slot, slot, MAX_MONITORS),
    )
    return epoch, [Target(*row) for row in rows]


def _current_target(
    conn: sqlite3.Connection, epoch: str, target: Target, slot: int
) -> sqlite3.Row | None:
    if repo.get_config(conn, _EPOCH_KEY) != epoch:
        return None
    return conn.execute(
        "SELECT last_slot, down_streak, first_down_at FROM service_monitors"
        " WHERE service_id = ? AND enabled = 1 AND generation = ? AND started_at <= ?"
        " AND (last_slot IS NULL OR last_slot < ?)",
        (target.service_id, target.generation, slot, slot),
    ).fetchone()


def target_current(conn: sqlite3.Connection, epoch: str, target: Target, slot: int) -> bool:
    return _current_target(conn, epoch, target, slot) is not None


def record_result(
    conn: sqlite3.Connection, epoch: str, target: Target, slot: int, result: dict
) -> bool:
    """Record an observation only while both the schedule and target are current."""
    with transaction(conn):
        current = _current_target(conn, epoch, target, slot)
        if current is None:
            return False
        incident = conn.execute(
            "SELECT id FROM monitor_incidents WHERE service_id = ? AND ended_at IS NULL",
            (target.service_id,),
        ).fetchone()
        change = transition(
            state=result["state"],
            slot=slot,
            previous_slot=current["last_slot"],
            down_streak=current["down_streak"],
            first_down_at=current["first_down_at"],
            incident_open=incident is not None,
        )
        conn.execute(
            "INSERT INTO monitor_samples"
            " (service_id, slot, state, checked_at, http_status, latency_ms)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                target.service_id,
                slot,
                result["state"],
                result["checked_at"],
                result["http_status"],
                result["latency_ms"],
            ),
        )
        conn.execute(
            "UPDATE service_monitors SET last_slot = ?, down_streak = ?, first_down_at = ?"
            " WHERE service_id = ?",
            (slot, change.down_streak, change.first_down_at, target.service_id),
        )
        if change.event == "down":
            incident_id = uuid4().hex
            conn.execute(
                "INSERT INTO monitor_incidents (id, service_id, started_at) VALUES (?, ?, ?)",
                (incident_id, target.service_id, change.started_at),
            )
            enqueue(conn, target.service_id, incident_id, "down", slot)
        if change.event == "recovered":
            conn.execute(
                "UPDATE monitor_incidents SET ended_at = ?, end_reason = 'recovered' WHERE id = ?",
                (slot, incident["id"]),
            )
            enqueue(conn, target.service_id, incident["id"], "recovered", slot)
    return True


def latest_statuses(conn: sqlite3.Connection, user_id: str, slot: int) -> dict[str, dict]:
    """Include every active monitor so requests do not trigger a second probe."""
    if not global_enabled(conn):
        return {}
    rows = conn.execute(
        "SELECT m.service_id, sample.slot, sample.state, sample.checked_at,"
        " sample.http_status, sample.latency_ms"
        " FROM service_monitors AS m JOIN services AS s ON s.id = m.service_id"
        " LEFT JOIN monitor_samples AS sample"
        " ON sample.service_id = m.service_id AND sample.slot = m.last_slot"
        " WHERE s.user_id = ? AND s.check_enabled = 1 AND m.enabled = 1",
        (user_id,),
    )
    statuses = {}
    for row in rows:
        if row["slot"] is None or not 0 <= slot - row["slot"] <= INTERVAL_SECONDS:
            statuses[row["service_id"]] = unknown()
        else:
            statuses[row["service_id"]] = {
                key: row[key] for key in ("state", "checked_at", "http_status", "latency_ms")
            }
    return statuses


def prune(conn: sqlite3.Connection, cutoff_slot: int) -> bool:
    """Prune bounded batches and report when there may be more to remove."""
    with transaction(conn):
        samples = conn.execute(
            "DELETE FROM monitor_samples WHERE (service_id, slot) IN"
            " (SELECT service_id, slot FROM monitor_samples WHERE slot < ? LIMIT ?)",
            (cutoff_slot, PRUNE_BATCH),
        ).rowcount
        incidents = conn.execute(
            "DELETE FROM monitor_incidents WHERE id IN"
            " (SELECT id FROM monitor_incidents WHERE ended_at < ? LIMIT ?)",
            (cutoff_slot, PRUNE_BATCH),
        ).rowcount
        deliveries = conn.execute(
            "DELETE FROM monitor_deliveries WHERE id IN"
            " (SELECT id FROM monitor_deliveries WHERE occurred_at < ? LIMIT ?)",
            (cutoff_slot, PRUNE_BATCH),
        ).rowcount
    return PRUNE_BATCH in (samples, incidents, deliveries)

"""Owned service history and seven-day measurement coverage."""

from __future__ import annotations

import sqlite3

from serverhub.db.monitoring import RETENTION_SECONDS, global_enabled
from serverhub.integrations.monitor_state import INTERVAL_SECONDS

INCIDENT_PAGE_SIZE = 20


def read_history(
    conn: sqlite3.Connection,
    user_id: str,
    service_id: str,
    slot: int,
    before: int | None,
    with_details: bool,
) -> dict | None:
    service = conn.execute(
        "SELECT s.check_enabled, m.enabled, m.started_at"
        " FROM services AS s LEFT JOIN service_monitors AS m ON s.id = m.service_id"
        " WHERE s.user_id = ? AND s.id = ?",
        (user_id, service_id),
    ).fetchone()
    if service is None:
        return None
    started_at = service["started_at"]
    first_slot = max(slot - RETENTION_SECONDS, started_at if started_at is not None else slot)
    samples = conn.execute(
        "SELECT count(*) FILTER (WHERE state = 'up') AS up,"
        " count(*) FILTER (WHERE state = 'down') AS down,"
        " count(*) FILTER (WHERE state = 'unknown') AS unknown,"
        " count(*) FILTER (WHERE slot = ?) AS current"
        " FROM monitor_samples WHERE service_id = ? AND slot BETWEEN ? AND ?",
        (slot, service_id, first_slot, slot),
    ).fetchone()
    checked = samples["up"] + samples["down"]
    expected = max(0, (slot - first_slot) // INTERVAL_SECONDS) + samples["current"]
    latest = conn.execute(
        "SELECT state, checked_at, http_status, latency_ms FROM monitor_samples"
        " WHERE service_id = ? AND slot BETWEEN ? AND ? ORDER BY slot DESC LIMIT 1",
        (service_id, first_slot, slot),
    ).fetchone()
    last_check = dict(latest) if latest is not None else None
    if last_check is not None and not with_details:
        last_check.update(http_status=None, latency_ms=None)

    incidents = conn.execute(
        "SELECT id, started_at, CASE WHEN ended_at < ? THEN ended_at END AS ended_at,"
        " CASE WHEN ended_at < ? THEN end_reason END AS end_reason FROM monitor_incidents"
        " WHERE service_id = ? AND started_at <= ? AND (? IS NULL OR started_at < ?)"
        " AND (monitor_incidents.ended_at IS NULL OR monitor_incidents.ended_at >= ?)"
        " ORDER BY started_at DESC LIMIT ?",
        (
            slot + INTERVAL_SECONDS,
            slot + INTERVAL_SECONDS,
            service_id,
            slot,
            before,
            before,
            slot - RETENTION_SECONDS,
            INCIDENT_PAGE_SIZE + 1,
        ),
    ).fetchall()
    has_more = len(incidents) > INCIDENT_PAGE_SIZE
    page = incidents[:INCIDENT_PAGE_SIZE]
    return {
        "available": global_enabled(conn),
        "enabled": bool(service["enabled"]),
        "check_enabled": bool(service["check_enabled"]),
        "last_check": last_check,
        "summary": {
            "uptime_pct": round(samples["up"] * 100 / checked, 2) if checked else None,
            "checked": checked,
            "expected": expected,
            "unknown": samples["unknown"],
            "missing": max(0, expected - checked - samples["unknown"]),
        },
        "incidents": [dict(incident) for incident in page],
        "next_before": page[-1]["started_at"] if has_more else None,
    }

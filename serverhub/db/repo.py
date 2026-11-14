"""Repository layer: plain synchronous functions taking a connection.

Every query on user-owned rows filters by ``user_id``; callers pass the id of
the authenticated session user, never a client-supplied one.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from serverhub.db import transaction
from serverhub.errors import ApiError


def now_ts() -> int:
    return int(time.time())


def iso_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id() -> str:
    return str(uuid.uuid4())


def _row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


def _conflict_from(exc: sqlite3.IntegrityError) -> ApiError:
    msg = str(exc)
    if "users.email" in msg:
        return ApiError(409, "conflict", "That email is already in use", fields={"email": "taken"})
    if "users.username" in msg:
        return ApiError(
            409, "conflict", "That username is already taken", fields={"username": "taken"}
        )
    return ApiError(409, "conflict", "Conflict")


# ---- users -------------------------------------------------------------------


def count_users(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def get_user(conn: sqlite3.Connection, user_id: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())


def get_user_by_identifier(conn: sqlite3.Connection, identifier: str) -> dict | None:
    return _row(
        conn.execute(
            "SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1",
            (identifier, identifier),
        ).fetchone()
    )


def _insert_user(
    conn: sqlite3.Connection, email: str, username: str, password_hash: str, role: str
) -> dict:
    uid, ts = new_id(), iso_now()
    try:
        conn.execute(
            "INSERT INTO users (id, email, username, password_hash, role, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (uid, email, username, password_hash, role, ts, ts),
        )
    except sqlite3.IntegrityError as exc:
        raise _conflict_from(exc) from None
    return get_user(conn, uid)  # type: ignore[return-value]


def create_user(
    conn: sqlite3.Connection, email: str, username: str, password_hash: str, role: str
) -> dict:
    with transaction(conn):
        return _insert_user(conn, email, username, password_hash, role)


def create_first_admin(
    conn: sqlite3.Connection, email: str, username: str, password_hash: str
) -> dict | None:
    """Create the initial admin atomically; None if any user already exists."""
    with transaction(conn):
        if count_users(conn) > 0:
            return None
        return _insert_user(conn, email, username, password_hash, "admin")


def list_users(conn: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM users ORDER BY created_at, rowid")]


def set_password(
    conn: sqlite3.Connection, user_id: str, password_hash: str, keep_session: str | None = None
) -> None:
    """Change a password and revoke every session except ``keep_session``."""
    with transaction(conn):
        conn.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (password_hash, iso_now(), user_id),
        )
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND id_hash IS NOT ?", (user_id, keep_session)
        )
        conn.execute("DELETE FROM pending_logins WHERE user_id = ?", (user_id,))


def rehash_password(conn: sqlite3.Connection, user_id: str, password_hash: str) -> None:
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def update_role(conn: sqlite3.Connection, user_id: str, role: str) -> None:
    """Change a role, refusing to demote the last admin."""
    with transaction(conn):
        user = get_user(conn, user_id)
        if user is None:
            raise ApiError(404, "not_found", "Not found")
        if user["role"] == "admin" and role != "admin" and _admin_count(conn) <= 1:
            raise ApiError(409, "last_admin", "The last admin cannot be demoted")
        conn.execute(
            "UPDATE users SET role = ?, updated_at = ? WHERE id = ?", (role, iso_now(), user_id)
        )


def _admin_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]


def delete_user(conn: sqlite3.Connection, user_id: str) -> None:
    with transaction(conn):
        user = get_user(conn, user_id)
        if user is None:
            raise ApiError(404, "not_found", "Not found")
        if user["role"] == "admin" and _admin_count(conn) <= 1:
            raise ApiError(409, "last_admin", "The last admin cannot be removed")
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


# ---- two-factor --------------------------------------------------------------


def set_totp_pending(conn: sqlite3.Connection, user_id: str, secret_enc: str, exp: int) -> None:
    conn.execute(
        "UPDATE users SET totp_pending_enc = ?, totp_pending_exp = ? WHERE id = ?",
        (secret_enc, exp, user_id),
    )


def enable_totp(
    conn: sqlite3.Connection, user_id: str, secret_enc: str, step: int, code_hashes: list[str]
) -> bool:
    """Activate 2FA from the pending secret. False if it was enabled concurrently."""
    with transaction(conn):
        cur = conn.execute(
            "UPDATE users SET totp_secret_enc = ?, totp_last_step = ?, totp_pending_enc = NULL,"
            " totp_pending_exp = NULL, updated_at = ?"
            " WHERE id = ? AND totp_secret_enc IS NULL AND totp_pending_enc IS NOT NULL",
            (secret_enc, step, iso_now(), user_id),
        )
        if cur.rowcount != 1:
            return False
        conn.execute("DELETE FROM recovery_codes WHERE user_id = ?", (user_id,))
        conn.executemany(
            "INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)",
            [(user_id, h) for h in code_hashes],
        )
        return True


def disable_totp(conn: sqlite3.Connection, user_id: str) -> None:
    with transaction(conn):
        conn.execute(
            "UPDATE users SET totp_secret_enc = NULL, totp_last_step = NULL,"
            " totp_pending_enc = NULL, totp_pending_exp = NULL, updated_at = ? WHERE id = ?",
            (iso_now(), user_id),
        )
        conn.execute("DELETE FROM recovery_codes WHERE user_id = ?", (user_id,))


def claim_totp_step(conn: sqlite3.Connection, user_id: str, step: int) -> bool:
    """Record ``step`` as used. False when it (or a later one) was already used."""
    cur = conn.execute(
        "UPDATE users SET totp_last_step = ?"
        " WHERE id = ? AND totp_secret_enc IS NOT NULL"
        " AND (totp_last_step IS NULL OR totp_last_step < ?)",
        (step, user_id, step),
    )
    return cur.rowcount == 1


def consume_recovery_code(conn: sqlite3.Connection, user_id: str, code_hash: str) -> bool:
    cur = conn.execute(
        "UPDATE recovery_codes SET used_at = ?"
        " WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
        (iso_now(), user_id, code_hash),
    )
    return cur.rowcount == 1


# ---- sessions ----------------------------------------------------------------


def create_session(
    conn: sqlite3.Connection, id_hash: str, user_id: str, max_age: int, replace: str | None
) -> None:
    ts = now_ts()
    with transaction(conn):
        if replace:
            conn.execute("DELETE FROM sessions WHERE id_hash = ?", (replace,))
        conn.execute(
            "INSERT INTO sessions (id_hash, user_id, created_at, last_seen, expires_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (id_hash, user_id, ts, ts, ts + max_age),
        )


def get_session_user(conn: sqlite3.Connection, id_hash: str, idle: int) -> dict | None:
    """Return the session's user if the session is live; slide the idle window."""
    ts = now_ts()
    row = conn.execute(
        "SELECT s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id"
        " WHERE s.id_hash = ? AND s.expires_at > ? AND s.last_seen > ?",
        (id_hash, ts, ts - idle),
    ).fetchone()
    if row is None:
        return None
    if ts - row["last_seen"] >= 60:
        conn.execute("UPDATE sessions SET last_seen = ? WHERE id_hash = ?", (ts, id_hash))
    user = dict(row)
    user.pop("last_seen", None)
    return user


def delete_session(conn: sqlite3.Connection, id_hash: str) -> None:
    conn.execute("DELETE FROM sessions WHERE id_hash = ?", (id_hash,))


def delete_user_sessions(conn: sqlite3.Connection, user_id: str) -> None:
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM pending_logins WHERE user_id = ?", (user_id,))


def create_pending(
    conn: sqlite3.Connection, id_hash: str, user_id: str, ttl: int, replace: str | None
) -> None:
    with transaction(conn):
        if replace:
            conn.execute("DELETE FROM pending_logins WHERE id_hash = ?", (replace,))
        conn.execute(
            "INSERT INTO pending_logins (id_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (id_hash, user_id, now_ts() + ttl),
        )


def take_pending_attempt(conn: sqlite3.Connection, id_hash: str, max_attempts: int) -> str | None:
    """Count one 2FA attempt against a pending login; returns its user id if still valid."""
    with transaction(conn):
        row = conn.execute(
            "SELECT user_id, attempts FROM pending_logins WHERE id_hash = ? AND expires_at > ?",
            (id_hash, now_ts()),
        ).fetchone()
        if row is None:
            return None
        if row["attempts"] >= max_attempts:
            conn.execute("DELETE FROM pending_logins WHERE id_hash = ?", (id_hash,))
            return None
        conn.execute(
            "UPDATE pending_logins SET attempts = attempts + 1 WHERE id_hash = ?", (id_hash,)
        )
        return row["user_id"]


def delete_pending(conn: sqlite3.Connection, id_hash: str) -> None:
    conn.execute("DELETE FROM pending_logins WHERE id_hash = ?", (id_hash,))


def prune(conn: sqlite3.Connection, rate_window_max: int) -> None:
    ts = now_ts()
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (ts,))
    conn.execute("DELETE FROM pending_logins WHERE expires_at <= ?", (ts,))
    conn.execute(
        "DELETE FROM rate_limits WHERE window_start < ? AND locked_until < ?",
        (ts - rate_window_max, ts),
    )


# ---- app config --------------------------------------------------------------


def get_config(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    row = conn.execute("SELECT value FROM app_config WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_config(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO app_config (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )


# ---- rate limits -------------------------------------------------------------


def rate_status(conn: sqlite3.Connection, keys: list[str]) -> int:
    """Seconds until the longest active lock among ``keys`` ends (0 if none)."""
    ts = now_ts()
    worst = 0
    for key in keys:
        row = conn.execute("SELECT locked_until FROM rate_limits WHERE key = ?", (key,)).fetchone()
        if row and row["locked_until"] > ts:
            worst = max(worst, row["locked_until"] - ts)
    return worst


def rate_hit(conn: sqlite3.Connection, key: str, limit: int, window: int, lockout: int) -> int:
    """Count one event for ``key``; returns lock seconds if this hit tripped the limit."""
    ts = now_ts()
    with transaction(conn):
        row = conn.execute(
            "SELECT count, window_start FROM rate_limits WHERE key = ?", (key,)
        ).fetchone()
        if row is None or ts - row["window_start"] >= window:
            count, start = 1, ts
        else:
            count, start = row["count"] + 1, row["window_start"]
        locked_until = ts + lockout if count >= limit else 0
        conn.execute(
            "INSERT INTO rate_limits (key, count, window_start, locked_until) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(key) DO UPDATE SET count = excluded.count,"
            " window_start = excluded.window_start,"
            " locked_until = MAX(rate_limits.locked_until, excluded.locked_until)",
            (key, 0 if locked_until else count, ts if locked_until else start, locked_until),
        )
        return lockout if locked_until else 0


def rate_reset(conn: sqlite3.Connection, keys: list[str]) -> None:
    conn.executemany("DELETE FROM rate_limits WHERE key = ?", [(k,) for k in keys])


def rate_row_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM rate_limits").fetchone()[0]


def rate_trim(conn: sqlite3.Connection, keep: int) -> None:
    conn.execute(
        "DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits"
        " WHERE locked_until < ? ORDER BY window_start LIMIT"
        " MAX(0, (SELECT COUNT(*) FROM rate_limits) - ?))",
        (now_ts(), keep),
    )


# ---- settings ----------------------------------------------------------------


def get_settings(conn: sqlite3.Connection, user_id: str) -> dict | None:
    row = conn.execute("SELECT data FROM user_settings WHERE user_id = ?", (user_id,)).fetchone()
    return json.loads(row["data"]) if row else None


def put_settings(conn: sqlite3.Connection, user_id: str, data: dict) -> None:
    conn.execute(
        "INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)"
        " ON CONFLICT(user_id) DO UPDATE SET"
        " data = excluded.data, updated_at = excluded.updated_at",
        (user_id, json.dumps(data, separators=(",", ":")), iso_now()),
    )


def delete_settings(conn: sqlite3.Connection, user_id: str) -> None:
    conn.execute("DELETE FROM user_settings WHERE user_id = ?", (user_id,))


# ---- generic owned-row helpers (services, bookmarks, beszel) -------------------

_OWNED = {
    "services": ("name", "url", "description", "icon", "category", "check_enabled"),
    "bookmarks": ("name", "url", "color"),
    "beszel_instances": ("name", "url", "username", "password_enc"),
}


def list_owned(conn: sqlite3.Connection, table: str, user_id: str) -> list[dict]:
    assert table in _OWNED  # noqa: S101 - table names are internal constants
    return [
        dict(r)
        for r in conn.execute(
            f"SELECT * FROM {table} WHERE user_id = ? ORDER BY rowid",  # noqa: S608
            (user_id,),
        )
    ]


def get_owned(conn: sqlite3.Connection, table: str, user_id: str, row_id: str) -> dict | None:
    assert table in _OWNED  # noqa: S101
    return _row(
        conn.execute(
            f"SELECT * FROM {table} WHERE id = ? AND user_id = ?",  # noqa: S608
            (row_id, user_id),
        ).fetchone()
    )


def count_owned(conn: sqlite3.Connection, table: str, user_id: str) -> int:
    assert table in _OWNED  # noqa: S101
    return conn.execute(
        f"SELECT COUNT(*) FROM {table} WHERE user_id = ?",  # noqa: S608
        (user_id,),
    ).fetchone()[0]


def _insert_owned(conn: sqlite3.Connection, table: str, user_id: str, fields: dict) -> str:
    cols = [c for c in _OWNED[table] if c in fields]
    row_id = new_id()
    names = ", ".join(["id", "user_id", "created_at", *cols])
    marks = ", ".join("?" * (3 + len(cols)))
    conn.execute(
        f"INSERT INTO {table} ({names}) VALUES ({marks})",  # noqa: S608
        (row_id, user_id, iso_now(), *(fields[c] for c in cols)),
    )
    return row_id


def insert_owned(
    conn: sqlite3.Connection, table: str, user_id: str, fields: dict, limit: int
) -> dict:
    with transaction(conn):
        if count_owned(conn, table, user_id) >= limit:
            raise ApiError(409, "limit_reached", f"You can have at most {limit} of these")
        row_id = _insert_owned(conn, table, user_id, fields)
        return get_owned(conn, table, user_id, row_id)  # type: ignore[return-value]


def update_owned(
    conn: sqlite3.Connection, table: str, user_id: str, row_id: str, fields: dict
) -> dict | None:
    cols = [c for c in _OWNED[table] if c in fields]
    with transaction(conn):
        if cols:
            sets = ", ".join(f"{c} = ?" for c in cols)
            if table == "beszel_instances":
                sets += ", revision = revision + 1"
            conn.execute(
                f"UPDATE {table} SET {sets} WHERE id = ? AND user_id = ?",  # noqa: S608
                (*(fields[c] for c in cols), row_id, user_id),
            )
        return get_owned(conn, table, user_id, row_id)


def delete_owned(conn: sqlite3.Connection, table: str, user_id: str, row_id: str) -> bool:
    assert table in _OWNED  # noqa: S101
    cur = conn.execute(
        f"DELETE FROM {table} WHERE id = ? AND user_id = ?",  # noqa: S608
        (row_id, user_id),
    )
    return cur.rowcount == 1


def replace_user_data(
    conn: sqlite3.Connection,
    user_id: str,
    settings: dict,
    services: list[dict],
    bookmarks: list[dict],
) -> None:
    """Backup import: swap settings, services and bookmarks in one transaction."""
    with transaction(conn):
        conn.execute("DELETE FROM services WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM bookmarks WHERE user_id = ?", (user_id,))
        put_settings(conn, user_id, settings)
        for s in services:
            _insert_owned(conn, "services", user_id, s)
        for b in bookmarks:
            _insert_owned(conn, "bookmarks", user_id, b)

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
    identifier = identifier.strip()
    if "@" in identifier:
        identifier = identifier.lower()
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


MAX_SESSIONS_PER_USER = 20


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
        # At most MAX_SESSIONS_PER_USER live sessions; the oldest go first.
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND rowid NOT IN"
            " (SELECT rowid FROM sessions WHERE user_id = ?"
            "  ORDER BY created_at DESC, rowid DESC LIMIT ?)",
            (user_id, user_id, MAX_SESSIONS_PER_USER),
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


def prune(conn: sqlite3.Connection, rate_window_max: int, idle: int | None = None) -> None:
    """Delete expired (or idle-expired) sessions, pending logins and stale counters."""
    ts = now_ts()
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (ts,))
    if idle is not None:
        conn.execute("DELETE FROM sessions WHERE last_seen <= ?", (ts - idle,))
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


def rate_reserve(
    conn: sqlite3.Connection, key: str, limit: int, window: int, lockout: int
) -> tuple[int, int]:
    """Atomically count one attempt for ``key`` before it is evaluated.

    Returns ``(count, retry_after)``: the attempt number within the current
    window, and the seconds until the key unlocks (0 = this attempt may go on).
    A key whose count exceeds ``limit`` is locked for ``lockout`` seconds.
    """
    ts = now_ts()
    with transaction(conn):
        row = conn.execute(
            "INSERT INTO rate_limits (key, count, window_start, locked_until)"
            " VALUES (:key, 1, :ts, 0)"
            " ON CONFLICT(key) DO UPDATE SET"
            " count = CASE WHEN rate_limits.locked_until <= :ts"
            "   AND rate_limits.window_start <= :ts - :window THEN 1"
            "   ELSE rate_limits.count + 1 END,"
            " window_start = CASE WHEN rate_limits.locked_until <= :ts"
            "   AND rate_limits.window_start <= :ts - :window THEN :ts"
            "   ELSE rate_limits.window_start END"
            " RETURNING count, locked_until",
            {"key": key, "ts": ts, "window": window},
        ).fetchone()
        count, locked_until = row[0], row[1]
        if locked_until > ts:
            return count, locked_until - ts
        if count > limit:
            conn.execute(
                "UPDATE rate_limits SET locked_until = ? WHERE key = ?", (ts + lockout, key)
            )
            return count, lockout
        return count, 0


def rate_refund(conn: sqlite3.Connection, keys: list[str]) -> None:
    conn.executemany(
        "UPDATE rate_limits SET count = MAX(count - 1, 0) WHERE key = ? AND locked_until <= ?",
        [(k, now_ts()) for k in keys],
    )


def rate_reset_prefix(conn: sqlite3.Connection, prefix: str) -> None:
    conn.execute("DELETE FROM rate_limits WHERE substr(key, 1, ?) = ?", (len(prefix), prefix))


def rate_reset_user(conn: sqlite3.Connection, user_id: str) -> None:
    """Delete every account-scoped counter of ``user_id`` (all rules, all IPs)."""
    uid = user_id.lower()
    conn.execute(
        "DELETE FROM rate_limits WHERE key IN (?, ?, ?) OR substr(key, 1, ?) = ?",
        (
            f"login_acct:{uid}",
            f"2fa_acct:{uid}",
            f"password_acct:{uid}",
            len(f"login_acct_ip:{uid}:"),
            f"login_acct_ip:{uid}:",
        ),
    )


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


def _update_owned(
    conn: sqlite3.Connection, table: str, user_id: str, row_id: str, fields: dict
) -> None:
    cols = [c for c in _OWNED[table] if c in fields]
    if cols:
        sets = ", ".join(f"{c} = ?" for c in cols)
        if table == "beszel_instances":
            sets += ", revision = revision + 1"
        conn.execute(
            f"UPDATE {table} SET {sets} WHERE id = ? AND user_id = ?",  # noqa: S608
            (*(fields[c] for c in cols), row_id, user_id),
        )


def update_owned(
    conn: sqlite3.Connection, table: str, user_id: str, row_id: str, fields: dict
) -> dict | None:
    with transaction(conn):
        _update_owned(conn, table, user_id, row_id, fields)
        return get_owned(conn, table, user_id, row_id)


def merge_owned(
    conn: sqlite3.Connection,
    table: str,
    user_id: str,
    additions: list[dict],
    updates: list[tuple[str, dict]],
) -> list[dict]:
    """Apply a checked merge inside the caller's transaction."""
    for fields in additions:
        _insert_owned(conn, table, user_id, fields)
    for row_id, fields in updates:
        _update_owned(conn, table, user_id, row_id, fields)
    return list_owned(conn, table, user_id)


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

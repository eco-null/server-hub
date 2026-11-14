"""Persistent (SQLite-backed) throttling for login, 2FA, setup and register.

Counters live in the ``rate_limits`` table so restarts do not reset lockouts.
Rows are pruned periodically and the table is capped, so memory and disk use
stay bounded even under a spray of distinct identifiers.
"""

from __future__ import annotations

from dataclasses import dataclass

from serverhub.db import Database, repo
from serverhub.errors import rate_limited

MAX_ROWS = 50_000


@dataclass(frozen=True)
class Rule:
    limit: int  # events within the window that trigger a lock
    window: int  # seconds
    lockout: int  # seconds


RULES: dict[str, Rule] = {
    "login_ip": Rule(20, 900, 900),
    "login_acct": Rule(8, 900, 900),
    "2fa_ip": Rule(20, 900, 900),
    "2fa_acct": Rule(6, 900, 900),
    "setup_ip": Rule(10, 3600, 3600),
    "register_ip": Rule(5, 3600, 3600),
    "password_acct": Rule(8, 900, 900),
}
LONGEST_WINDOW = max(r.window for r in RULES.values())


def key(rule: str, value: str) -> str:
    assert rule in RULES  # noqa: S101 - internal constant
    return f"{rule}:{value.strip().lower()[:256]}"


class RateLimiter:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def check(self, *keys: str) -> None:
        """Raise 429 if any of ``keys`` is currently locked."""
        wait = await self._db.run(repo.rate_status, list(keys))
        if wait > 0:
            raise rate_limited(wait)

    async def hit(self, *keys: str) -> None:
        """Count one failure (or attempt) for each key."""

        def _hit(conn):  # one thread hop for all keys
            for k in keys:
                rule = RULES[k.split(":", 1)[0]]
                repo.rate_hit(conn, k, rule.limit, rule.window, rule.lockout)
            if repo.rate_row_count(conn) > MAX_ROWS:
                repo.rate_trim(conn, MAX_ROWS)

        await self._db.run(_hit)

    async def reset(self, *keys: str) -> None:
        await self._db.run(repo.rate_reset, list(keys))

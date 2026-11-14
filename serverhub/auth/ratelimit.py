"""Persistent (SQLite-backed) throttling for login, 2FA, setup, register and password checks.

Reserve first, verify second: ``reserve()`` atomically counts the attempt
(one SQL upsert per key that increments and returns the counter) *before* any
expensive or secret-dependent work, so a burst of concurrent requests can never
get more evaluations than the budget allows. A successful attempt resets the
account's keys and refunds the IP's slot.

Rules are either *hard* (over the limit -> 429 until the lock expires) or
*soft* (over the limit -> each further attempt is slowed down, never refused).
Account-wide limits are soft so that an attacker spraying from many addresses
cannot lock the owner out; the hard account limits are per (account, IP).

Counters live in the ``rate_limits`` table so restarts do not reset lockouts.
Rows are pruned periodically and the table is capped, so memory and disk use
stay bounded even under a spray of distinct identifiers.
"""

from __future__ import annotations

import contextlib
import hashlib
from collections.abc import AsyncIterator
from dataclasses import dataclass

import anyio

from serverhub.db import Database, repo
from serverhub.errors import rate_limited

MAX_ROWS = 50_000
MAX_INFLIGHT_PER_IP = 2  # concurrent password verifications per client address
SOFT_DELAY_STEP = 0.5  # seconds of extra delay per attempt over a soft limit
SOFT_DELAY_MAX = 4.0


@dataclass(frozen=True)
class Rule:
    limit: int  # attempts allowed within the window
    window: int  # seconds
    lockout: int  # seconds a hard rule stays locked once exceeded
    soft: bool = False


RULES: dict[str, Rule] = {
    "login_ip": Rule(20, 900, 900),
    "login_acct_ip": Rule(8, 900, 900),
    "login_acct": Rule(30, 900, 900, soft=True),
    "2fa_ip": Rule(20, 900, 900),
    "2fa_acct": Rule(6, 900, 900),
    "setup_ip": Rule(10, 3600, 3600),
    "register_ip": Rule(5, 3600, 3600),
    "password_acct": Rule(8, 900, 900),
}
LONGEST_WINDOW = max(max(r.window, r.lockout) for r in RULES.values())


def key(rule: str, *parts: str) -> str:
    assert rule in RULES  # noqa: S101 - internal constant
    return ":".join([rule, *(p.strip().lower()[:256] for p in parts)])


def account_id(user: dict | None, identifier: str) -> str:
    """Account identity for throttling: the user id, or a hash of the normalised
    identifier when no such user exists (same shape, no enumeration)."""
    if user is not None:
        return user["id"]
    norm = identifier.strip().lower()
    return "anon-" + hashlib.sha256(norm.encode("utf-8")).hexdigest()[:32]


class RateLimiter:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._inflight: dict[str, int] = {}

    async def reserve(self, *keys: str) -> float:
        """Count one attempt for every key, atomically, before the real work.

        Raises 429 when a hard rule is over its limit. Returns the delay (in
        seconds) that soft rules ask for; the caller sleeps it before verifying.
        """

        def _reserve(conn):
            out = []
            for k in keys:
                rule = RULES[k.split(":", 1)[0]]
                out.append(
                    (rule, *repo.rate_reserve(conn, k, rule.limit, rule.window, rule.lockout))
                )
            if repo.rate_row_count(conn) > MAX_ROWS:
                repo.rate_trim(conn, MAX_ROWS)
            return out

        wait, delay = 0, 0.0
        for rule, count, retry in await self._db.run(_reserve):
            if rule.soft:
                if count > rule.limit:
                    delay = max(delay, min(SOFT_DELAY_MAX, SOFT_DELAY_STEP * (count - rule.limit)))
            elif retry > 0:
                wait = max(wait, retry)
        if wait:
            raise rate_limited(wait)
        return delay

    async def reserve_and_wait(self, *keys: str) -> None:
        delay = await self.reserve(*keys)
        if delay > 0:
            await anyio.sleep(delay)

    async def reset(self, *keys: str) -> None:
        await self._db.run(repo.rate_reset, list(keys))

    async def refund(self, *keys: str) -> None:
        """Give one reserved attempt back (used for the IP key on success)."""
        await self._db.run(repo.rate_refund, list(keys))

    async def reset_user(self, user_id: str) -> None:
        """Forget every account-scoped counter of ``user_id`` (all rules, all IPs)."""
        await self._db.run(repo.rate_reset_user, user_id)

    @contextlib.asynccontextmanager
    async def inflight(self, ip_key: str) -> AsyncIterator[None]:
        """Cap concurrent password verifications per client address (429 above it)."""
        n = self._inflight.get(ip_key, 0)
        if n >= MAX_INFLIGHT_PER_IP:
            raise rate_limited(1)
        self._inflight[ip_key] = n + 1
        try:
            yield
        finally:
            left = self._inflight.get(ip_key, 1) - 1
            if left <= 0:
                self._inflight.pop(ip_key, None)
            else:
                self._inflight[ip_key] = left

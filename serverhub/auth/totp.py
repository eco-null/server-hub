"""TOTP (RFC 6238) with replay protection, and single-use recovery codes."""

from __future__ import annotations

import re
import secrets
import time

import pyotp
import segno

ISSUER = "Server Hub"
STEP = 30
WINDOW = 1  # accept the previous / next 30 s step for clock drift
RECOVERY_CODE_COUNT = 10
_RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o/1/l/i
_SIX_DIGITS = re.compile(r"^\d{6}$")


def new_secret() -> str:
    return pyotp.random_base32(length=32)


def provisioning(secret: str, account: str) -> dict[str, str]:
    uri = pyotp.TOTP(secret, issuer=ISSUER).provisioning_uri(name=account, issuer_name=ISSUER)
    qr = segno.make(uri, error="m")
    svg = qr.svg_inline(scale=5, border=2, dark="#000", light="#fff")
    return {"secret": secret, "otpauth_uri": uri, "qr_svg": svg}


def is_totp_shape(code: str) -> bool:
    return bool(_SIX_DIGITS.match(code))


def match_step(secret: str, code: str, now: float | None = None) -> int | None:
    """Return the time step ``code`` is valid for, or None. Fails closed."""
    if not is_totp_shape(code):
        return None
    try:
        totp = pyotp.TOTP(secret)
        t = time.time() if now is None else now
        current = int(t // STEP)
        for step in range(current - WINDOW, current + WINDOW + 1):
            if secrets.compare_digest(totp.at(step * STEP), code):
                return step
    except Exception:  # malformed secret etc.: never authenticate
        return None
    return None


def new_recovery_codes() -> list[str]:
    codes = []
    for _ in range(RECOVERY_CODE_COUNT):
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def normalize_recovery_code(code: str) -> str:
    return re.sub(r"[\s-]", "", code).lower()

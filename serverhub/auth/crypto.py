"""Key derivation, secrets at rest, password hashing and token hashing."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

import anyio
import anyio.to_thread
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def _derive(secret_key: str, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(
        secret_key.encode("utf-8")
    )


class Keys:
    """Subkeys derived from SERVERHUB_SECRET_KEY with HKDF (one per purpose)."""

    def __init__(self, secret_key: str) -> None:
        self._fernet = Fernet(base64.urlsafe_b64encode(_derive(secret_key, b"serverhub/fernet/v1")))
        self._code_key = _derive(secret_key, b"serverhub/recovery-codes/v1")

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt(self, token: str) -> str | None:
        """Decrypt, or None if the value is corrupt or was made with another key."""
        try:
            return self._fernet.decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, ValueError):
            return None

    def hash_code(self, normalized_code: str) -> str:
        """Keyed hash for high-entropy recovery codes."""
        return hmac.new(self._code_key, normalized_code.encode(), hashlib.sha256).hexdigest()


def new_token() -> str:
    """Opaque 256-bit bearer token for cookies."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """Tokens are stored only as SHA-256; they carry 256 bits of entropy."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Passwords:
    """argon2id hashing, run off the event loop with bounded parallelism."""

    def __init__(self, *, time_cost: int = 3, memory_cost: int = 65536, parallelism: int = 4):
        self._ph = PasswordHasher(
            time_cost=time_cost, memory_cost=memory_cost, parallelism=parallelism
        )
        # Bounded so a burst of logins cannot exhaust memory (memory_cost KiB each).
        self._limiter = anyio.CapacityLimiter(4)
        self._dummy = self._ph.hash(secrets.token_urlsafe(16))

    async def hash(self, password: str) -> str:
        return await anyio.to_thread.run_sync(self._ph.hash, password, limiter=self._limiter)

    def hash_sync(self, password: str) -> str:
        return self._ph.hash(password)

    def _verify(self, stored: str | None, password: str) -> bool:
        try:
            return self._ph.verify(stored or self._dummy, password) and stored is not None
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    async def verify(self, stored: str | None, password: str) -> bool:
        """Verify; with ``stored=None`` a dummy hash is checked so timing is uniform."""
        return await anyio.to_thread.run_sync(self._verify, stored, password, limiter=self._limiter)

    def needs_rehash(self, stored: str) -> bool:
        try:
            return self._ph.check_needs_rehash(stored)
        except InvalidHashError:
            return False

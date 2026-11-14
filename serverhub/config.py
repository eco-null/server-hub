"""Runtime configuration, read from SERVERHUB_* environment variables.

Everything is validated at startup; a bad value stops the process with a
message naming the variable instead of failing later at request time.
"""

from __future__ import annotations

import ipaddress
import re
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import Field, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIN_SECRET_LENGTH = 32
_LABEL = r"[a-z0-9_][a-z0-9_-]{0,62}"
_HOSTNAME_RE = re.compile(rf"^(?=.{{1,253}}$){_LABEL}(\.{_LABEL})*$")


class ConfigError(Exception):
    """Raised with a human-readable explanation when configuration is invalid."""


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SERVERHUB_",
        case_sensitive=False,
        extra="ignore",
        frozen=True,
    )

    data_dir: Path = Path("./data")
    host: str = "0.0.0.0"
    port: int = Field(8642, ge=1, le=65535)
    secret_key: str = Field(..., repr=False)
    public_url: str | None = None
    tls_cert_file: Path | None = None
    tls_key_file: Path | None = None
    cookie_secure: Literal["auto", "true", "false"] = "auto"
    trusted_proxies: Annotated[
        tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...], NoDecode
    ] = ()
    allowed_hosts: Annotated[tuple[str, ...], NoDecode] = ()
    setup_token: str | None = Field(None, repr=False)
    max_connections: int = Field(512, ge=16, le=100_000)
    max_connections_per_ip: int = Field(32, ge=2, le=10_000)
    allow_private_network_targets: bool = True
    log_level: Literal["critical", "error", "warning", "info", "debug"] = "info"
    session_idle_days: float = Field(7, gt=0, le=365)
    session_max_days: float = Field(30, gt=0, le=365)
    web_dir: Path = PROJECT_ROOT / "web"

    @field_validator("secret_key")
    @classmethod
    def _secret_long_enough(cls, v: str) -> str:
        if len(v.strip()) < MIN_SECRET_LENGTH:
            raise ValueError(
                f"must be at least {MIN_SECRET_LENGTH} characters "
                '(generate one with: python -c "import secrets; print(secrets.token_urlsafe(48))")'
            )
        return v.strip()

    @field_validator("public_url")
    @classmethod
    def _public_url(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        parts = urlsplit(v.strip())
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("must be an absolute http:// or https:// URL")
        return f"{parts.scheme}://{parts.netloc}".lower()

    @field_validator("tls_cert_file", "tls_key_file", mode="before")
    @classmethod
    def _empty_path_is_none(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def _parse_cidrs(cls, v: object) -> object:
        if isinstance(v, str):
            items = [p.strip() for p in v.split(",") if p.strip()]
            try:
                return tuple(ipaddress.ip_network(p, strict=False) for p in items)
            except ValueError as exc:
                raise ValueError(f"invalid CIDR list: {exc}") from None
        return v

    @field_validator("allowed_hosts", mode="before")
    @classmethod
    def _parse_hosts(cls, v: object) -> object:
        items = v.split(",") if isinstance(v, str) else v
        if not isinstance(items, list | tuple):
            return v
        out = []
        for raw in items:
            h = str(raw).strip().lower().rstrip(".")
            if not h:
                continue
            if not _HOSTNAME_RE.match(h):
                raise ValueError(f"invalid host name {raw!r} (host names only, no scheme or port)")
            out.append(h)
        return tuple(out)

    @field_validator("setup_token", mode="before")
    @classmethod
    def _setup_token(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip()
            if not v:
                return None
            if len(v) < 16:
                raise ValueError("must be at least 16 characters")
        return v

    @field_validator("log_level", "cookie_secure", mode="before")
    @classmethod
    def _lower(cls, v: object) -> object:
        return v.strip().lower() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _check_tls(self) -> Config:
        if (self.tls_cert_file is None) != (self.tls_key_file is None):
            raise ValueError(
                "SERVERHUB_TLS_CERT_FILE and SERVERHUB_TLS_KEY_FILE must be set together"
            )
        for p in (self.tls_cert_file, self.tls_key_file):
            if p is not None and not p.is_file():
                raise ValueError(f"TLS file not found: {p}")
        if self.session_max_days < self.session_idle_days:
            raise ValueError("SERVERHUB_SESSION_MAX_DAYS must be >= SERVERHUB_SESSION_IDLE_DAYS")
        return self

    # ---- derived values -------------------------------------------------

    @property
    def tls_enabled(self) -> bool:
        return self.tls_cert_file is not None

    @property
    def secure_cookies(self) -> bool:
        if self.cookie_secure == "true":
            return True
        if self.cookie_secure == "false":
            return False
        return self.tls_enabled or bool(self.public_url and self.public_url.startswith("https:"))

    @property
    def public_host(self) -> str | None:
        return urlsplit(self.public_url).hostname if self.public_url else None

    @property
    def host_allowlist(self) -> frozenset[str]:
        """Host names (not IP literals, which are always allowed) accepted in Host."""
        names = {"localhost", *self.allowed_hosts}
        if self.public_host:
            names.add(self.public_host.rstrip("."))
        return frozenset(names)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "serverhub.db"


def load_config(**overrides: object) -> Config:
    """Build the config from the environment, raising ConfigError on bad input."""
    try:
        return Config(**overrides)  # type: ignore[arg-type]
    except ValidationError as exc:
        lines = []
        for err in exc.errors():
            name = "SERVERHUB_" + "_".join(str(p) for p in err["loc"]).upper() if err["loc"] else ""
            msg = err["msg"].removeprefix("Value error, ")
            if err["type"] == "missing":
                msg = "is required"
            lines.append(f"  {name or 'config'}: {msg}")
        raise ConfigError("Invalid configuration:\n" + "\n".join(lines)) from None

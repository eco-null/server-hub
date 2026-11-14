"""Application-wide services, created once in the lifespan and stored on app.state."""

from __future__ import annotations

from dataclasses import dataclass, field

from serverhub.auth.crypto import Keys, Passwords
from serverhub.auth.ratelimit import RateLimiter
from serverhub.config import Config
from serverhub.db import Database
from serverhub.integrations.beszel import BeszelClient
from serverhub.integrations.docker import DockerClient
from serverhub.integrations.fetcher import SafeFetcher
from serverhub.integrations.status import StatusChecker


@dataclass
class Hub:
    config: Config
    db: Database
    keys: Keys
    passwords: Passwords
    limiter: RateLimiter
    fetcher: SafeFetcher
    status: StatusChecker
    beszel: BeszelClient
    # Docker auto-discovery; None when SERVERHUB_DOCKER_HOST is empty (feature off).
    docker: DockerClient | None = None
    # First-run setup token; None once setup is done (or never needed).
    setup_token: str | None = field(default=None, repr=False)

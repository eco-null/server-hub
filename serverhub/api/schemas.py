"""Request/settings schemas (pydantic v2, strict, unknown keys rejected)."""

from __future__ import annotations

import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from serverhub.integrations.fetcher import FetchError, check_url_syntax

KNOWN_ICONS = frozenset(
    {
        "chart", "pulse", "database", "shield", "shield-check", "key", "lock",
        "lock-key", "cloud", "note", "file", "film", "music", "headphones", "git",
        "branch", "terminal", "globe", "home", "broadcast", "cog", "box",
        "shopping", "flask", "sparkles", "camera", "image", "book", "gamepad",
        "wallet", "map-pin", "activity", "cpu", "server", "wifi", "zap", "mail",
        "message", "calendar", "clock", "download", "upload", "sliders", "user",
        "users", "bookmark", "star", "heart", "link", "external-link", "folder",
        "archive", "package", "layers", "refresh", "bell", "bug", "code", "command",
    }
)  # fmt: skip
KNOWN_CATEGORIES = frozenset(
    {
        "Monitoring", "Security", "Network", "Media", "Productivity", "Files",
        "Dev", "Communication", "Home", "Finance", "AI", "Search", "Database",
        "Other", "Gaming", "Books", "Money", "Travel", "Health",
    }
)  # fmt: skip

MAX_SERVICES = 500
MAX_BOOKMARKS = 500
MAX_BESZEL = 20


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def _http_url(v: str) -> str:
    """http(s) URL whose host parses exactly as the outbound fetcher parses it."""
    v = v.strip()
    if any(c.isspace() for c in v):
        raise ValueError("must not contain spaces")
    try:
        check_url_syntax(v)
    except FetchError:
        raise ValueError("must be a valid http(s) URL") from None
    return v


def _beszel_url(v: str) -> str:
    """Beszel base URL: scheme, host, optional port and path prefix only."""
    v = _http_url(v)
    parts = urlsplit(v)
    if "?" in v or "#" in v or "@" in parts.netloc:
        raise ValueError("must not contain a query, fragment or credentials")
    if not _BESZEL_PATH.match(parts.path) or any(
        seg in (".", "..") for seg in parts.path.split("/")
    ):
        raise ValueError("path may only contain letters, digits and . _ ~ - /")
    return v


_BESZEL_PATH = re.compile(r"^[A-Za-z0-9._~/-]*$")


def _optional_http_url(v: str) -> str:
    return _http_url(v) if v.strip() else ""


def _image_url(v: str) -> str:
    """Wallpaper URLs: https:// (CSP img-src) or a same-origin /static path."""
    v = v.strip()
    if not v:
        return ""
    if v.startswith("/static/") and not any(c.isspace() for c in v) and ".." not in v:
        return v
    _http_url(v)
    if not v.lower().startswith("https://"):
        raise ValueError("must be an https:// URL")
    return v


def _icon(v: str) -> str:
    if v not in KNOWN_ICONS:
        raise ValueError("unknown icon id")
    return v


def _category(v: str | None) -> str | None:
    if v is not None and v not in KNOWN_CATEGORIES:
        raise ValueError("unknown category id")
    return v


HttpUrl = Annotated[str, StringConstraints(max_length=2000), AfterValidator(_http_url)]
BeszelUrl = Annotated[str, StringConstraints(max_length=2000), AfterValidator(_beszel_url)]
OptHttpUrl = Annotated[str, StringConstraints(max_length=2000), AfterValidator(_optional_http_url)]
Color = Annotated[str, StringConstraints(pattern=r"^#[0-9a-fA-F]{6}$")]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Icon = Annotated[str, AfterValidator(_icon)]
Category = Annotated[str | None, AfterValidator(_category)]

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")


def _email(v: str) -> str:
    v = v.strip().lower()
    if len(v) > 254 or not EMAIL_RE.match(v):
        raise ValueError("must be a valid email address")
    return v


Email = Annotated[str, AfterValidator(_email)]
Username = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_]{3,20}$")]
NewPassword = Annotated[str, StringConstraints(min_length=10, max_length=128)]
AnyPassword = Annotated[str, StringConstraints(max_length=1024)]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


# ---- settings -----------------------------------------------------------------


class Wallpaper(Strict):
    mode: Literal["none", "gradient", "image"] = "none"
    gradient: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{0,40}$")] = "default"
    url: Annotated[str, StringConstraints(max_length=2000), AfterValidator(_image_url)] = ""
    showGrid: bool = True


class Features(Strict):
    clock: bool = True
    greeting: bool = True
    stats: bool = True
    search: bool = True
    statusChecks: bool = True


class Search(Strict):
    provider: Literal["google", "duckduckgo", "bing", "startpage", "searxng"] = "duckduckgo"
    searxngUrl: OptHttpUrl = ""


class Settings(Strict):
    theme: Literal["auto", "light", "dark"] = "auto"
    accent: Color = "#5E6AD2"
    userName: Annotated[str, StringConstraints(max_length=100)] = ""
    pageTitle: Annotated[str, StringConstraints(max_length=100)] = ""
    subtitle: Annotated[str, StringConstraints(max_length=200)] = ""
    defaultDomain: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9.:-]{0,253}$")] = ""
    wallpaper: Wallpaper = Field(default_factory=Wallpaper)
    features: Features = Field(default_factory=Features)
    search: Search = Field(default_factory=Search)


DEFAULT_SETTINGS = Settings().model_dump()


def deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


# ---- services / bookmarks ---------------------------------------------------------


class ServiceCreate(Strict):
    name: Name
    url: HttpUrl
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""
    icon: Icon = "box"
    category: Category = None
    check: bool = True


class ServicePatch(Strict):
    name: Name | None = None
    url: HttpUrl | None = None
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = (
        None
    )
    icon: Icon | None = None
    category: Category = None
    check: bool | None = None


class BookmarkCreate(Strict):
    name: Name
    url: HttpUrl
    color: Color = "#5E6AD2"


class BookmarkPatch(Strict):
    name: Name | None = None
    url: HttpUrl | None = None
    color: Color | None = None


# ---- beszel ------------------------------------------------------------------------


class BeszelCreate(Strict):
    name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""
    url: BeszelUrl
    username: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=254)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=1024)]


class BeszelPatch(Strict):
    name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] | None = None
    url: BeszelUrl | None = None
    username: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=254)]
        | None
    ) = None
    password: Annotated[str, StringConstraints(min_length=1, max_length=1024)] | None = None


class BeszelTestAdhoc(Strict):
    url: BeszelUrl
    username: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=254)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=1024)]


class BeszelTestStored(Strict):
    instance_id: Annotated[str, StringConstraints(max_length=64)]


# ---- auth / account / admin -----------------------------------------------------------


class SignupIn(Strict):
    email: Email
    username: Username
    password: NewPassword


class SetupIn(SignupIn):
    setup_token: Annotated[str, StringConstraints(max_length=512)]


class LoginIn(Strict):
    identifier: Annotated[str, StringConstraints(strip_whitespace=True, max_length=254)]
    password: AnyPassword


class CodeIn(Strict):
    code: Code


class TwofaSetupIn(Strict):
    current_password: AnyPassword


class TwofaDisableIn(Strict):
    current_password: AnyPassword
    code: Code


class PasswordChangeIn(Strict):
    current_password: AnyPassword
    new_password: NewPassword


class AdminUserCreate(Strict):
    email: Email
    username: Username
    password: NewPassword
    role: Literal["admin", "user"] = "user"


class AdminUserPatch(Strict):
    role: Literal["admin", "user"] | None = None
    password: NewPassword | None = None
    disable_twofa: Literal[True] | None = None


class RegistrationConfig(Strict):
    registration_open: bool


# ---- backup -----------------------------------------------------------------------------


class BackupService(ServiceCreate):
    model_config = ConfigDict(extra="ignore", strict=True)


class BackupBookmark(BookmarkCreate):
    model_config = ConfigDict(extra="ignore", strict=True)


class BackupDoc(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    version: Literal[1]
    exported_at: str | None = None
    settings: dict = Field(default_factory=dict)
    services: Annotated[list[BackupService], Field(max_length=MAX_SERVICES)] = []
    bookmarks: Annotated[list[BackupBookmark], Field(max_length=MAX_BOOKMARKS)] = []

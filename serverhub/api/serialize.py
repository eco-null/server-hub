"""Row -> API shape conversions and settings loading."""

from __future__ import annotations

import sqlite3

from pydantic import BaseModel, ValidationError

from serverhub.api.schemas import (
    DEFAULT_LAYOUT,
    DEFAULT_SETTINGS,
    Layout,
    Settings,
    deep_merge,
)
from serverhub.db import repo


def service_fields(model: BaseModel, *, exclude_unset: bool = False) -> dict:
    fields = model.model_dump(exclude_unset=exclude_unset)
    if "check" in fields:
        fields["check_enabled"] = int(fields.pop("check"))
    return fields


def user_out(u: dict, *, with_created: bool = False) -> dict:
    out = {
        "id": u["id"],
        "email": u["email"],
        "username": u["username"],
        "role": u["role"],
        "twofa_enabled": u.get("totp_secret_enc") is not None,
    }
    if with_created:
        out["created_at"] = u["created_at"]
    return out


def service_out(r: dict) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "url": r["url"],
        "description": r["description"],
        "icon": r["icon"],
        "category": r["category"],
        "check": bool(r["check_enabled"]),
        "created_at": r["created_at"],
    }


def bookmark_out(r: dict) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "url": r["url"],
        "color": r["color"],
        "created_at": r["created_at"],
    }


def beszel_out(r: dict) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "url": r["url"],
        "username": r["username"],
        "has_password": bool(r["password_enc"]),
    }


def load_settings(conn: sqlite3.Connection, user_id: str) -> dict:
    stored = repo.get_settings(conn, user_id) or {}
    try:
        return Settings.model_validate(deep_merge(DEFAULT_SETTINGS, stored)).model_dump()
    except ValidationError:
        return dict(DEFAULT_SETTINGS)


def load_layout(conn: sqlite3.Connection, user_id: str) -> dict:
    stored = repo.get_layout(conn, user_id) or {}
    try:
        return Layout.model_validate({**DEFAULT_LAYOUT, **stored}).model_dump()
    except ValidationError:
        return dict(DEFAULT_LAYOUT)


DOCKER_VISIBLE_KEY = "docker_visible_to_users"


def docker_visible(conn: sqlite3.Connection, user: dict) -> bool:
    """May ``user`` see discovered Docker services? Admins always; others only
    when an admin turned the switch on. (Whether the feature is configured at
    all is checked by the caller.)"""
    return user["role"] == "admin" or bool(repo.get_config(conn, DOCKER_VISIBLE_KEY, False))


def bootstrap(conn: sqlite3.Connection, user: dict, *, docker_configured: bool = False) -> dict:
    uid = user["id"]
    return {
        "user": user_out(user),
        "settings": load_settings(conn, uid),
        "layout": load_layout(conn, uid),
        "services": [service_out(r) for r in repo.list_owned(conn, "services", uid)],
        "bookmarks": [bookmark_out(r) for r in repo.list_owned(conn, "bookmarks", uid)],
        "docker": {"enabled": docker_configured and docker_visible(conn, user)},
    }

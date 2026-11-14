"""Row -> API shape conversions and settings loading."""

from __future__ import annotations

import sqlite3

from pydantic import ValidationError

from serverhub.api.schemas import DEFAULT_SETTINGS, Settings, deep_merge
from serverhub.db import repo


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


def bootstrap(conn: sqlite3.Connection, user: dict) -> dict:
    uid = user["id"]
    return {
        "user": user_out(user),
        "settings": load_settings(conn, uid),
        "services": [service_out(r) for r in repo.list_owned(conn, "services", uid)],
        "bookmarks": [bookmark_out(r) for r in repo.list_owned(conn, "bookmarks", uid)],
    }

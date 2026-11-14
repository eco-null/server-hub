from __future__ import annotations

import pytest

from serverhub.api.schemas import DEFAULT_SETTINGS
from tests.conftest import setup_admin

pytestmark = pytest.mark.anyio


async def test_settings_defaults_merge_and_reset(client):
    await setup_admin(client)
    r = await client.get("/api/settings")
    assert r.json()["settings"] == DEFAULT_SETTINGS

    r = await client.patch(
        "/api/settings",
        json={"theme": "dark", "wallpaper": {"mode": "gradient"}, "features": {"clock": False}},
    )
    assert r.status_code == 200, r.text
    s = r.json()["settings"]
    assert s["theme"] == "dark"
    assert s["wallpaper"]["mode"] == "gradient"
    assert s["wallpaper"]["showGrid"] is True  # untouched nested keys survive
    assert s["features"] == {**DEFAULT_SETTINGS["features"], "clock": False}

    r = await client.patch("/api/settings", json={"accent": "#ABCDEF"})
    assert r.json()["settings"]["theme"] == "dark"  # previous patch persisted
    assert (await client.get("/api/bootstrap")).json()["settings"]["accent"] == "#ABCDEF"

    r = await client.delete("/api/settings")
    assert r.json()["settings"] == DEFAULT_SETTINGS


@pytest.mark.parametrize(
    "patch",
    [
        {"unknown": 1},
        {"wallpaper": {"bogus": True}},
        {"theme": "neon"},
        {"accent": "red"},
        {"wallpaper": {"url": "http://insecure.example/a.png"}},
        {"wallpaper": {"url": "javascript:alert(1)"}},
        {"search": {"provider": "searxng", "searxngUrl": "ftp://x"}},
        {"features": {"clock": "yes"}},
        {"wallpaper": None},
        {"pageTitle": "x" * 101},
    ],
)
async def test_settings_rejects_bad_input(client, patch):
    await setup_admin(client)
    r = await client.patch("/api/settings", json=patch)
    assert r.status_code == 400, patch
    assert r.json()["error"]["code"] == "validation"
    assert (await client.get("/api/settings")).json()["settings"] == DEFAULT_SETTINGS


async def test_services_crud_and_validation(client):
    await setup_admin(client)
    r = await client.post("/api/services", json={"name": " Plex ", "url": "http://plex.lan:32400"})
    assert r.status_code == 201
    svc = r.json()["service"]
    assert svc["name"] == "Plex" and svc["icon"] == "box" and svc["category"] is None
    assert svc["check"] is True and svc["description"] == "" and svc["created_at"].endswith("Z")

    r = await client.patch(
        f"/api/services/{svc['id']}",
        json={"category": "Media", "check": False, "icon": "film"},
    )
    assert r.status_code == 200
    out = r.json()["service"]
    assert (out["category"], out["check"], out["icon"], out["name"]) == (
        "Media",
        False,
        "film",
        "Plex",
    )
    r = await client.patch(f"/api/services/{svc['id']}", json={"category": None})
    assert r.json()["service"]["category"] is None
    assert (
        await client.patch(f"/api/services/{svc['id']}", json={"name": None})
    ).status_code == 400

    assert (await client.patch(f"/api/services/{svc['id'].upper()}", json={})).status_code == 200
    assert (await client.patch("/api/services/123", json={})).status_code == 404

    for bad in (
        {"name": "x", "url": "javascript:alert(1)"},
        {"name": "x", "url": "ftp://x"},
        {"name": "x", "url": "http://"},
        {"name": "x", "url": "http://a b"},
        {"name": "", "url": "http://x"},
        {"name": "x", "url": "http://x", "icon": "not-an-icon"},
        {"name": "x", "url": "http://x", "category": "Nope"},
        {"name": "x", "url": "http://x", "check": "true"},
        {"name": "x", "url": "http://x", "id": "abc"},
        {"name": "x" * 201, "url": "http://x"},
        {"name": "x", "url": "http://x/" + "a" * 2000},
        {"name": "x", "url": "http://x", "description": "d" * 501},
    ):
        r = await client.post("/api/services", json=bad)
        assert r.status_code == 400, bad

    assert (await client.delete(f"/api/services/{svc['id']}")).status_code == 204
    assert (await client.get("/api/services")).json() == {"services": []}


async def test_bookmarks_crud(client):
    await setup_admin(client)
    r = await client.post(
        "/api/bookmarks", json={"name": "HN", "url": "https://news.ycombinator.com"}
    )
    assert r.status_code == 201
    bm = r.json()["bookmark"]
    assert set(bm) == {"id", "name", "url", "color", "created_at"}
    r = await client.patch(f"/api/bookmarks/{bm['id']}", json={"color": "#000000"})
    assert r.json()["bookmark"]["color"] == "#000000"
    assert (
        await client.patch(f"/api/bookmarks/{bm['id']}", json={"color": "black"})
    ).status_code == 400
    assert (await client.get("/api/bookmarks")).json()["bookmarks"][0]["color"] == "#000000"
    assert (await client.delete(f"/api/bookmarks/{bm['id']}")).status_code == 204


async def test_backup_round_trip(client):
    await setup_admin(client)
    await client.patch("/api/settings", json={"pageTitle": "Home", "theme": "light"})
    for i in range(3):
        await client.post(
            "/api/services",
            json={"name": f"svc{i}", "url": f"http://s{i}.lan", "category": "Dev", "check": i != 1},
        )
    await client.post("/api/bookmarks", json={"name": "b", "url": "https://b.example"})
    await client.post(
        "/api/beszel/instances",
        json={"url": "http://b.lan", "username": "u", "password": "SECRETPW"},
    )

    exported = (await client.get("/api/backup")).json()
    assert exported["version"] == 1 and exported["exported_at"]
    assert "SECRETPW" not in str(exported) and "beszel" not in str(exported).lower()
    assert [s["name"] for s in exported["services"]] == ["svc0", "svc1", "svc2"]

    # Wipe and change things, then restore.
    await client.delete("/api/settings")
    for s in (await client.get("/api/services")).json()["services"]:
        await client.delete(f"/api/services/{s['id']}")
    await client.post("/api/services", json={"name": "temp", "url": "http://t.lan"})

    r = await client.post("/api/backup", json=exported)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"user", "settings", "services", "bookmarks", "docker"}
    assert body["settings"]["pageTitle"] == "Home" and body["settings"]["theme"] == "light"
    assert [(s["name"], s["check"]) for s in body["services"]] == [
        ("svc0", True),
        ("svc1", False),
        ("svc2", True),
    ]
    assert len(body["bookmarks"]) == 1
    again = (await client.get("/api/backup")).json()
    assert again["services"] == exported["services"]
    assert again["settings"] == exported["settings"]


async def test_backup_import_is_all_or_nothing(client):
    await setup_admin(client)
    await client.post("/api/services", json={"name": "keep", "url": "http://keep.lan"})
    bad_docs = [
        {"version": 2},
        {"version": 1, "services": [{"name": "ok", "url": "http://ok"}, {"name": "", "url": "x"}]},
        {"version": 1, "settings": {"unknown": True}},
        {"version": 1, "extra": 1},
    ]
    for doc in bad_docs:
        r = await client.post("/api/backup", json=doc)
        assert r.status_code == 400, doc
    names = [s["name"] for s in (await client.get("/api/services")).json()["services"]]
    assert names == ["keep"]

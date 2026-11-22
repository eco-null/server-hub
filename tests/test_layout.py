from __future__ import annotations

import httpx
import pytest

from serverhub.api.schemas import DEFAULT_LAYOUT, KNOWN_CATEGORIES, MAX_TILES
from tests.conftest import CLIENT_HEADERS, create_user, new_session, setup_admin

pytestmark = pytest.mark.anyio

ITEMS = [
    {"id": "stats", "size": "m", "hidden": False},
    {"id": "group:Media", "size": "l", "hidden": True},
    {"id": "bookmarks", "size": "s", "hidden": False},
]
ALL_IDS = ["bookmarks", "stats", *(f"group:{c}" for c in sorted(KNOWN_CATEGORIES))]


async def test_layout_defaults_in_get_and_bootstrap(client):
    await setup_admin(client)
    assert DEFAULT_LAYOUT == {"enabled": False, "items": []}
    assert (await client.get("/api/layout")).json() == {"layout": DEFAULT_LAYOUT}
    assert (await client.get("/api/bootstrap")).json()["layout"] == DEFAULT_LAYOUT


async def test_layout_patch_replaces_only_sent_keys_and_persists(client):
    await setup_admin(client)
    r = await client.patch("/api/layout", json={"items": ITEMS})
    assert r.status_code == 200, r.text
    assert r.json()["layout"] == {"enabled": False, "items": ITEMS}

    r = await client.patch("/api/layout", json={"enabled": True})
    assert r.json()["layout"] == {"enabled": True, "items": ITEMS}  # items kept

    r = await client.patch("/api/layout", json={"items": [{"id": "stats"}]})
    expected = {"enabled": True, "items": [{"id": "stats", "size": "s", "hidden": False}]}
    assert r.json()["layout"] == expected  # enabled kept, tile defaults filled

    assert (await client.get("/api/layout")).json()["layout"] == expected
    assert (await client.get("/api/bootstrap")).json()["layout"] == expected

    r = await client.patch("/api/layout", json={"items": []})
    assert r.json()["layout"] == {"enabled": True, "items": []}


async def test_layout_empty_patch_is_a_noop(client):
    await setup_admin(client)
    await client.patch("/api/layout", json={"enabled": True, "items": ITEMS})
    r = await client.patch("/api/layout", json={})
    assert r.status_code == 200, r.text
    assert r.json()["layout"] == {"enabled": True, "items": ITEMS}


async def test_layout_delete_resets(client):
    await setup_admin(client)
    await client.patch("/api/layout", json={"enabled": True, "items": ITEMS})
    r = await client.delete("/api/layout")
    assert r.status_code == 200, r.text
    assert r.json() == {"layout": DEFAULT_LAYOUT}
    assert (await client.get("/api/layout")).json()["layout"] == DEFAULT_LAYOUT
    assert (await client.get("/api/bootstrap")).json()["layout"] == DEFAULT_LAYOUT


async def test_layout_accepts_every_known_tile(client):
    await setup_admin(client)
    assert len(ALL_IDS) == MAX_TILES
    r = await client.patch("/api/layout", json={"items": [{"id": i} for i in ALL_IDS]})
    assert r.status_code == 200, r.text
    assert [t["id"] for t in r.json()["layout"]["items"]] == ALL_IDS


@pytest.mark.parametrize(
    "patch",
    [
        {"items": [{"id": "nope"}]},
        {"items": [{"id": "group:Nope"}]},
        {"items": [{"id": "group:"}]},
        {"items": [{"id": "Stats"}]},
        {"items": [{"id": "group:media"}]},
        {"items": [{"id": 1}]},
        {"items": [{}]},
        {"items": [{"id": "stats"}, {"id": "stats"}]},
        {"items": [{"id": "group:Media"}, {"id": "stats"}, {"id": "group:Media", "size": "m"}]},
        {"items": [{"id": "stats", "size": "xl"}]},
        {"items": [{"id": "stats", "size": "M"}]},
        {"items": [{"id": "stats", "size": None}]},
        {"items": [{"id": "stats", "hidden": "yes"}]},
        {"items": [{"id": "stats", "extra": 1}]},
        {"items": [{"id": "stats"}], "extra": 1},
        {"unknown": 1},
        {"enabled": "true"},
        {"enabled": 1},
        {"enabled": None, "items": "x"},
        {"items": "stats"},
        {"items": {"id": "stats"}},
        {"items": [None]},
        {"items": ["stats"]},
    ],
)
async def test_layout_rejects_bad_input(client, patch):
    await setup_admin(client)
    await client.patch("/api/layout", json={"enabled": True, "items": ITEMS[:1]})
    before = (await client.get("/api/layout")).json()
    r = await client.patch("/api/layout", json=patch)
    assert r.status_code == 400, (patch, r.text)
    assert r.json()["error"]["code"] == "validation"
    assert (await client.get("/api/layout")).json() == before  # nothing stored


async def test_layout_rejects_too_many_items(client):
    await setup_admin(client)
    too_many = [{"id": i} for i in ALL_IDS] + [{"id": "stats"}]
    assert len(too_many) == MAX_TILES + 1
    r = await client.patch("/api/layout", json={"items": too_many})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "validation"
    assert (await client.get("/api/layout")).json()["layout"] == DEFAULT_LAYOUT


@pytest.mark.parametrize("body", [[], [{"id": "stats"}], "text", 5, True])
async def test_layout_rejects_non_object_body(client, body):
    await setup_admin(client)
    r = await client.patch("/api/layout", json=body)
    assert r.status_code == 400, (body, r.text)
    assert r.json()["error"]["code"] == "validation"


async def test_layout_rejects_invalid_json_body(client):
    await setup_admin(client)
    r = await client.patch(
        "/api/layout", content=b"{nope", headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 400, r.text


async def test_layout_is_per_user(client):
    await setup_admin(client)
    await create_user(client, "bob")
    bob = await new_session(client.app, "bob")
    try:
        await client.patch("/api/layout", json={"enabled": True, "items": ITEMS})
        assert (await bob.get("/api/layout")).json()["layout"] == DEFAULT_LAYOUT
        assert (await bob.get("/api/bootstrap")).json()["layout"] == DEFAULT_LAYOUT
        assert (await bob.get("/api/backup")).json()["layout"] == DEFAULT_LAYOUT

        bob_items = [{"id": "bookmarks", "size": "l", "hidden": True}]
        await bob.patch("/api/layout", json={"items": bob_items})
        assert (await bob.get("/api/layout")).json()["layout"]["items"] == bob_items
        assert (await client.get("/api/layout")).json()["layout"] == {
            "enabled": True,
            "items": ITEMS,
        }

        await bob.delete("/api/layout")  # resetting bob leaves the admin alone
        assert (await client.get("/api/layout")).json()["layout"]["items"] == ITEMS
    finally:
        await bob.aclose()


async def test_layout_backup_round_trip(client):
    await setup_admin(client)
    await client.patch("/api/layout", json={"enabled": True, "items": ITEMS})

    exported = (await client.get("/api/backup")).json()
    assert exported["layout"] == {"enabled": True, "items": ITEMS}

    await client.delete("/api/layout")
    assert (await client.get("/api/layout")).json()["layout"] == DEFAULT_LAYOUT

    r = await client.post("/api/backup", json=exported)
    assert r.status_code == 200, r.text
    assert r.json()["layout"] == {"enabled": True, "items": ITEMS}
    assert (await client.get("/api/layout")).json()["layout"] == {"enabled": True, "items": ITEMS}
    assert (await client.get("/api/backup")).json()["layout"] == exported["layout"]


async def test_backup_import_without_layout_resets_it(client):
    await setup_admin(client)
    await client.patch("/api/layout", json={"enabled": True, "items": ITEMS})
    r = await client.post("/api/backup", json={"version": 1})
    assert r.status_code == 200, r.text
    assert r.json()["layout"] == DEFAULT_LAYOUT
    assert (await client.get("/api/layout")).json()["layout"] == DEFAULT_LAYOUT


@pytest.mark.parametrize(
    "layout",
    [
        {"items": [{"id": "nope"}]},
        {"items": [{"id": "group:Nope"}]},
        {"items": [{"id": "stats"}, {"id": "stats"}]},
        {"items": [{"id": "stats", "size": "xl"}]},
        {"enabled": "yes"},
        {"extra": 1},
        "layout",
        [],
    ],
)
async def test_backup_import_rejects_invalid_layout(client, layout):
    await setup_admin(client)
    await client.patch("/api/layout", json={"enabled": True, "items": ITEMS})
    await client.post("/api/services", json={"name": "keep", "url": "http://keep.lan"})
    r = await client.post("/api/backup", json={"version": 1, "layout": layout})
    assert r.status_code == 400, (layout, r.text)
    assert r.json()["error"]["code"] == "validation"
    assert (await client.get("/api/layout")).json()["layout"] == {"enabled": True, "items": ITEMS}
    names = [s["name"] for s in (await client.get("/api/services")).json()["services"]]
    assert names == ["keep"]


async def test_layout_requires_auth(client):
    anon = httpx.AsyncClient(
        transport=client._transport, base_url="http://testserver", headers=CLIENT_HEADERS
    )
    try:
        assert (await anon.get("/api/layout")).status_code == 401
        assert (await anon.patch("/api/layout", json={"enabled": True})).status_code == 401
        assert (await anon.delete("/api/layout")).status_code == 401
    finally:
        await anon.aclose()


async def test_layout_rejects_literal_json_null(client):
    await setup_admin(client)
    r = await client.patch(
        "/api/layout", content=b"null", headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 400, r.text

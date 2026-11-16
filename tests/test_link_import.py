from __future__ import annotations

import json
from contextlib import aclosing

import pytest

from tests.conftest import create_user, new_session, setup_admin

pytestmark = pytest.mark.anyio

IMPORT = "/api/import-links"


async def test_legacy_json_merges_only_links_in_the_current_account(client):
    await setup_admin(client)
    await create_user(client, "reader")
    existing = (
        await client.post("/api/services", json={"name": "Before", "url": "https://nas"})
    ).json()["service"]
    async with aclosing(await new_session(client.app, "reader")) as reader:
        await reader.post("/api/services", json={"name": "Reader's NAS", "url": "https://nas"})
        payload = {
            "format": "json",
            "content": json.dumps(
                {
                    "settings": {"pageTitle": "Ignored"},
                    "services": [
                        {
                            "id": "legacy-id",
                            "name": "NAS",
                            "url": "https://nas",
                            "desc": "Local files",
                            "icon": "server",
                            "ping": False,
                            "categoryOverride": "Files",
                        }
                    ],
                    "bookmarks": [{"name": "Docs", "url": "https://docs", "color": "#aB3"}],
                }
            ),
        }
        preview = (await client.post(IMPORT, json=payload)).json()
        assert preview["services"][0]["action"] == "update"
        assert preview["bookmarks"][0]["action"] == "add"
        assert (await client.get("/api/services")).json()["services"] == [existing]
        assert (await client.get("/api/bookmarks")).json()["bookmarks"] == []

        result = await client.post(IMPORT, json={**payload, "revision": preview["revision"]})
        assert result.status_code == 200, result.text
        migrated = result.json()["services"][0]
        assert migrated == {
            **existing,
            "name": "NAS",
            "description": "Local files",
            "icon": "server",
            "category": "Files",
            "check": False,
        }
        assert result.json()["bookmarks"][0]["color"] == "#aaBB33"
        assert (await client.get("/api/settings")).json()["settings"]["pageTitle"] != "Ignored"
        assert (await reader.get("/api/services")).json()["services"][0]["name"] == "Reader's NAS"
        assert (await reader.get("/api/bookmarks")).json()["bookmarks"] == []
        again = (await client.post(IMPORT, json=payload)).json()
        assert all(row["action"] == "unchanged" for row in again["services"] + again["bookmarks"])


async def test_yaml_rejects_stale_preview_then_preserves_omitted_fields(client):
    await setup_admin(client)
    existing = (
        await client.post(
            "/api/services", json={"name": "Before", "url": "https://nas", "check": False}
        )
    ).json()["service"]
    payload = {
        "format": "yaml",
        "content": (
            "version: 1\n"
            "services:\n  - name: NAS\n    url: https://nas\n"
            "bookmarks:\n  - name: Docs\n    url: https://docs\n"
        ),
    }
    first = (await client.post(IMPORT, json=payload)).json()["revision"]
    await client.patch("/api/services/" + existing["id"], json={"description": "Keep me"})
    stale = await client.post(IMPORT, json={**payload, "revision": first})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "stale_preview"
    assert (await client.get("/api/bookmarks")).json()["bookmarks"] == []

    second = (await client.post(IMPORT, json=payload)).json()["revision"]
    result = await client.post(IMPORT, json={**payload, "revision": second})
    assert result.status_code == 200, result.text
    assert result.json()["services"][0] == {**existing, "name": "NAS", "description": "Keep me"}
    assert result.json()["bookmarks"][0]["name"] == "Docs"


async def test_conflicts_prevent_even_unrelated_additions(client):
    await setup_admin(client)
    for name in ("Primary", "Secondary"):
        await client.post("/api/services", json={"name": name, "url": "https://nas"})
    payload = {
        "format": "json",
        "content": json.dumps(
            {
                "services": [
                    {"name": "Ambiguous", "url": "https://nas"},
                    {"name": "New", "url": "https://new"},
                ],
                "bookmarks": [
                    {"name": "First", "url": "https://docs"},
                    {"name": "Second", "url": "https://docs"},
                ],
            }
        ),
    }
    preview = (await client.post(IMPORT, json=payload)).json()
    assert [row["action"] for row in preview["services"]] == ["conflict", "add"]
    assert [row["action"] for row in preview["bookmarks"]] == ["conflict", "conflict"]
    apply = await client.post(IMPORT, json={**payload, "revision": preview["revision"]})
    assert apply.status_code == 409 and apply.json()["error"]["code"] == "import_conflict"
    assert len((await client.get("/api/services")).json()["services"]) == 2
    assert (await client.get("/api/bookmarks")).json()["bookmarks"] == []


@pytest.mark.parametrize(
    ("format_", "content"),
    [
        ("yaml", "services: []\nservices: []\n"),
        ("yaml", "services: &links []\nbookmarks: *links\n"),
        ("yaml", "services: " + "[" * 40 + "]" * 40),
        ("yaml", "services:\n  - {name: App, url: 'https://user:pass@nas'}"),
        ("json", '{"services":[],"services":[]}'),
    ],
)
async def test_invalid_files_get_validation_errors(client, format_, content):
    await setup_admin(client)
    response = await client.post(IMPORT, json={"format": format_, "content": content})
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "validation"

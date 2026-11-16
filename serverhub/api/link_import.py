"""Preview and merge a user's service and bookmark catalog."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Annotated, Literal

import anyio
import yaml
from pydantic import Field, ValidationError
from starlette.requests import Request
from starlette.responses import Response

from serverhub.api import schemas as s
from serverhub.api.serialize import bookmark_out, service_fields, service_out
from serverhub.auth.sessions import require_user
from serverhub.db import repo, transaction
from serverhub.errors import ApiError, validation
from serverhub.http import MAX_JSON_DEPTH, hub, json_response, json_too_deep, parse, validation_from

MAX_FILE_BYTES = 1024 * 1024


class ImportRequest(s.Strict):
    format: Literal["yaml", "json"]
    content: Annotated[str, Field(max_length=MAX_FILE_BYTES)]
    revision: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")] | None = None


class ImportBookmark(s.BookmarkCreate):
    url: s.ServiceUrl


class LinkDocument(s.Strict):
    version: Literal[1] = 1
    services: list[s.ServiceCreate] = Field(default_factory=list, max_length=s.MAX_SERVICES)
    bookmarks: list[ImportBookmark] = Field(default_factory=list, max_length=s.MAX_BOOKMARKS)


class LinkLoader(yaml.SafeLoader):
    """Read a bounded YAML tree with unique string keys and no YAML references."""

    depth = 0

    def compose_node(self, parent, index):
        event = self.peek_event()
        if (
            self.depth >= MAX_JSON_DEPTH
            or getattr(event, "anchor", None) is not None
            or getattr(event, "tag", None) is not None
        ):
            raise yaml.YAMLError("Unsupported YAML structure")
        self.depth += 1
        try:
            return super().compose_node(parent, index)
        finally:
            self.depth -= 1

    def construct_mapping(self, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in mapping:
                raise yaml.YAMLError("Mapping keys must be unique strings")
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping


def _unique_json_keys(pairs: list[tuple[str, object]]) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON key")
    return result


def _read_document(request: ImportRequest) -> object:
    text = request.content.removeprefix("\ufeff")
    try:
        raw = text.encode("utf-8")
    except UnicodeEncodeError:
        raise validation({"content": "Use UTF-8 text"}) from None
    if len(raw) > MAX_FILE_BYTES:
        raise ApiError(413, "payload_too_large", "Import files must be at most 1 MiB")
    if request.format == "yaml":
        try:
            return yaml.load(text, Loader=LinkLoader)  # noqa: S506 - restricted SafeLoader
        except (ValueError, yaml.YAMLError):
            raise validation(
                {"content": "Use one YAML document with unique keys and no aliases"}
            ) from None
    try:
        if json_too_deep(raw):
            raise ValueError("Too deeply nested")
        return json.loads(text, object_pairs_hook=_unique_json_keys)
    except ValueError:
        raise validation({"content": "Use valid JSON with unique keys"}) from None


def _legacy_entry(item: object, *, service: bool) -> object:
    if not isinstance(item, dict):
        return item
    fields = {key: item[key] for key in ("name", "url") if key in item}
    if service:
        for source, target in (
            ("desc", "description"),
            ("ping", "check"),
            ("categoryOverride", "category"),
        ):
            if source in item:
                fields[target] = item[source]
        if item.get("icon"):
            fields["icon"] = item["icon"]
    elif color := item.get("color"):
        if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{3}", color):
            color = "#" + "".join(channel * 2 for channel in color[1:])
        fields["color"] = color
    return fields


def _parse_links(request: ImportRequest) -> LinkDocument:
    raw = _read_document(request)
    if isinstance(raw, dict) and request.format == "json" and isinstance(raw.get("settings"), dict):
        if "version" in raw:
            raw = {k: v for k, v in raw.items() if k not in {"settings", "exported_at"}}
        else:
            legacy = {}
            for table in ("services", "bookmarks"):
                if table in raw:
                    rows = raw[table]
                    legacy[table] = (
                        [_legacy_entry(item, service=table == "services") for item in rows]
                        if isinstance(rows, list)
                        else rows
                    )
            raw = legacy
    try:
        doc = LinkDocument.model_validate(raw)
    except ValidationError as exc:
        raise validation_from(exc) from None
    if not (doc.services or doc.bookmarks):
        raise validation({"content": "Include at least one service or bookmark"})
    return doc


@dataclass
class Plan:
    rows: list[dict] = field(default_factory=list)
    additions: list[dict] = field(default_factory=list)
    updates: list[tuple[str, dict]] = field(default_factory=list)


def _plan(rows: list[dict], entries: list, limit: int) -> Plan:
    by_url = defaultdict(list)
    for row in rows:
        by_url[row["url"]].append(row)
    duplicates = Counter(item.url for item in entries)
    plan = Plan()
    for item in entries:
        matches = by_url[item.url]
        entry = {"name": item.name, "url": item.url}
        if duplicates[item.url] > 1:
            entry.update(action="conflict", reason="This URL appears more than once in the file.")
        elif len(matches) > 1:
            entry.update(action="conflict", reason="Multiple existing links use this URL.")
        elif not matches:
            entry["action"] = "add"
            plan.additions.append(
                service_fields(item) if isinstance(item, s.ServiceCreate) else item.model_dump()
            )
        else:
            current = matches[0]
            supplied = (
                service_fields(item, exclude_unset=True)
                if isinstance(item, s.ServiceCreate)
                else item.model_dump(exclude_unset=True)
            )
            changes = {key: value for key, value in supplied.items() if value != current[key]}
            entry["action"] = "update" if changes else "unchanged"
            if changes:
                entry.update(
                    previous_name=current["name"],
                    fields=["check" if key == "check_enabled" else key for key in changes],
                )
                plan.updates.append((current["id"], changes))
        plan.rows.append(entry)
    if plan.additions and len(rows) + len(plan.additions) > limit:
        for entry in plan.rows:
            if entry["action"] == "add":
                entry.update(
                    action="conflict",
                    reason=f"Adding these links would exceed the limit of {limit}.",
                )
    return plan


def _preview(conn: sqlite3.Connection, uid: str, doc: LinkDocument) -> tuple[str, Plan, Plan]:
    services = repo.list_owned(conn, "services", uid)
    bookmarks = repo.list_owned(conn, "bookmarks", uid)
    snapshot = [uid, doc.model_dump(exclude_unset=True), services, bookmarks]
    revision = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
    return (
        revision,
        _plan(services, doc.services, s.MAX_SERVICES),
        _plan(bookmarks, doc.bookmarks, s.MAX_BOOKMARKS),
    )


def _apply(conn: sqlite3.Connection, uid: str, doc: LinkDocument, expected: str) -> dict:
    with transaction(conn):
        revision, services, bookmarks = _preview(conn, uid, doc)
        if revision != expected:
            raise ApiError(
                409, "stale_preview", "The links or the file changed. Preview the import again."
            )
        if any(row["action"] == "conflict" for row in services.rows + bookmarks.rows):
            raise ApiError(
                409, "import_conflict", "Resolve the conflicts and preview the import again."
            )
        return {
            "services": [
                service_out(row)
                for row in repo.merge_owned(
                    conn, "services", uid, services.additions, services.updates
                )
            ],
            "bookmarks": [
                bookmark_out(row)
                for row in repo.merge_owned(
                    conn, "bookmarks", uid, bookmarks.additions, bookmarks.updates
                )
            ],
        }


async def import_links(request: Request) -> Response:
    user = await require_user(request)
    payload = await parse(request, ImportRequest)
    doc = await anyio.to_thread.run_sync(_parse_links, payload)
    db = hub(request).db
    if payload.revision is not None:
        return json_response(await db.run(_apply, user["id"], doc, payload.revision))
    revision, services, bookmarks = await db.run(_preview, user["id"], doc)
    return json_response(
        {"revision": revision, "services": services.rows, "bookmarks": bookmarks.rows}
    )

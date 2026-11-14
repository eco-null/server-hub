"""HTML pages, /static/* files and /healthz."""

from __future__ import annotations

import hashlib
import re
from email.utils import formatdate
from pathlib import Path

import anyio.to_thread
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from serverhub.auth.sessions import current_user
from serverhub.http import hub

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}
# name.<8+ hex chars>.ext is treated as content-hashed and cached forever.
HASHED_NAME = re.compile(r"\.[0-9a-f]{8,}\.[a-z0-9]+$")
MAX_STATIC_BYTES = 10 * 1024 * 1024

_etags: dict[tuple[str, int, int], str] = {}


def _not_found() -> Response:
    return Response("Not found", status_code=404, media_type="text/plain")


def _read(path: Path) -> tuple[bytes, str, float] | None:
    try:
        st = path.stat()
        if st.st_size > MAX_STATIC_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    key = (str(path), st.st_mtime_ns, st.st_size)
    etag = _etags.get(key)
    if etag is None:
        etag = '"' + hashlib.sha256(data).hexdigest()[:32] + '"'
        if len(_etags) > 2048:
            _etags.clear()
        _etags[key] = etag
    return data, etag, st.st_mtime


async def _file_response(request: Request, path: Path, cache_control: str) -> Response:
    result = await anyio.to_thread.run_sync(_read, path)
    if result is None:
        return _not_found()
    data, etag, mtime = result
    headers = {
        "ETag": etag,
        "Cache-Control": cache_control,
        "Last-Modified": formatdate(mtime, usegmt=True),
    }
    media = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
    inm = request.headers.get("if-none-match", "")
    if etag in {t.strip().removeprefix("W/") for t in inm.split(",")}:
        return Response(status_code=304, headers=headers)
    body = b"" if request.method == "HEAD" else data
    headers["Content-Length"] = str(len(data))
    return Response(body, headers=headers, media_type=media)


def _web_dir(request: Request) -> Path:
    return hub(request).config.web_dir


def _safe_join(root: Path, rel: str) -> Path | None:
    if not rel or "\\" in rel or "\x00" in rel:
        return None
    parts = rel.split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return None
    try:
        base = root.resolve()
        target = (base / rel).resolve()
    except (OSError, ValueError):
        return None
    if not target.is_relative_to(base) or not target.is_file():
        return None
    return target


async def static(request: Request) -> Response:
    root = _web_dir(request) / "static"
    target = _safe_join(root, request.path_params["path"])
    if target is None:
        return _not_found()
    cache = "public, max-age=31536000, immutable" if HASHED_NAME.search(target.name) else "no-cache"
    return await _file_response(request, target, cache)


def _page(filename: str, *, auth: bool):
    async def endpoint(request: Request) -> Response:
        user = await current_user(request)
        if auth and user is None:
            return RedirectResponse("/login", status_code=302)
        if not auth and user is not None:
            return RedirectResponse("/", status_code=302)
        path = _web_dir(request) / filename
        if not path.is_file():
            return _not_found()
        # Pages are tiny and depend on auth state: always revalidate, never share.
        return await _file_response(request, path, "no-store")

    return endpoint


async def healthz(request: Request) -> Response:
    if request.method == "HEAD":
        return Response(status_code=200, media_type="application/json")
    return JSONResponse({"status": "ok"}, headers={"Cache-Control": "no-store"})


routes = [
    Route("/", _page("index.html", auth=True), methods=["GET", "HEAD"]),
    Route("/settings", _page("settings.html", auth=True), methods=["GET", "HEAD"]),
    Route("/login", _page("login.html", auth=False), methods=["GET", "HEAD"]),
    Route("/static/{path:path}", static, methods=["GET", "HEAD"]),
    Route("/healthz", healthz, methods=["GET", "HEAD"]),
]

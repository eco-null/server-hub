"""Request helpers shared by the API and page routes."""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Iterable

from pydantic import BaseModel, ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import Scope

from serverhub.errors import ApiError, validation
from serverhub.hub import Hub

Network = ipaddress.IPv4Network | ipaddress.IPv6Network


def _in_any(ip: str, nets: Iterable[Network]) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr.version == n.version and addr in n for n in nets)


def _header(scope: Scope, name: bytes) -> str | None:
    for k, v in scope.get("headers", []):
        if k == name:
            return v.decode("latin-1")
    return None


def resolve_client(scope: Scope, trusted: tuple[Network, ...]) -> tuple[str, bool]:
    """Return (client_ip, is_https), honouring X-Forwarded-* only from trusted proxies."""
    peer = (scope.get("client") or ("0.0.0.0", 0))[0]
    https = scope.get("scheme") == "https"
    if not trusted or not _in_any(peer, trusted):
        return peer, https
    xff = _header(scope, b"x-forwarded-for")
    ip = peer
    if xff:
        hops = [h.strip() for h in xff.split(",") if h.strip()]
        for hop in reversed(hops):
            ip = hop
            if not _in_any(hop, trusted):
                break
        try:
            ip = str(ipaddress.ip_address(ip))
        except ValueError:
            ip = peer
    proto = _header(scope, b"x-forwarded-proto")
    if proto:
        https = proto.split(",")[0].strip().lower() == "https"
    return ip, https


def hub(request: Request) -> Hub:
    return request.app.state.hub


def client_ip(request: Request) -> str:
    return request.scope["state"]["client_ip"]


def limit_ip(ip: str) -> str:
    """Rate-limit identity of a client address.

    IPv4-mapped IPv6 collapses to the IPv4 address and other IPv6 addresses to
    their /64, since one host or household typically owns a whole /64.
    """
    try:
        addr = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return ip.strip().lower()[:64]
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            return str(addr.ipv4_mapped)
        return str(ipaddress.IPv6Network((addr, 64), strict=False))
    return str(addr)


def client_limit_ip(request: Request) -> str:
    return limit_ip(client_ip(request))


def _pydantic_fields(exc: ValidationError) -> dict[str, str]:
    fields: dict[str, str] = {}
    for err in exc.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "body"
        if err["type"] == "extra_forbidden":
            msg = "unknown field"
        elif err["type"] == "missing":
            msg = "required"
        else:
            msg = err["msg"].removeprefix("Value error, ")
        fields.setdefault(loc, msg)
    return fields


def validation_from(exc: ValidationError) -> ApiError:
    return validation(_pydantic_fields(exc))


MAX_JSON_DEPTH = 32
_JSON_STRING = re.compile(rb'"(?:[^"\\]|\\.)*"')
_JSON_NESTING = re.compile(rb"[\[\]{}]")


def json_too_deep(raw: bytes, limit: int = MAX_JSON_DEPTH) -> bool:
    """Cheap pre-scan: does ``raw`` open more than ``limit`` nested arrays/objects?"""
    depth = 0
    for m in _JSON_NESTING.finditer(_JSON_STRING.sub(b"", raw)):
        if m.group() in (b"[", b"{"):
            depth += 1
            if depth > limit:
                return True
        else:
            depth -= 1
    return False


def _invalid_json() -> ApiError:
    return ApiError(400, "invalid_json", "Request body is not valid JSON")


async def read_json(request: Request) -> object:
    raw = await request.body()
    if not raw.strip():
        return {}
    if json_too_deep(raw):
        raise _invalid_json()
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise _invalid_json() from None


async def parse[M: BaseModel](request: Request, model: type[M]) -> M:
    data = await read_json(request)
    if not isinstance(data, dict):
        raise validation({"body": "must be a JSON object"})
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise validation_from(exc) from None


def json_response(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status)


def no_content() -> Response:
    return Response(status_code=204)

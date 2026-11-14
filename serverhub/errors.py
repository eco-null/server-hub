"""The one error type handlers raise; rendered as {"error": {...}} JSON."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str = "",
        *,
        fields: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message or code.replace("_", " ").capitalize()
        self.fields = fields
        self.headers = headers or {}

    def body(self) -> dict:
        err: dict = {"code": self.code, "message": self.message}
        if self.fields is not None:
            err["fields"] = self.fields
        return {"error": err}


def not_found() -> ApiError:
    return ApiError(404, "not_found", "Not found")


def unauthenticated() -> ApiError:
    return ApiError(401, "unauthenticated", "Sign in required")


def forbidden(message: str = "Not allowed") -> ApiError:
    return ApiError(403, "forbidden", message)


def validation(fields: dict[str, str], message: str = "Invalid input") -> ApiError:
    return ApiError(400, "validation", message, fields=fields)


def rate_limited(retry_after: int) -> ApiError:
    retry_after = max(1, int(retry_after))
    return ApiError(
        429,
        "rate_limited",
        "Too many attempts, try again later",
        headers={"Retry-After": str(retry_after)},
    )

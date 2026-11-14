# Server Hub HTTP API

This is the contract between the backend (`serverhub/`) and the frontend (`web/`).
All `/api/*` endpoints speak JSON (`Content-Type: application/json`) and return
errors as `{"error": {"code": "<machine_code>", "message": "<human text>"}}`.

## Conventions

- **Auth:** an opaque, server-side session in an `HttpOnly`, `SameSite=Lax` cookie.
  No token is ever readable from JavaScript.
- **Unauthenticated:** `/api/*` returns `401 {"error":{"code":"unauthenticated"}}`;
  page routes redirect `302` to `/login`.
- **CSRF:** every non-GET request must be same-origin (`Origin` / `Sec-Fetch-Site`
  check) and, for `/api/*`, carry a JSON content type. No state change on GET.
- **Roles:** `admin` and `user`. The first account created through setup is the admin.
- **IDs** are UUID strings. Timestamps are ISO-8601 UTC.
- **Status codes:** 200/201 success, 204 no content, 400 validation
  (`code: "validation"`, with `fields`), 401, 403, 404, 409 conflict, 429 rate
  limited (with `Retry-After`).

## Pages and static

| Path | Access | Serves |
|---|---|---|
| `/` | session | `web/index.html` (dashboard) |
| `/settings` | session | `web/settings.html` |
| `/login` | public | `web/login.html` (sign in, 2FA step, first-run setup, sign up when open) |
| `/static/*` | public | files under `web/static/` only |
| `/healthz` | public, GET + HEAD | `{"status":"ok"}` |

## Auth

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/auth/state` | – | `{"setup_required": bool, "registration_open": bool, "authenticated": bool}` |
| POST | `/api/auth/setup` | `{email, username, password}` | Creates the first admin; only while `setup_required`. Logs in. `{"user": User}` |
| POST | `/api/auth/login` | `{identifier, password}` (`identifier` = email or username) | `{"user": User}` or `{"twofa_required": true}` |
| POST | `/api/auth/2fa` | `{code}` (TOTP or recovery code) | `{"user": User}`. Requires the pending-login state from `/login`. |
| POST | `/api/auth/register` | `{email, username, password}` | Only when registration is open, else `403 registration_closed`. `{"user": User}` |
| POST | `/api/auth/logout` | – | `204`; the session is revoked server-side |

`User` = `{id, email, username, role, twofa_enabled}`.
Username: `^[a-zA-Z0-9_]{3,20}$`, case-insensitive unique. Password: 10–128 chars.
Login failures always return the same `401 invalid_credentials`.

## Account

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/me` | – | `{"user": User}` |
| PUT | `/api/me/password` | `{current_password, new_password}` | `204`; other sessions are revoked |
| POST | `/api/me/2fa/setup` | – | `{"secret", "otpauth_uri", "qr_svg"}`; the pending secret is held server-side |
| POST | `/api/me/2fa/enable` | `{code}` | `{"recovery_codes": [string × 10]}` |
| POST | `/api/me/2fa/disable` | `{code}` | `204` |

## Bootstrap

`GET /api/bootstrap` →
`{"user": User, "settings": Settings, "services": [Service], "bookmarks": [Bookmark]}`

## Settings

`GET /api/settings` → `{"settings": Settings}`
`PATCH /api/settings` body: a partial `Settings` object; unknown keys are rejected.
Returns the full merged `{"settings": Settings}`.
`DELETE /api/settings` → resets to defaults, returns `{"settings": Settings}`.

```jsonc
Settings = {
  "theme": "auto" | "light" | "dark",
  "accent": "#5E6AD2",                 // #rrggbb
  "userName": "", "pageTitle": "", "subtitle": "", "defaultDomain": "",
  "wallpaper": { "mode": "none" | "gradient" | "image", "gradient": "<id>", "url": "", "showGrid": true },
  "features": { "clock": true, "greeting": true, "stats": true, "search": true, "statusChecks": true },
  "search": { "provider": "google" | "duckduckgo" | "bing" | "startpage" | "searxng", "searxngUrl": "" }
}
```

Settings never contain secrets. 2FA and Beszel credentials live elsewhere.

## Services

```jsonc
Service = { "id", "name", "url", "description", "icon", "category", "check", "created_at" }
// url: http(s) only, ≤ 2000. name 1–200. description ≤ 500.
// icon: one of the known icon ids. category: a known category id, or null = auto-categorize.
// check: whether the server runs status checks for it.
```

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/services` | – | `{"services": [Service]}` |
| POST | `/api/services` | Service fields without `id` | `201 {"service": Service}` |
| PATCH | `/api/services/{id}` | partial fields | `{"service": Service}` |
| DELETE | `/api/services/{id}` | – | `204` |

## Bookmarks

`Bookmark = { "id", "name", "url", "color", "created_at" }` (`color`: `#rrggbb`).
Same four routes as services under `/api/bookmarks`, with `{"bookmark": …}` / `{"bookmarks": […]}`.

## Status checks

`GET /api/status` →
`{"statuses": {"<service_id>": {"state": "up" | "down" | "unknown", "http_status": 200 | null, "latency_ms": 42 | null, "checked_at": "…"}}}`

Checks run server-side with a concurrency cap, a timeout and a short TTL cache.
`up` means the target answered with a status below 500.

## Beszel

`BeszelInstance = { "id", "name", "url", "username", "has_password": bool }` — passwords are write-only.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/beszel/instances` | – | `{"instances": [BeszelInstance]}` |
| POST | `/api/beszel/instances` | `{name?, url, username, password}` | `201 {"instance": BeszelInstance}` |
| PATCH | `/api/beszel/instances/{id}` | partial; omitted `password` keeps the stored one | `{"instance": BeszelInstance}` |
| DELETE | `/api/beszel/instances/{id}` | – | `204` |
| POST | `/api/beszel/test` | `{url, username, password}` or `{instance_id}` | `{"ok": bool, "name": string | null, "error": string | null}` |
| GET | `/api/beszel/systems` | – | `{"instances": [{"id", "name", "ok": bool, "error": string | null, "systems": [System]}]}` |

`System = { "name", "status", "host", "cpu", "memory", "disk", "uptime_seconds" }` (percentages 0–100, nullable).

## Host stats (admin only)

`GET /api/stats` → `{"hostname", "cpu", "memory", "disk"}` (percentages, nullable).

## Backup

`GET /api/backup` → `{"version": 1, "exported_at", "settings", "services", "bookmarks"}` (no secrets).
`POST /api/backup` body: the same document. Replaces the caller's settings, services and
bookmarks in one transaction. Returns the same shape as `/api/bootstrap`.

## Admin (role `admin`)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/admin/users` | – | `{"users": [User + created_at]}` |
| POST | `/api/admin/users` | `{email, username, password, role}` | `201 {"user": User}` |
| PATCH | `/api/admin/users/{id}` | `{role?, password?, disable_twofa?: true}` | `{"user": User}` |
| DELETE | `/api/admin/users/{id}` | – | `204`; the last admin cannot be removed |
| GET | `/api/admin/config` | – | `{"registration_open": bool}` |
| PUT | `/api/admin/config` | `{registration_open}` | same |

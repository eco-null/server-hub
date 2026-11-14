# Server Hub HTTP API

This is the contract between the backend (`serverhub/`) and the frontend (`web/`).
All `/api/*` endpoints speak JSON (`Content-Type: application/json`) and return
errors as `{"error": {"code": "<machine_code>", "message": "<human text>"}}`
(plus `"fields": {"<field>": "<problem>"}` for `validation`).

## Conventions

- **Auth:** an opaque, server-side session in an `HttpOnly`, `SameSite=Lax` cookie
  (`serverhub_session`, or `__Host-serverhub_session` when Secure cookies are on).
  No token is ever readable from JavaScript. A user keeps at most 20 sessions; the
  oldest is revoked when a 21st is created.
- **Unauthenticated:** `/api/*` returns `401 {"error":{"code":"unauthenticated"}}`;
  page routes redirect `302` to `/login`.
- **Host check (every request, pages included):** the `Host` header must be an IP
  address, `localhost`, the host of `SERVERHUB_PUBLIC_URL`, or a name listed in
  `SERVERHUB_ALLOWED_HOSTS`. Anything else gets `400` with a short `text/plain`
  body naming `SERVERHUB_ALLOWED_HOSTS` (not JSON, also on `/api/*`).
- **CSRF (every method except GET/HEAD/OPTIONS):**
  - if `Origin` is present it must equal `SERVERHUB_PUBLIC_URL`, or be exactly the
    request's own (allowlisted) host with the scheme the server sees; else `403 csrf`;
  - otherwise, if `Sec-Fetch-Site` is present it must be `same-origin`; else `403 csrf`;
  - otherwise (neither header), a request that carries a session or pending-2FA cookie
    must send a non-empty `X-ServerHub-Client` header (the web UI sends
    `X-ServerHub-Client: web` on every API request); else `403 csrf`. Cookie-less
    non-browser clients need nothing extra.
- **Bodies:** unsafe `/api/*` requests that have a body (or a `Content-Type`) must use
  `application/json`, else `415 unsupported_media_type`. Bodies are capped at 64 KiB
  (4 MiB for `POST /api/backup`), else `413 payload_too_large`. JSON nested deeper than
  32 levels, or not valid JSON, is `400 invalid_json`.
- **No state change on GET.**
- **Roles:** `admin` and `user`. The first account created through setup is the admin.
- **IDs** are UUID strings. Timestamps are ISO-8601 UTC.
- **Rate limits:** password, setup-token and 2FA checks are counted *before* they are
  evaluated. Over a limit: `429 rate_limited` with `Retry-After` (seconds). Also `429`
  (with `Retry-After: 1`) when more than 2 password checks from the same client
  address are in flight at once.

### Status codes

200/201 success, 204 no content, 400, 401, 403, 404, 405, 409, 413, 415, 429, 500.

### Error codes

| Status | `code` | When |
|---|---|---|
| 400 | `validation` | Body failed validation; `fields` names each bad field (`"required"`, `"unknown field"`, `"incorrect"`, or a message) |
| 400 | `invalid_json` | Body is not valid JSON, or nests deeper than 32 levels |
| 400 | `bad_request` | Invalid `Content-Length` |
| 400 | – (text/plain) | `Host` not allowed (see Host check) |
| 401 | `unauthenticated` | No valid session |
| 401 | `invalid_credentials` | Login failed (same response for unknown users and wrong passwords) |
| 401 | `invalid_code` | Wrong TOTP / recovery code |
| 401 | `login_expired` | `/api/auth/2fa` without a live pending login (expired, or 5 attempts used) |
| 403 | `csrf` | CSRF check failed (see Conventions) |
| 403 | `forbidden` | Authenticated but not allowed (e.g. admin only) |
| 403 | `registration_closed` | `/api/auth/register` while registration is closed |
| 403 | `invalid_setup_token` | `/api/auth/setup` with a missing/wrong `setup_token` |
| 404 | `not_found` | Unknown route or id (also for ids of other users' rows) |
| 405 | `method_not_allowed` | Known path, wrong method |
| 409 | `conflict` | Email / username taken (`fields.email` / `fields.username` = `"taken"`) |
| 409 | `setup_complete` | `/api/auth/setup` after an account exists |
| 409 | `limit_reached` | Too many services / bookmarks / Beszel instances |
| 409 | `last_admin` | Would remove or demote the last admin |
| 409 | `twofa_enabled` | 2FA already on (setup / enable) |
| 409 | `twofa_disabled` | 2FA is not on (disable) |
| 409 | `twofa_setup_expired` | `enable` without a live `setup` (10 min) |
| 413 | `payload_too_large` | Body over the size cap |
| 415 | `unsupported_media_type` | Unsafe `/api/*` request with a non-JSON body |
| 429 | `rate_limited` | Throttled; see `Retry-After` |
| 500 | `internal` | Unexpected server error (details only in the server log) |

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
| POST | `/api/auth/setup` | `{email, username, password, setup_token}` | Creates the first admin; only while `setup_required`. Logs in. `{"user": User}` |
| POST | `/api/auth/login` | `{identifier, password}` (`identifier` = email or username) | `{"user": User}` or `{"twofa_required": true}` |
| POST | `/api/auth/2fa` | `{code}` (TOTP or recovery code) | `{"user": User}`. Requires the pending-login state from `/login`. |
| POST | `/api/auth/register` | `{email, username, password}` | Only when registration is open, else `403 registration_closed`. `{"user": User}` |
| POST | `/api/auth/logout` | – | `204`; the session is revoked server-side |

`User` = `{id, email, username, role, twofa_enabled}`.
Username: `^[a-zA-Z0-9_]{3,20}$`, case-insensitive unique. Password: 10–128 chars.
Login failures always return the same `401 invalid_credentials`.

**Setup token.** `setup_token` is `SERVERHUB_SETUP_TOKEN` if set; otherwise a random
token generated at startup while no account exists and printed in the server log
(`docker compose logs server-hub`). A missing `setup_token` is `400 validation`
(`fields.setup_token = "required"`); a wrong one is `403 invalid_setup_token`. Setup
attempts are limited to 10 per hour per client address. Order of checks: rate limit,
body validation, `409 setup_complete`, token. The CLI
`python -m serverhub create-admin` needs no token.

**Login throttling.** Per client address (IPv4, or IPv6 /64; `::ffff:a.b.c.d` counts as
IPv4): 20 attempts / 15 min across all accounts. Per account *and* address: 8 attempts /
15 min, then locked 15 min. Per account across all addresses: soft, never a lockout —
above 30 attempts / 15 min each attempt is delayed (up to 4 s). Username and email of
one account share one budget; unknown identifiers are throttled the same way. A
successful sign-in resets that account's counters. 2FA codes: 20 / 15 min per address
and 6 / 15 min per account (hard). Registration: 5 / hour per address.

## Account

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/me` | – | `{"user": User}` |
| PUT | `/api/me/password` | `{current_password, new_password}` | `204`; other sessions are revoked |
| POST | `/api/me/2fa/setup` | `{current_password}` | `{"secret", "otpauth_uri", "qr_svg"}`; the pending secret is held server-side |
| POST | `/api/me/2fa/enable` | `{code}` | `{"recovery_codes": [string × 10]}` |
| POST | `/api/me/2fa/disable` | `{current_password, code}` | `204` |

A wrong `current_password` (password change, 2FA setup, 2FA disable) is
`400 validation` with `fields.current_password = "incorrect"`. These checks share one
budget of 8 failures / 15 min per account (`429 rate_limited` beyond it).

## Bootstrap

`GET /api/bootstrap` →
`{"user": User, "settings": Settings, "services": [Service], "bookmarks": [Bookmark], "docker": {"enabled": bool}}`

`docker.enabled` is true only when Docker discovery is configured (`SERVERHUB_DOCKER_HOST`)
**and** this user may see discovered services (admins always; other users only while
`docker_visible_to_users` is on). `services` never contains discovered services; fetch
them from `GET /api/docker`.

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
// url: http(s) only, ≤ 2000, no whitespace / control characters, a host the HTTP
//   client can parse (valid IDNA), port 1-65535. name 1–200. description ≤ 500.
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

`Bookmark = { "id", "name", "url", "color", "created_at" }` (`color`: `#rrggbb`; `url` as for services).
Same four routes as services under `/api/bookmarks`, with `{"bookmark": …}` / `{"bookmarks": […]}`.

## Status checks

`GET /api/status` →
`{"statuses": {"<service_id>": {"state": "up" | "down" | "unknown", "http_status": 200 | null, "latency_ms": 42 | null, "checked_at": "…" | null}}}`

When the caller may see discovered Docker services (see Docker discovery), the map also
contains every discovered service with `check: true`, keyed by its `docker:<name>` id,
with the same per-role detail rules.

Checks run server-side with a concurrency cap, a timeout and a short per-user TTL cache.
`up` means the target answered with a status below 500. `http_status` and `latency_ms`
are always `null` for non-admin users (state only), and `null` whenever no response
was received. A service whose check fails unexpectedly is reported `unknown`; it never
fails the whole request.

## Beszel

`BeszelInstance = { "id", "name", "url", "username", "has_password": bool }` — passwords are write-only.

Beszel `url`: `http(s)://host[:port][/path-prefix]` only — no query (`?`), fragment
(`#`) or credentials, and the path may contain only letters, digits and `. _ ~ - /`
(no `..` segments). API paths are appended to it.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/beszel/instances` | – | `{"instances": [BeszelInstance]}` |
| POST | `/api/beszel/instances` | `{name?, url, username, password}` | `201 {"instance": BeszelInstance}` |
| PATCH | `/api/beszel/instances/{id}` | partial; omitted `password` keeps the stored one | `{"instance": BeszelInstance}` |
| DELETE | `/api/beszel/instances/{id}` | – | `204` |
| POST | `/api/beszel/test` | `{url, username, password}` or `{instance_id}` | `{"ok": bool, "name": string | null, "error": string | null}` |
| GET | `/api/beszel/systems` | – | `{"instances": [{"id", "name", "ok": bool, "error": string | null, "systems": [System]}]}` |

`System = { "name", "status", "host", "cpu", "memory", "disk", "uptime_seconds" }` (percentages 0–100, nullable).

`error` texts: admins get a specific, safe message (e.g. "That address is not allowed",
"Could not connect", "Beszel rejected the username or password"). Every other user gets
one generic message for every failure ("Could not reach Beszel or sign in; check the URL
and credentials"), so the endpoints cannot be used to probe the network.

## Docker discovery

Optional, off unless `SERVERHUB_DOCKER_HOST` is set (`tcp://host:port` or
`http://host:port` of a read-only socket proxy; see `.env.example`). Containers labelled
`serverhub.enable=true` become read-only service cards; admins get suggestions for
unlabelled containers that publish ports. Nothing is stored: results are rebuilt from the
Docker API's container list (`GET /containers/json?all=true`, cached about 10 s, one
upstream call at a time) on each request.

```jsonc
DiscoveredService = {
  "id": "docker:<container name>",   // stable across container re-creation
  "name", "url", "description", "icon", "category", "check",   // as for Service
  "container": {
    "name": "<container name>", "image": "<image reference>",
    "state": "running" | "exited" | "paused" | "restarting" | "created" | "dead" | "removing",
    "status": "<Docker's human status text, e.g. Up 2 hours (healthy)>",
    "health": "healthy" | "unhealthy" | "starting" | null
  }
}
```

Labels (values are untrusted input and validated like an ordinary Service):

| Label | Default | Invalid value |
|---|---|---|
| `serverhub.enable` | – (required: `true`) | not discovered |
| `serverhub.url` | – (required, http/https) | container skipped |
| `serverhub.name` | container name, prettified (`my_app-1` → `My App`) | default |
| `serverhub.description` | `""` (≤ 500) | default |
| `serverhub.icon` | guessed from the image/name, else `box` | default |
| `serverhub.category` | `null` (auto) | `null` |
| `serverhub.check` | `true` (`true`/`false`) | `true` |

Control characters are stripped from names and descriptions; label values over 2048
characters count as invalid; at most 500 containers are examined. Stopped containers
are still returned (see `container.state`).

| Method | Path | Access | Result |
|---|---|---|---|
| GET | `/api/docker` | session | `{"enabled": bool, "available": bool, "error": string \| null, "services": [DiscoveredService]}`; admins also get `"skipped"` and `"warnings"` |
| GET | `/api/admin/docker/suggestions` | admin | `{"available": bool, "error": string \| null, "suggestions": [Suggestion]}` |

`GET /api/docker`:
- feature off, or a non-admin while `docker_visible_to_users` is off:
  `{"enabled": false, "available": false, "error": null, "services": []}`;
- Docker API unreachable or misbehaving: `"available": false` and a short `error`.
  Non-admins always get `"Docker discovery is unavailable right now"`; admins get a more
  specific but safe text (e.g. "The Docker API did not answer in time", "The socket proxy
  refused to list containers; enable CONTAINERS=1 on the proxy", "The Docker API answered
  HTTP 500"). Remote output is never echoed;
- admin-only diagnostics: `"skipped": [{"container", "reason"}]` (labelled containers that
  produced no card, e.g. missing or invalid `serverhub.url`) and
  `"warnings": [{"container", "reason"}]` (labels that fell back to a default;
  `container` is `"*"` for listing-wide notes such as the 500-container cap).

```jsonc
Suggestion = {
  "container": { "name", "image", "state": "running" },
  "ports": [{ "private": 80, "public": 8081, "protocol": "tcp" | "udp" }],
  "suggested": { "name", "url": string | null, "icon", "category": string | null }
}
```

Suggestions are running containers without a `serverhub.enable` label (any value) that
publish at least one TCP port (ports bound only to the Docker host's loopback are
ignored), excluding Server Hub's own container, the socket proxy, and containers whose
suggested URL is already one of the calling admin's services. `suggested.url` is
`http(s)://<SERVERHUB_DOCKER_PUBLIC_HOST>[:<public port>]` for the most likely web port
(preferring container ports 80, 443, 8080, 3000, 8000, 8443, …, else the lowest), `https`
for 443/8443/9443, and `null` when `SERVERHUB_DOCKER_PUBLIC_HOST` is empty. To add one,
`POST /api/services` with the suggested fields; the new service is an ordinary service of
that admin.

Discovered services are read-only: `PATCH`/`DELETE /api/services/docker:…` answer
`404 not_found`, and they are never part of a backup.

## Host stats (admin only)

`GET /api/stats` → `{"hostname", "cpu", "memory", "disk"}` (percentages, nullable).

## Backup

`GET /api/backup` → `{"version": 1, "exported_at", "settings", "services", "bookmarks"}` (no secrets).
`POST /api/backup` body: the same document (≤ 4 MiB). Replaces the caller's settings,
services and bookmarks in one transaction. Returns the same shape as `/api/bootstrap`.

## Admin (role `admin`)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/admin/users` | – | `{"users": [User + created_at]}` |
| POST | `/api/admin/users` | `{email, username, password, role}` | `201 {"user": User}` |
| PATCH | `/api/admin/users/{id}` | `{role?, password?, disable_twofa?: true}` | `{"user": User}` |
| DELETE | `/api/admin/users/{id}` | – | `204`; the last admin cannot be removed |
| GET | `/api/admin/config` | – | `{"registration_open": bool, "docker_visible_to_users": bool}` |
| PUT | `/api/admin/config` | partial: `{registration_open?, docker_visible_to_users?}` (at least one; `null` is rejected) | the full config, as GET |

`docker_visible_to_users` (default `false`): show discovered Docker services to every
user, not only admins. It has no effect while Docker discovery is not configured.

## Secret key changes

`SERVERHUB_SECRET_KEY` encrypts TOTP secrets and Beszel passwords and keys the
recovery-code hashes; passwords (argon2id) and sessions do not depend on it. After a
key change, accounts with 2FA cannot finish signing in (`/api/auth/2fa` answers
`401 invalid_code`) and Beszel instances report "Stored password cannot be decrypted"
(admins; generic message for others). Recovery: `python -m serverhub reset-password
--user NAME --disable-2fa` (new password, 2FA off, sessions revoked), or an admin
`PATCH /api/admin/users/{id}` with `{"disable_twofa": true}`; then re-enrol 2FA and
re-enter Beszel passwords.

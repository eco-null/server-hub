# Server Hub — Login + Hosting Design

**Date:** 2026-07-31
**Status:** Approved

## Objective

Self-host Server Hub on a Proxmox LXC cloud VPS without nginx or cloudflared.
Add real authentication and system-stats backend so the site is fully functional
from a single `server.py` process.

## Decisions

- **Auth:** Styled login page + session cookie, enforced server-side.
- **Users:** Single account. Credentials via env vars
  `HUB_USER` (default `admin`) and `HUB_PASSWORD` (required).
- **Port:** `8642` (unassigned, no common service). Override with `HUB_PORT`.
- **TLS:** None for now (plain HTTP). Cloudflared tunnel will be added later
  via the Cloudflare Zero Trust panel, which handles HTTPS at the edge.
- **Stats:** `server.py` reads `/proc` and serves `/api/stats`.
- **Stack:** Python 3 standard library only. Zero pip installs.

## Components

### `server.py` (new)

- `ThreadingHTTPServer` binding `0.0.0.0:{HUB_PORT}`.
- Refuses to start if `HUB_PASSWORD` is unset.
- Routes:
  - `GET /login` — unauthenticated: serve `login.html`; authenticated: redirect to `/`.
  - `POST /login` — verify form credentials. Success: set session cookie,
    redirect to `/`. Failure: render `login.html?error=1`.
  - `GET /logout` — clear session cookie, redirect to `/login`.
  - `GET /` — authenticated: serve `index.html`; else redirect to `/login`.
  - `GET /{static}` — authenticated: serve file; else redirect to `/login`.
  - `GET /api/stats` — authenticated: JSON `{host, cpu, mem, disk}`.
  - `GET /api/me` — authenticated: JSON `{email: <username>}`.
- Session cookie: random token (`secrets.token_urlsafe`), `HttpOnly`,
  `SameSite=Lax`, 30-day expiry, stored in-memory.
- Brute-force guard: 5 failed login attempts per IP → 60s lockout.
- Correct MIME types for .html, .js, .css, .svg, .json, .txt, .png, .ico, .map.

### `login.html` (new)

- Static page matching the glassmorphism theme (inline CSS, no CDN dependency).
- Form posts to `/login`; shows inline error on `?error=1`.

### Existing files

- `index.html` — no logic changes. It already polls `/api/me` and `/api/stats`.
- `SETUP-LXC.md` — rewrite hosting section: systemd unit + env vars for
  `server.py`; note Cloudflare Tunnel via Zero Trust panel for HTTPS later.
- `README.md` — update deploy section.

## Data Flow

1. Browser hits `GET /` → server checks session cookie → redirect to `/login` if absent.
2. User submits form → `POST /login` → verify → set cookie → redirect `/`.
3. Dashboard loads → `GET /api/me` → "signed in: <user>" chip.
4. Dashboard polls `GET /api/stats` → CPU/Mem/Disk bars fill.

## Error Handling

- Wrong password → `login.html?error=1` with inline message.
- Lockout → generic "too many attempts" message, no hint at valid usernames.
- Missing `HUB_PASSWORD` → server logs clear error and exits.
- `/api/*` and static files all 302 to `/login` when unauthenticated (no data leak).

## Testing / Verification

- Run locally, `curl`:
  1. `GET /` without cookie → 302 to `/login`.
  2. `POST /login` with wrong password → error page.
  3. `POST /login` with correct creds → Set-Cookie, then `GET /` serves index.
  4. `GET /api/stats` with cookie → valid JSON numbers.
  5. 5 bad logins → lockout message.
- Existing `tests.html` DOM suite unaffected (client-side only).

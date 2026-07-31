# Server Hub — Persistent Services, Hover Edit/Delete

**Date:** 2026-07-31
**Status:** Approved
**Scope:** Server-persisted service links with hover edit/delete on dashboard cards.

## Problem

Service links are currently split across two client-only locations:

1. `SERVICES_DEFAULT` — a hardcoded array in `index.html` (now intentionally empty).
2. `HubSettings.services` — per-browser `localStorage` under `server-hub:settings`.

Both are non-permanent: localStorage is per-device and lost on a browser wipe, and
the hardcoded array requires editing source files. Users want:

- A **delete** button on hover for every card (easier management).
- An **edit** button on hover for domain/URL changes and icon updates.
- All added links **permanent by default** — no cached or non-permanent storage.

## Decisions (confirmed with user)

- **Storage:** server-side JSON file via authenticated CRUD API. `server.py` gains
  read/write endpoints; `services.json` next to `server.py` becomes the single
  source of truth.
- **Migration:** one-time push of any existing `localStorage` services up to the
  server on first load after the change, then drop the local copy. Server JSON is
  authoritative afterwards.
- **Icon picker:** a grid of the existing `ICONS` map in `index.html` (no new icons).
- **Button placement:** hover-revealed edit + delete on dashboard cards for ALL
  services. The settings.html services editor stays and is repointed to the same API.

## Storage & API (server.py)

New data file `services.json` co-located with `server.py`. Written atomically
(temp file + `os.replace`) under a `threading.Lock` so concurrent edits never
produce a corrupt file.

Each service entry gets a stable server-assigned `id` so edit/delete remain correct
after name or URL changes (the current `url|name` composite key breaks on edits).
Entry shape:

```
{ "id": "…", "name": "Grafana", "url": "https://grafana.example.com",
  "desc": "Metrics", "icon": "chart", "ping": true,
  "categoryOverride": null }
```

`categoryOverride` is optional (null = auto-categorize). `icon` defaults to a
known key or `box`.

Auth-gated endpoints (all return `401 {"error":"unauthenticated"}` JSON when not
signed in, matching `/api/stats` and `/api/me`):

| Method | Path                  | Body                | Behavior                                  |
|--------|-----------------------|---------------------|-------------------------------------------|
| GET    | `/api/services`       | —                   | `{ "services": [...] }`                    |
| POST   | `/api/services`       | service object      | add; returns updated `{ "services": [...] }` |
| PUT    | `/api/services/<id>`  | partial update      | update name/url/desc/icon/ping/categoryOverride; returns updated list |
| DELETE | `/api/services/<id>`  | —                   | remove; returns updated list              |

Validation (400 with a JSON error message on failure):

- `name` required, non-empty, ≤ 200 chars.
- `url` required, must parse as http/https URL, ≤ 2000 chars.
- `icon` must be a key in the frontend `ICONS` map (server keeps a known-key list);
  unknown/missing → `box`.
- `desc` optional, ≤ 500 chars.
- Body size guarded like `/login` (reject oversized bodies before reading).

POST/PUT return the full updated list so the client re-renders from the response.
PUT replaces the whole object built from validated fields (id preserved).

## Frontend (index.html)

### Data flow

- `SERVICES_DEFAULT` array is **removed**. Services come from the API only.
- `loadServices()` becomes async: `fetch('/api/services')` → `{ services }`.
- On boot, render is async: fetch list, then `renderGroups()`. While loading, the
  existing skeleton cards remain visible.
- If the API is unreachable (e.g. `file://` preview, server down): show an empty
  dashboard with a small non-blocking notice. **No cached fallback** — per user
  requirement, cached/non-permanent data is not used.

### One-time migration

On boot, before rendering:

1. Read legacy sources: `HubSettings.services` and the older `server-hub:services` key.
2. If any entries exist, `POST` each to `/api/services` (idempotent-ish; a failure
   just logs — next boot retries).
3. Clear `HubSettings.services` and the legacy key once push succeeds.
4. Proceed to render from the server list.

No dedupe needed in practice (the old list is small and cleared after), but entries
that already exist server-side (same name+url) are skipped to avoid duplicates.

### Card hover actions (all services)

Every card gets hover-revealed actions replacing the current always-visible ✕ on
`_userAdded` items:

- **Edit** (pencil icon) — opens the edit modal. `preventDefault()` so the link
  doesn't open.
- **Delete** (trash icon) — `confirm()` dialog, then DELETE to API, re-render.
  `preventDefault()` likewise.

Both are `type="button"` and stop propagation/click navigation. Hover reveals them
via CSS (opacity + focus-reveal for keyboard users). Cards keep `cursor-pointer`
and still open the service link when the body is clicked.

### Edit modal

A lightweight modal (no new libraries — same pattern as the existing add form):

- Fields: **Name**, **URL**, **Description**, **Icon picker**, **Category**.
- Icon picker: grid of `ICONS` keys, each rendered via `svgFor(key)`, current icon
  highlighted; click selects.
- Category: a small select — `auto` (default) or any of the known categories
  (Monitoring, Security, Network, Media, Productivity, Files, Dev, Communication,
  Home, Finance, AI, Search, Database, Other). Saves as `categoryOverride`.
- Save → `PUT /api/services/<id>` → re-render from response. Cancel closes without
  saving. Esc closes; click outside closes.

### Add form

The existing "+ Add" form posts to `POST /api/services` instead of
`saveExtraServices`. Same auto-categorize + `pickIcon` logic.

### State

`SERVICES` variable and `categorized()`/`renderGroups()`/`filter()` stay as-is,
just fed from the server list. `_userAdded` flag and `remove()`/`saveExtraServices()`
localStorage helpers are removed. `window.__HUB__` test hooks are updated
(`setServices` keeps working for test fixtures; `reloadServices` becomes async
fetch-based or accepts an injected list).

## settings.html

The "Your links" editor is repointed to the same API:

- List loads via `GET /api/services`.
- Edit (name/url/desc), delete, and add all call the API and re-render from the
  response.
- Visual style unchanged. The helper text is updated to say links are stored
  server-side (permanent), not in the browser.

## Error handling

- API non-2xx responses show a toast / inline message; state is not corrupted
  (the client keeps the last good list until the next successful fetch).
- Failed writes keep the modal open so the user can retry.
- Server validation errors render the returned message.

## Testing

### test_server.py additions

- GET /api/services requires auth (401 without session, 200 with).
- POST adds a service and returns it in the list; validation failures (missing
  name/url, bad url, oversized body) return 400.
- PUT updates fields (including rename — id stays stable), unknown id → 404.
- DELETE removes; unknown id → 404.
- CRUD round-trips persist across a server restart (file reload) with a temp
  `services.json` path.
- Atomic write leaves no `*.tmp` residue and the file remains valid JSON under
  concurrent-ish edits (basic check).
- `services.json` does not exist initially → GET returns `{ "services": [] }`.

### tests.html additions

- DOM tests stub `window.fetch` in the iframe to serve a canned `/api/services`
  payload; verify cards render.
- Edit/delete buttons present on every card.
- Clicking edit opens the modal; modal fields prefill; icon grid renders.
- Delete calls the API (fetch stub asserts the DELETE call) and re-renders.
- Fixture-based rendering/search/dot tests keep passing (fixtures injected via
  `__HUB__.setServices`).

## Files touched

- `server.py` — CRUD endpoints, services store, validation.
- `index.html` — remove SERVICES_DEFAULT, async load, hover actions, edit modal,
  add form → API, migration.
- `settings.html` — services editor → API.
- `test_server.py` — CRUD tests.
- `tests.html` — API-stubbed DOM tests.
- `README.md` — document the new permanent storage + API.
- `SETUP-LXC.md` — note `services.json` location, backup/update caveats.

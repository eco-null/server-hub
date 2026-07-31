# Server Hub

A single-file homepage for all your self-hosted apps and services. Drop it on a VPS or LXC container and get a glassmorphism dashboard with auto-categorization, search, status pings, live clock, system stats, dark/light theme, and personal-link management — all from one static HTML page, served by a stdlib-only Python server behind a styled login page. No build step. No `node_modules`. No third-party packages.

![Server Hub](https://img.shields.io/badge/stack-HTML%20%2B%20Tailwind-5E6AD2) ![Files](https://img.shields.io/badge/files-7-22C55E) ![Tests](https://img.shields.io/badge/tests-49%20passing-22C55E)

## Files

| File | Purpose |
|------|---------|
| `index.html`        | Dashboard — service grid with search, status pings, clock, stats, FAB add + settings |
| `categorize.js`     | Auto-categorization heuristic (keyword rules → category) |
| `settings.js`       | Shared settings layer (localStorage with opaque-origin fallback) |
| `settings.html`     | Settings page — theme, accent, name, features, links editor |
| `tests.html`        | 49-assertion test suite — categorizer, settings, DOM integration |
| `server.py`         | Auth + static server + `/api/stats` + `/api/me` (stdlib only) |
| `login.html`        | Styled login page, served by `server.py` |

Open `tests.html` in a browser; you should see the green `ALL GREEN` line.

## Features

- **Glassmorphism dark / light theme** — three-state (auto / light / dark), cookie-free via `prefers-color-scheme` + `localStorage`.
- **Auto-categorizing** — services land in the right group automatically by keyword rules (`categorize.js`). Edit rules inline; no API key, no LLM.
- **Search/filter** — type `/`, filter by name or description; empty groups hide.
- **Status pings** — best-effort `no-cors` fetch per service (green up / red down / amber checking); set `ping:false` for local-only apps.
- **System stats widget** — polls `GET /api/stats` for `{ host, cpu, mem, disk }` 0–100; bars auto-color at thresholds.
- **Clock + greeting** — live time + dynamic "Good morning, <name>".
- **Personalize** — your name, page title, subtitle, accent color (presets + custom), per-feature toggles (clock / greeting / stats / search / status / ambient blobs).
- **Add links** at runtime via the floating **+** button — they survive reloads via `localStorage`.
- **Floating settings** button — opens `settings.html` for full personalization.
- **Secure login** — `server.py` enforces a single-user login (`HUB_USER` / `HUB_PASSWORD`) with an `HttpOnly` session cookie and a 5-attempt per-IP lockout; `/api/stats` and `/api/me` return `401` until you sign in.

## Host it (TL;DR)

1. Set `HUB_PASSWORD` (and optionally `HUB_USER`, `HUB_PORT`, `HUB_HOST`).
2. Run `python3 server.py`.
3. Visit `http://<host>:8642` — sign in at `/login`, dashboard after.

## Quick start (local)

```bash
HUB_PASSWORD=change-me python3 server.py
# visit http://localhost:8642
```

## Quick start (public, with secure login)

[`SETUP-LXC.md`](SETUP-LXC.md) is the full Proxmox LXC walkthrough: a ≤5 minute path from "fresh Proxmox node" to a login-protected dashboard served from a ~30 MB RAM container — a systemd unit runs `server.py` on port 8642, and TLS can be added later via a Cloudflare Tunnel from the Zero Trust panel (no nginx required).

---

## Documentation

### SETUP-LXC.md — Proxmox LXC deployment

A single Debian 12 LXC running `server.py`: 4 GB disk, 512 MB RAM (idle ~30 MB). Step-by-step from `Create CT` to `systemctl enable --now server-hub`, including the systemd unit with `HUB_PASSWORD`, how to make it reachable (router port-forward, or a Cloudflare Tunnel from the Zero Trust panel), security notes, an update checklist, and a troubleshooting table.

## Customizing

- **Default services** — edit the `SERVICES_DEFAULT` array near the top of `index.html`. Each entry: `{ name, url, desc, icon, ping }`. Icons are inline SVGs in the `ICONS` map just below.
- **Auto-categorize rules** — edit `KEYWORD_RULES` in `categorize.js`. Add keywords to an existing category or add a new category. Order in `RANK` controls match precedence.
- **Theme / accent / features / personal links** — open `settings.html` and tweak. Settings persist per-browser via `localStorage`.

## How the pieces fit

```
┌───────────────────────────────────────────────────────────┐
│ Browser  (your laptop / phone)                            │
│  index.html  ──►  categorize.js  (assigns category)        │
│             └─►  settings.js    (localStorage + pub/sub)  │
│                                                           │
│  settings.html  ──►  same settings.js  (live sync)        │
│  tests.html     ──►  loads index in an iframe, asserts    │
└───────────────────────────────────────────────────────────┘
              │ fetch (no-cors status pings, /api/stats, /api/me)
              │ login POST → session cookie
              ▼
┌───────────────────────────────────┐
│ Origin (server.py on :8642)        │
│  static files + styled login page  │
│  /login      (serve login.html)    │
│  /api/stats  (JSON, requires login)│
│  /api/me     (JSON, requires login)│
└───────────────────────────────────┘
```

## Tests

Open `tests.html` in any browser. It runs 49 assertions in three groups:

1. `categorize.js` — 31 keyword heuristic cases (known services → expected categories, fallback to `Other`, URL-host and URL-path matching, specificity overrides).
2. `settings.js` — 18 storage-layer assertions (defaults, partial merges, nested feature merges, subscribe/unsubscribe, hexToRgba, isDark).
3. `index.html` — DOM integration via iframe (cards rendered, search narrows + restores, theme flips `html.light`/`html.dark`, passthrough auto-categorize, setServices re-renders, status dots present).

A green `ALL GREEN` summary at the top means everything passed.

## Known limits

- Adding a service via the **+** button saves to your browser's `localStorage` — so additions are per-device. To make a link permanent for everyone, add it to `SERVICES_DEFAULT` in `index.html`.
- `file://` preview doesn't preserve settings (browsers block `localStorage` on opaque origins). Use an http(s) origin — even `python -m http.server` does the job.
- System stats come from `server.py`'s `/api/stats` (reads `/proc`), so they work on Linux hosts and return `null` elsewhere (bars show `—`). They're only served to signed-in sessions.
- Auth is single-user — one `HUB_USER` / `HUB_PASSWORD` pair for everyone who signs in.
- Sessions are held in memory; restarting `server.py` signs everyone out.

## License

MIT — see [`LICENSE`](LICENSE)

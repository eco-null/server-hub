<p align="center">
  <img src="https://img.shields.io/badge/python-%3E%3D3.8-5E6AD2?logo=python&logoColor=white" alt="Python >=3.8">
  <img src="https://img.shields.io/badge/dependencies-0-22C55E" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/tests-124%20client%20%2B%2038%20server-22C55E" alt="Tests: 162 passing">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/stack-HTML%20%2B%20Tailwind-5E6AD2" alt="Stack: HTML + Tailwind">
</p>

# Server Hub

> A self-hosted launchpad for your apps and services. One page, zero build step, zero dependencies.

Server Hub is a single-file dashboard that turns a list of links into a polished glassmorphism homepage — auto-categorized, searchable, pingable, and personalized. A stdlib-only Python server serves it behind a styled login page, so it runs anywhere Python 3 does, in a container as small as ~30 MB RAM.

No bundler. No `node_modules`. No framework lock-in. Just static files you can open in a browser.

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Beszel Multi-Server Stats](#beszel-multi-server-stats)
- [API](#api)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security](#security)
- [Known Limits](#known-limits)
- [License](#license)

---

## Features

| | |
|---|---|
| **Compact two-column layout** | Greeting, search, and clock on the left; a fixed sidebar holds System stats and Bookmarks — the page fits on screen without scrolling. |
| **Glassmorphism UI** | Dark / light / auto theme, accent colors, ambient background blobs. Cookie-free — honors `prefers-color-scheme`. |
| **Wallpaper & dynamic theming** | None, a bundled gradient, or a custom image URL. Readability adapts automatically: the dashboard samples the wallpaper's brightness and switches to light/dark glass so text stays legible over any background. |
| **Bookmarks** | A dedicated sidebar section for favorite links (YouTube, GitHub, …). Server-persisted, editable from the dashboard or settings. |
| **Beszel multi-server stats** | Point Server Hub at a [Beszel](https://github.com/henrygd/beszel) hub to watch CPU / memory / disk across **all your servers at once**, each with status + uptime. Falls back to single-host stats when Beszel isn't configured. |
| **Auto-categorization** | Services are grouped automatically by keyword rules (`categorize.js`). No API key, no LLM — instant and offline. |
| **Search & filter** | Press `/` to focus search; filter by name or description; empty groups collapse. |
| **Status pings** | Best-effort `no-cors` health checks per service (up / down / checking). Disable per link for local-only apps. |
| **System stats** | CPU / memory / disk bars, auto-colored at thresholds. |
| **Live clock & greeting** | Real-time clock plus a "Good morning, \<name\>" greeting. |
| **Personalization** | Page title, subtitle, accent color (presets + custom), wallpaper, per-feature toggles — all persisted in `localStorage`. |
| **Server-persisted links** | Add, edit, and delete links from the dashboard or the settings page. Stored in `services.json` and shared across every device. |
| **Secure login** | `HttpOnly` session cookie, per-IP brute-force lockout, signed-in user chip. |

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/eco-null/server-hub.git
cd server-hub

# 2. Run (HUB_PASSWORD is required — the server refuses to start without it)
HUB_PASSWORD=change-me python3 server.py
```

Open <http://localhost:8642> — sign in at `/login`, land on the dashboard.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `HUB_USER` | `admin` | Sign-in username. |
| `HUB_PASSWORD` | *(required)* | Sign-in password. Server exits if unset/empty. |
| `HUB_PORT` | `8642` | Port to listen on. |
| `HUB_HOST` | `0.0.0.0` | Bind address (`0.0.0.0` for containers/tunnels, `127.0.0.1` for local-only). |
| `BESZEL_URL` | *(empty)* | Beszel hub URL (e.g. `http://beszel:9520`). Leave empty to disable multi-server stats. |
| `BESZEL_USER` | *(empty)* | Beszel account used to fetch system stats. |
| `BESZEL_PASSWORD` | *(empty)* | Beszel account password. |

> Generate a strong password: `openssl rand -base64 24`

---

## Beszel Multi-Server Stats

Set `BESZEL_URL`, `BESZEL_USER`, and `BESZEL_PASSWORD` to watch every server registered in your [Beszel](https://github.com/henrygd/beszel) hub. Server Hub authenticates with Beszel's PocketBase API and lists each system with CPU / memory / disk bars, status, and uptime in the sidebar — refreshed every 15 s.

**Requirements:**
- The Beszel account must be a **member** of the systems you want to see (Beszel's read rule is per-user). Add your account to each system in the Beszel UI, or enable `SHARE_ALL_SYSTEMS` on the hub.
- The Beszel URL is used as-is; a trailing slash is fine (`https://bs.example.com` or `https://bs.example.com/`).

When unconfigured (or if Beszel is unreachable), the dashboard automatically falls back to the single-host `/api/stats` widget.

---

## API

All endpoints are JSON and require an active session cookie (except `POST /login`).

| Method | Path | Description |
|---|---|---|
| `POST` | `/login` | Sign in with `HUB_USER` / `HUB_PASSWORD`. Sets a 30-day `HttpOnly` session cookie. |
| `GET` | `/api/services` | List all services. |
| `POST` | `/api/services` | Create a service. |
| `PUT` | `/api/services/<id>` | Update a service. |
| `DELETE` | `/api/services/<id>` | Delete a service. |
| `GET` | `/api/bookmarks` | List all bookmarks. |
| `POST` | `/api/bookmarks` | Create a bookmark. |
| `PUT` | `/api/bookmarks/<id>` | Update a bookmark. |
| `DELETE` | `/api/bookmarks/<id>` | Delete a bookmark. |
| `GET` | `/api/beszel` | Multi-server stats: `{ enabled, systems: [{ name, status, host, uptime, cpu, mem, disk }] }` (Beszel proxy). |
| `GET` | `/api/stats` | Single-host system stats: `{ host, cpu, mem, disk }` (Linux `/proc`, signed-in only). |
| `GET` | `/api/me` | Current session info (drives the signed-in user chip). |

Service object: `{ id, name, url, desc, icon, ping, categoryOverride }`. Bookmark object: `{ id, name, url, icon }`. Request bodies are capped at 64 KB.

---

## Project Structure

| File | Purpose |
|---|---|
| `index.html` | Dashboard — two-column layout, service grid, search, pings, clock, stats, bookmarks, wallpaper, add/edit/delete. |
| `settings.html` | Settings page — theme, accent, wallpaper, features, links + bookmarks editors, Beszel status. |
| `login.html` | Styled login page. |
| `categorize.js` | Auto-categorization keyword rules + matcher. |
| `settings.js` | Shared settings layer (`localStorage` with opaque-origin fallback) — theme, accent, wallpaper, features. |
| `server.py` | Auth + static server + services/bookmarks CRUD + stats + Beszel proxy (Python stdlib only). |
| `test_server.py` | 38-test server suite (`unittest`) — auth, services, bookmarks, Beszel, lockout. |
| `tests.html` | 124-assertion browser suite — categorizer, settings, wallpaper, DOM integration. |
| `SETUP-LXC.md` | Full Proxmox LXC deployment walkthrough (systemd + tunnel). |
| `SETUP.md` | Cloudflare Access guide for public domains. |

---

## Testing

Server suite (Python 3, no dependencies):

```bash
python3 -m unittest test_server
```

Browser suite — open `tests.html` in any browser (served over HTTP, not `file://`):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/tests.html
```

A green `ALL GREEN` summary means everything passed: 38 server + 124 client assertions.

---

## Deployment

- **[`SETUP-LXC.md`](SETUP-LXC.md)** — Deploy on a Proxmox LXC container in ~5 minutes: Debian 12, systemd unit, ~30 MB RAM idle, reachable via router port-forward or a Cloudflare Tunnel.
- **[`SETUP.md`](SETUP.md)** — Put Cloudflare Access in front for edge-level SSO on a public domain.
- **Docker / CasaOS** — see [server-hub-docker](https://github.com/eco-null/server-hub-docker) for a prebuilt image (`ghcr.io/eco-null/server-hub:latest`) and a CasaOS-ready `docker-compose.yml`.

---

## Security

- Password never ships in the repo — read from `HUB_PASSWORD` at startup.
- `HttpOnly` session cookies (30-day TTL), per-IP lockout after 5 failed attempts (60 s).
- Request body size caps (64 KB) on login and API routes.
- Only `/login` is public; everything else returns `401` until signed in.
- Single-user by design — one credential pair for everyone who signs in.
- Beszel credentials are read from server-side env vars only — never exposed to the browser.

---

## Known Limits

- Links live in `services.json` on the server, not the browser — the server must be running to add/edit/delete.
- Sessions are held in memory; restarting `server.py` signs everyone out.
- Single-host stats read `/proc`, so they're Linux-only (bars render as `—` elsewhere). Beszel multi-server stats work on any host since they come from Beszel.
- Beszel custom-image wallpapers are kept (with a dark theme default) when the image host lacks CORS headers, since the brightness can't be sampled.
- `file://` preview can't persist settings (browsers block `localStorage` on opaque origins). Use any HTTP origin.

---

## License

[MIT](LICENSE)

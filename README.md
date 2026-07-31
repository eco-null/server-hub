<p align="center">
  <img src="https://img.shields.io/badge/python-%3E%3D3.8-5E6AD2?logo=python&logoColor=white" alt="Python >=3.8">
  <img src="https://img.shields.io/badge/dependencies-0-22C55E" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/tests-85%20client%20%2B%2028%20server-22C55E" alt="Tests: 113 passing">
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
| **Glassmorphism UI** | Dark / light / auto theme, three accent modes, ambient background blobs. Cookie-free — honors `prefers-color-scheme`. |
| **Auto-categorization** | Services are grouped automatically by keyword rules (`categorize.js`). No API key, no LLM — instant and offline. |
| **Search & filter** | Press `/` to focus search; filter by name or description; empty groups collapse. |
| **Status pings** | Best-effort `no-cors` health checks per service (up / down / checking). Disable per link for local-only apps. |
| **System stats** | CPU / memory / disk bars from `GET /api/stats`, auto-colored at thresholds. |
| **Live clock & greeting** | Real-time clock plus a "Good morning, \<name\>" greeting. |
| **Personalization** | Page title, subtitle, accent color (presets + custom), per-feature toggles — all persisted in `localStorage`. |
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

| Variable | Default | Description |
|---|---|---|
| `HUB_USER` | `admin` | Sign-in username. |
| `HUB_PASSWORD` | *(required)* | Sign-in password. Server exits if unset/empty. |
| `HUB_PORT` | `8642` | Port to listen on. |
| `HUB_HOST` | `0.0.0.0` | Bind address (`0.0.0.0` for containers/tunnels, `127.0.0.1` for local-only). |

> Generate a strong password: `openssl rand -base64 24`

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
| `GET` | `/api/stats` | System stats: `{ host, cpu, mem, disk }` (Linux `/proc`, signed-in only). |
| `GET` | `/api/me` | Current session info (drives the signed-in user chip). |

Service object: `{ id, name, url, desc, icon, ping, categoryOverride }`. Request bodies are capped at 64 KB.

---

## Project Structure

| File | Purpose |
|---|---|
| `index.html` | Dashboard — service grid, search, pings, clock, stats, add/edit/delete. |
| `settings.html` | Settings page — theme, accent, features, links editor. |
| `login.html` | Styled login page. |
| `categorize.js` | Auto-categorization keyword rules + matcher. |
| `settings.js` | Shared settings layer (`localStorage` with opaque-origin fallback). |
| `server.py` | Auth + static server + services CRUD + stats (Python stdlib only). |
| `test_server.py` | 28-assertion server test suite (`unittest`). |
| `tests.html` | 85-assertion browser suite — categorizer, settings, DOM integration. |
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

A green `ALL GREEN` summary means everything passed: 28 server + 85 client assertions.

---

## Deployment

- **[`SETUP-LXC.md`](SETUP-LXC.md)** — Deploy on a Proxmox LXC container in ~5 minutes: Debian 12, systemd unit, ~30 MB RAM idle, reachable via router port-forward or a Cloudflare Tunnel.
- **[`SETUP.md`](SETUP.md)** — Put Cloudflare Access in front for edge-level SSO on a public domain.

Both are optional — the server is entirely self-contained and works out of the box.

---

## Security

- Password never ships in the repo — read from `HUB_PASSWORD` at startup.
- `HttpOnly` session cookies (30-day TTL), per-IP lockout after 5 failed attempts (60 s).
- Request body size caps (64 KB) on login and API routes.
- Only `/login` is public; everything else returns `401` until signed in.
- Single-user by design — one credential pair for everyone who signs in.

---

## Known Limits

- Links live in `services.json` on the server, not the browser — the server must be running to add/edit/delete.
- Sessions are held in memory; restarting `server.py` signs everyone out.
- System stats read `/proc`, so they're Linux-only (bars render as `—` elsewhere).
- `file://` preview can't persist settings (browsers block `localStorage` on opaque origins). Use any HTTP origin.

---

## License

[MIT](LICENSE)

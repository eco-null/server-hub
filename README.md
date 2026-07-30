# Server Hub

A single-file homepage for all your self-hosted apps and services. Drop it on a VPS or LXC container behind a Cloudflare Tunnel and get a glassmorphism dashboard with auto-categorization, search, status pings, live clock, system stats, dark/light theme, and personal-link management — all from one static HTML page. No build step. No `node_modules`. No backend (unless you want stats).

![Server Hub](https://img.shields.io/badge/stack-HTML%20%2B%20Tailwind-5E6AD2) ![Files](https://img.shields.io/badge/files-5-22C55E) ![Tests](https://img.shields.io/badge/tests-49%20passing-22C55E)

## Files

| File | Purpose |
|------|---------|
| `index.html`        | Dashboard — service grid with search, status pings, clock, stats, FAB add + settings |
| `categorize.js`     | Auto-categorization heuristic (keyword rules → category) |
| `settings.js`       | Shared settings layer (localStorage with opaque-origin fallback) |
| `settings.html`     | Settings page — theme, accent, name, features, links editor |
| `tests.html`        | 49-assertion test suite — categorizer, settings, DOM integration |

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
- **Secure login for public domains** — pair with Cloudflare Access (see below); the HTML stays static, auth happens at the edge.

## Host it (TL;DR)

1. Serve `index.html` + the four siblings from any web root (nginx, Caddy, Python `http.server`).
2. Put it behind a Cloudflare Tunnel — zero inbound ports on your firewall.
3. Add a Cloudflare Access policy permitting only your email.

Done. Your dashboard is reachable from anywhere, SSO-protected, with no static password to brute-force.

## Quick start (local)

```bash
# from this folder
python -m http.server 8080
# visit http://localhost:8080
```

## Quick start (public, with secure login)

Two longer docs ship inside this repo:

- [`SETUP.md`](SETUP.md) — Cloudflare Access configuration steps (SSO with Google / GitHub / one-time PIN, identity provider wiring, the optionally-exposed signed-in email chip).
- [`SETUP-LXC.md`](SETUP-LXC.md) — full Proxmox LXC + cloudflared walkthrough: a ≤10 minute path from "fresh Proxmox node" to "SSO-protected `hub.example.com` served from a 30 MB RAM container". Includes nginx config (bind to `127.0.0.1` so it's only reachable via the tunnel), systemd service install, troubleshooting table, and optional hardening.

---

## Documentation

### SETUP.md — Cloudflare Access (secure login)

Wires [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/) in front of Server Hub so every request to your domain is verified against your email at Cloudflare's edge before reaching your origin. The static `index.html` itself contains no password — nothing to forge, nothing to offline-brute-force.

### SETUP-LXC.md — Proxmox LXC deployment

A single Debian 12 LXC running nginx + `cloudflared`: 4 GB disk, 512 MB RAM (idle ~30 MB), no public inbound port. Step-by-step from `Create CT` to `systemctl enable --now cloudflared`, including the nginx config block that binds to `127.0.0.1:80`, the cloudflared `config.yml` ingress entry, the Access application policy, and a troubleshooting table for the common failure modes (`502`, `404`, login loops, lost settings).

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
              ▼
┌───────────────────────────────────┐
│ Origin (nginx on 127.0.0.1:80)     │
│  index.html  categorize.js ...      │
│  /api/me    (CF Access header)      │
│  /api/stats (your optional shim)    │
└───────────────────────────────────┘
              ▲ cloudflared tunnel
              │
┌─────────────────────────────────────────┐
│ Cloudflare Edge                         │
│  TLS termination  +  Access SSO gate    │
│  https://hub.example.com                │
└─────────────────────────────────────────┘
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
- System stats stay at `—` until you wire `/api/stats` (see §6 of `SETUP-LXC.md` for a 10-line `/proc`-reading shim).

## License

MIT — see [`LICENSE`](LICENSE) (or add one if you prefer another).

## Acknowledgements

UI patterns distilled from the [ui-ux-pro-max](https://github.com/anomalyco/ui-ux-pro-max) skill — glassmorphism, ambient blobs, dark-mode-first color scales, and the 150–300 ms micro-interaction rule.
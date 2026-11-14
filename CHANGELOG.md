# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Live demo: a static build of the real web interface with an in-browser mock of the HTTP API, published to GitHub Pages from `demo/` by `.github/workflows/pages.yml`. Data stays in the visitor's browser. See [demo/README.md](demo/README.md) for what is simulated.
- Favicon set (`favicon.ico`, 32 px PNG, Apple touch icon) and a `theme-color` that follows the chosen theme.
- Open dashboards refresh when the same browser changes data in another tab (for example in the settings page).
- `CONTRIBUTING.md`, issue forms and a pull request template.
- Git ignores `compose.override.yaml`, `certs/`, `*.pem` and `*.key`.

### Changed

- Dashboard layout: Settings is a chip in the header and "Add service" is a button next to the search field, replacing the floating buttons. The sign-out button reads "Sign out", and the greeting no longer repeats the date, which the clock shows. Groups and cards are laid out in balanced columns, and long names show their full text as a tooltip.
- Search ranking is stricter: every query word must match, matches in the name rank above host and description, and only the service-specific part of a host is matched (not a shared suffix such as `home.arpa`). There is no fuzzy matching, and categories match only by prefix from four letters.
- Image wallpapers get a veil in the theme's color so text stays readable on any photo.
- Settings wording: "Links" is now "Services", American spelling ("color"), and "Add Beszel hub" is a primary button.
- Sign-in and password forms work better with password managers and mobile keyboards.
- TLS with Docker is enabled through a Git-ignored `compose.override.yaml` that mounts `./certs` and sets the two `SERVERHUB_TLS_*_FILE` variables, instead of uncommenting a volume in `compose.yaml`. `compose.yaml` documents this and works unchanged without an override. Complete example in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#tls).
- `requirements.lock` and `requirements-dev.lock` were regenerated with a documented, reproducible procedure ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#updating-dependencies)); `colorama` is now a declared dev dependency so the dev lock records it for Windows.

### Fixed

- Documentation: the configuration table in the README now matches `.env.example` and `serverhub/config.py` (including the fixed container values for the data directory, host and port, and fractional session days). The `SERVERHUB_LOG_LEVEL` note is now exact: `warning` is the quietest level that still prints the setup token and the configuration warnings, while `error` and `critical` hide them.
- Documentation: the README no longer tells readers to uncomment a volume in `compose.yaml` for TLS, and its screenshots and captions match the current interface.
- `.env.example` documents `SERVERHUB_WEB_DIR` and the secret-key generation commands.

## [2.0.0] - 2026-11-14

Server Hub was rebuilt from scratch. This is a breaking release: **data from the previous version (Supabase tables and single-user configuration) is not migrated, and there is no import path for it.** A new installation starts with an empty SQLite database; recreate your services and bookmarks by hand. The environment variables of the old version (`HUB_*`, `SUPABASE_*`, `SESSION_SECRET`, `BESZEL_*`) are not read any more.

### Added

- Self-contained backend built on Starlette and uvicorn with a SQLite database (WAL mode) and numbered SQL migrations that run automatically at start.
- First-party accounts: Argon2id password hashing, server-side sessions in `HttpOnly` cookies, roles `admin` and `user`, and optional TOTP two-factor authentication with ten single-use recovery codes.
- First-run setup: registration is closed by default, the first account is the admin, and creating it requires a setup token that the server prints in its log (or `SERVERHUB_SETUP_TOKEN`). Admins create users, open or close registration, change roles, reset passwords and clear 2FA in the settings page.
- Command line interface: `serve`, `create-admin`, `reset-password` (with `--disable-2fa`), `backup` (consistent SQLite copy) and `healthcheck`.
- Docker Compose deployment as a single hardened container: non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges`, process limit, health check on `/healthz`. The image is built locally with `docker compose up -d --build`.
- Built-in HTTPS: set `SERVERHUB_TLS_CERT_FILE` and `SERVERHUB_TLS_KEY_FILE`. No reverse proxy is part of the stack. Support for tunnels and external proxies through `SERVERHUB_PUBLIC_URL`, `SERVERHUB_TRUSTED_PROXIES` and `SERVERHUB_ALLOWED_HOSTS`.
- Configuration through validated `SERVERHUB_*` environment variables; invalid values stop the server with a message that names the variable. Start-up warnings for plain HTTP and for Secure cookies over HTTP.
- Server-side status checks (`up`, `down`, `unknown`) with a cache, a sweep deadline and concurrency limits; HTTP status and latency are shown to admins.
- Beszel integration with multiple instances per user, passwords stored encrypted and never returned by the API.
- Host statistics for admins (CPU, memory, disk from `/proc`).
- Dashboard: services with icons and automatic or manual categories, bookmarks, search (Google, DuckDuckGo, Bing, Startpage, SearXNG), clock and greeting, dark, light and automatic themes, accent color and wallpapers, per-user JSON export and import.
- Frontend with no build step: plain ES modules, a bundled icon sprite and bundled Inter and Fira Code fonts.
- Documentation: HTTP API reference, deployment guide, development guide, security policy and this changelog.
- Test suites: pytest for the backend and `node --test` for the frontend.
- GitHub Actions workflow that lints, runs both test suites on Python 3.12 and 3.14, and builds and smoke-tests the Docker image.
- Hashed dependency lock files (`requirements.lock`, `requirements-dev.lock`).

### Changed

- Storage moved from Supabase (and the standalone single-user mode) to a local SQLite database in a Docker volume.
- Authentication moved from Supabase Auth and the `HUB_USER` / `HUB_PASSWORD` login to the built-in accounts described above.
- Runtime moved from a Python standard-library server (Python 3.8 or newer) to the Starlette application; Python 3.12 or newer is required outside Docker.
- The frontend moved from large single-file pages to ES modules under `web/static/`, and the logo to `web/static/img/logo.png`.
- Beszel connections are now configured per user in the settings page instead of with `BESZEL_*` environment variables.
- Deployment documentation now describes Docker Compose only.
- The canonical repository is `https://github.com/eco-null/server-hub`.

### Removed

- Supabase integration and `supabase-schema.sql`.
- Single-user standalone mode and its variables (`HUB_USER`, `HUB_PASSWORD`, `HUB_HOST`, `HUB_PORT`, `HUB_DISK_PATH`, `SESSION_SECRET`).
- Vercel deployment (`vercel.json`, `api/index.py`) and the Vercel Web Analytics integration.
- The old setup guides (`SETUP.md`, the Proxmox LXC guide `SETUP-LXC.md`) and the in-browser test page (`tests.html`).
- The separate `register.html` page; sign-up is part of the login page and only works while an admin has opened registration.

### Security

- Strict Content Security Policy (same-origin scripts, styles, fonts and connections), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and cross-origin isolation headers; `Strict-Transport-Security` over HTTPS.
- CSRF protection on every state-changing request (`Origin`, `Sec-Fetch-Site`, or a custom header for cookie-bearing non-browser requests), JSON-only API bodies and body-size limits.
- Host header allowlist against DNS rebinding.
- Persistent rate limiting for sign-in, 2FA, setup-token and registration attempts. Attempts are counted before they are checked; account-wide limits slow attackers down but never lock the owner out from other addresses.
- Outbound requests for status checks and Beszel go through one hardened client: no redirects, DNS resolved once and the validated address used, loopback, link-local, metadata, multicast and reserved ranges always blocked, private ranges controlled by `SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS`, size, time and concurrency limits.
- Slow-client protection: request-head and request-body deadlines, and global and per-address connection caps.
- 2FA secrets and stored Beszel passwords are encrypted with keys derived from `SERVERHUB_SECRET_KEY`; recovery codes, session tokens and passwords are stored only as hashes.
- Stricter URL and Beszel URL validation; dependency installs verified against sha256 hashes.

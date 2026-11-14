# Development guide

How to run, test and change Server Hub. The HTTP contract is in [API.md](API.md); operating the app is in [DEPLOYMENT.md](DEPLOYMENT.md).

## Local setup

You need Python 3.12 or newer (the Docker image uses 3.14; CI runs both) and, for the frontend tests, Node.js. Dependencies are installed from hashed lock files, so every file is verified against a sha256 hash.

```bash
git clone https://github.com/eco-null/server-hub.git
cd server-hub
python -m venv .venv
. .venv/bin/activate          # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install --require-hashes --no-deps -r requirements-dev.lock
```

`requirements-dev.lock` includes `requirements.lock` plus pytest and ruff. For runtime dependencies only, use `requirements.lock`. The package is run from the repository root; no editable install is needed.

## Running the server

The secret key is required. Listen on loopback so the plain-HTTP warning does not appear:

```bash
export SERVERHUB_SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
export SERVERHUB_HOST=127.0.0.1
python -m serverhub
```

The database is created in `./data` (ignored by Git). While no account exists, the log prints the setup token. Open `http://127.0.0.1:8642`. The frontend is served from `web/` and read from disk on each request, so edit a file and reload the browser; no build or restart is needed for frontend changes. Backend changes need a restart. `SERVERHUB_LOG_LEVEL=debug` adds access logs.

Run `python -m serverhub --help` for the commands: `serve` (default), `create-admin`, `reset-password`, `backup` and `healthcheck`.

## Tests

Backend (pytest; configuration in `pyproject.toml`):

```bash
python -m pytest
```

The tests build the application in-process, use cheap password hashing parameters and a stub resolver, and need no network or Docker. Fixtures are in `tests/conftest.py`. Security-relevant tests: `tests/test_security.py` (CSRF, headers, CSP), `tests/test_hardening.py` and `tests/test_server.py` (rate limits, Host check, connection gate), `tests/test_fetcher.py` (outbound address policy).

Frontend (Node's built-in test runner, no dependencies to install):

```bash
cd web
npm test
```

This runs `node --test "tests/*.test.mjs"` against the pure modules in `web/static/js/` (stores, URL handling, categorisation, API client).

## Lint and format

```bash
ruff check .
ruff format --check .
ruff format .          # apply formatting
```

Ruff is configured in `pyproject.toml` (line length 100, rule sets `E F W I B UP S ASYNC RUF SIM PTH`; `web` and `docs` are excluded). CI runs both commands, the backend tests on Python 3.12 and 3.14, the frontend tests, and a Docker job that builds the image, starts it and runs a smoke test against `/healthz` and the auth endpoints. The workflow is `.github/workflows/ci.yml`.

## Project layout

```
serverhub/
  __main__.py          python -m serverhub entry point
  cli.py               Sub-commands (serve, create-admin, reset-password, backup, healthcheck)
  config.py            Config class: SERVERHUB_* variables, validation, derived values
  main.py              create_app() (lifespan, routes, error handlers), startup warnings, run()
  middleware.py        SecurityMiddleware: Host allowlist, CSRF, body limits, security headers, CSP
  server.py            uvicorn protocol subclass: head/body deadlines, connection gate
  http.py              Client address resolution, JSON parsing helpers, rate-limit identity
  hub.py               Container for application services (db, keys, limiter, fetcher, ...)
  errors.py            ApiError and its helpers
  web.py               Page routes, /static, /healthz
  api/                 auth.py, data.py (settings, services, bookmarks, status, backup),
                       beszel.py, admin.py; schemas.py holds request models and limits
  auth/                crypto.py (HKDF keys, Fernet, Argon2id), sessions.py, totp.py, ratelimit.py
  db/                  __init__.py (connection, migrations, backup), repo.py (queries), migrations/
  integrations/        fetcher.py (hardened outbound client), status.py, beszel.py
  system/stats.py      Host statistics from /proc
web/                   HTML pages (index, login, settings) and static/{css,js,fonts,img}
tests/                 Backend tests
docs/                  API.md (contract), DEPLOYMENT.md, this file, screenshots/
```

Where to look: a new endpoint goes in the matching module under `serverhub/api/`, with its request model in `schemas.py` (models forbid unknown fields and are strict), SQL in `db/repo.py`, and its description in [API.md](API.md). All SQL is parameterised and runs in a worker thread through `Database.run`. Any outbound HTTP request must use `SafeFetcher` from `integrations/fetcher.py`; never use `httpx` directly.

## Frontend

The frontend is plain HTML, CSS and ES modules served as they are. There is no bundler, transpiler, package manager or runtime dependency; `web/package.json` only marks the files as modules for `node --test`.

- Pages: `index.html` (dashboard), `login.html` (sign in, 2FA, first-run setup, sign up), `settings.html`. Each loads one module: `dashboard.js`, `login.js` or `settings.js`.
- `static/js/api.js` is the API client (it reaches `fetch` through `client.js`). It sends `X-ServerHub-Client: web` on every request and turns error bodies into `ApiError`. Add new calls there rather than calling `fetch` elsewhere.
- `store.js` is the settings store (optimistic updates, one debounced save), `state.js` a small observable container, `cache.js` the per-user first-paint cache; `features/` has the dashboard parts (services, bookmarks, search, status, stats, clock, dialogs); `settings/` has one module per settings section; `lib/` has pure helpers with unit tests; `categorize.js` is the automatic categorisation.
- `dom.js` provides `h()`, which builds elements with `createElement` and `textContent`. Build all dynamic DOM through it; do not build HTML from strings.
- Modules carry `// @ts-check` and JSDoc types.
- Theme variables are in `css/tokens.css`. `theme-boot.js` is a small blocking script in `<head>` that applies the saved theme before first paint.

### Content Security Policy rules

The server sends this policy on every response (`serverhub/middleware.py`):

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:;
font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

What follows for contributors:

- No inline `<script>` blocks, no inline event handler attributes (`onclick="..."`), no `eval` or `new Function`. Put code in a module file under `static/js/` and attach listeners with `addEventListener` (or the `on...` props of `h()`).
- No `<style>` blocks and no `style="..."` attributes in HTML or in markup strings. Set styles from JavaScript through the CSSOM (`el.style.setProperty(...)`, which `h()` does for its `style` prop) or use classes and CSS custom properties.
- No third-party scripts, styles, fonts or API calls: everything must come from the same origin (`/static/...`). Fonts are bundled as `woff2` files.
- Images may come from the same origin, `data:` URIs or any `https:` host (custom wallpaper URLs); nothing else.
- Frames are not allowed (`frame-ancestors 'none'`), and `form-action` is limited to the same origin.
- Cookies are `HttpOnly`; the frontend never sees the session token.

Run the app in a browser with the developer console open: a CSP violation shows up there as an error.

## Adding a database migration

Migrations are SQL files in `serverhub/db/migrations/`, named `NNNN_description.sql` (four digits, lowercase letters, digits and underscores). Numbers must start at `0001` and be consecutive with no gaps, or the server refuses to start. At start-up every file newer than the database's `PRAGMA user_version` runs inside one transaction and the version is set to its number.

1. Create the next file, for example `0002_add_something.sql`, containing only the changes (the existing tables use `STRICT`).
2. Update `serverhub/db/repo.py` and the API as needed.
3. Add or adjust tests; `tests/conftest.py` creates a fresh database per test.
4. Run `python -m pytest`.

Never edit a migration that has been released; add a new one. There are no down-migrations, and a database whose version is newer than the build is refused. The files are included in the package through `[tool.setuptools.package-data]` in `pyproject.toml`; the Docker image copies the whole `serverhub/` directory.

## Adding an icon or a category

Icons and categories are validated by the backend and listed in the frontend, and the lists must match.

Icon `my-icon`:

1. Add a `<symbol id="my-icon" viewBox="0 0 24 24">...</symbol>` to `web/static/img/icons.svg` (24x24 grid; copy the stroke style of the neighbouring symbols).
2. Add the id to `ICON_IDS` in `web/static/js/lib/icon-ids.js`.
3. Add the id to `KNOWN_ICONS` in `serverhub/api/schemas.py`.
4. Optionally map keywords to it in `suggestIcon` in `web/static/js/categorize.js`.

Category `Example`:

1. Add the name to `KNOWN_CATEGORIES` in `serverhub/api/schemas.py` and to `CATEGORIES` in `web/static/js/categorize.js`.
2. Add keywords under `KEYWORD_RULES` and, so it can win over others, a position in `RANK` in the same file.
3. Run `npm test` in `web/` and `python -m pytest`.

## Dependency lock files

`pyproject.toml` pins the direct dependencies exactly. `requirements.lock` pins the full transitive set with sha256 hashes for every published file, and `requirements-dev.lock` adds the test tools on top of it. The header of `requirements.lock` records that it was produced with `pip-compile --generate-hashes --strip-extras -o requirements.lock pyproject.toml` (pip-tools). The header of `requirements-dev.lock` records no generation command. When you change a pin in `pyproject.toml`, regenerate the lock files, install from them with `--require-hashes`, and run the full test suite before committing.

## Conventions

- Commit messages use Conventional Commits (`feat:`, `fix:`, `docs:`; `!` for breaking changes).
- Keep `docs/API.md` in step with any change to the HTTP contract, and add an entry to [CHANGELOG.md](../CHANGELOG.md) for user-visible changes.
- Security-sensitive changes (authentication, sessions, the outbound client, the middleware) need tests next to the existing ones in `tests/`.

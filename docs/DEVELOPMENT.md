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

`requirements-dev.lock` includes `requirements.lock` plus pytest and ruff. For runtime dependencies only, use `requirements.lock`. To change a pin, see [Updating dependencies](#updating-dependencies). The package is run from the repository root; no editable install is needed.

## Running the server

The secret key is required. Listen on loopback so the plain-HTTP warning does not appear:

```bash
export SERVERHUB_SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
export SERVERHUB_HOST=127.0.0.1
python -m serverhub
```

The database is created in `./data` (ignored by Git). While no account exists, the log prints the setup token. Open `http://127.0.0.1:8642`. The frontend is served from `web/` and read from disk on each request, so edit a file and reload the browser; no build or restart is needed for frontend changes. Backend changes need a restart. `SERVERHUB_LOG_LEVEL=debug` adds an access log line per request and verbose output from the HTTP libraries (the allowed levels are `critical`, `error`, `warning`, `info`, `debug`). `SERVERHUB_WEB_DIR` can point the server at a different frontend directory (default: `web/` next to the `serverhub/` package); it is a development setting and is left unset in Docker.

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

This runs `node --test "tests/*.test.mjs"` against the pure modules in `web/static/js/` (stores, URL handling, categorization, search ranking, layout, API client).

## Lint and format

```bash
ruff check .
ruff format --check .
ruff format .          # apply formatting
```

Ruff is configured in `pyproject.toml` (line length 100, rule sets `E F W I B UP S ASYNC RUF SIM PTH`; `web` and `docs` are excluded). CI runs both commands, the backend tests on Python 3.12 and 3.14, the frontend tests, and a Docker job that builds the image, starts it and runs a smoke test against `/healthz` and the auth endpoints. The workflow is `.github/workflows/ci.yml`. A second workflow, `.github/workflows/pages.yml`, tests and publishes the demo (see [The demo](#the-demo-github-pages)).

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
                       beszel.py, docker.py, admin.py; schemas.py holds request models and limits
  auth/                crypto.py (HKDF keys, Fernet, Argon2id), sessions.py, totp.py, ratelimit.py
  db/                  __init__.py (connection, migrations, backup), repo.py (queries), migrations/
  integrations/        fetcher.py (hardened outbound client), status.py, beszel.py, docker.py (Docker discovery)
  system/stats.py      Host statistics from /proc
web/                   HTML pages (index, login, settings) and static/{css,js,fonts,img}; tests/ holds the frontend tests
demo/                  Static GitHub Pages demo: build script, in-browser mock API, tests (see below)
tests/                 Backend tests
docs/                  API.md (contract), DEPLOYMENT.md, this file, screenshots/
.github/workflows/     ci.yml (lint, tests, Docker smoke test), pages.yml (demo)
```

Where to look: a new endpoint goes in the matching module under `serverhub/api/`, with its request model in `schemas.py` (models forbid unknown fields and are strict), SQL in `db/repo.py`, and its description in [API.md](API.md). All SQL is parameterized and runs in a worker thread through `Database.run`. Any outbound HTTP request must use `SafeFetcher` from `integrations/fetcher.py`; never use `httpx` directly.

## Docker discovery without Docker

You do not need Docker to work on discovery. The backend only ever sends `GET /containers/json?all=true` to the address in `SERVERHUB_DOCKER_HOST` (`serverhub/integrations/docker.py`; the routes are in `serverhub/api/docker.py`), so the tests replace the Docker API with the `Stub` HTTP server from `tests/conftest.py`:

- `stub.route("GET", "/containers/json", 200, [...])` answers with a list of container dicts. `tests/test_docker.py` builds them with small helpers (`container()`, `labelled()`, `tcp()`).
- `running(tmp_path, docker_host=stub.url, docker_options=FAST)` starts the app against the stub. `docker_options` goes to `DockerClient`; the tests shorten its timeouts and cache TTLs there.
- The `docker_stub` fixture listens on `127.0.0.2` instead of `127.0.0.1`: the outbound client never contacts the configured Docker endpoint on any port, so a status-check target on the same address would be refused.
- `tests/test_docker.py` covers configuration, label parsing, suggestions, the client (single refresh in flight, error and size limits, timeouts) and the API (visibility, diagnostics, status checks, read-only cards). `tests/test_docker_review.py` holds regression tests, including checks that read `compose.yaml` for the proxy's single allow rule.

Run them with `python -m pytest tests/test_docker.py tests/test_docker_review.py`. What no test here can show is how the real proxy behaves: that is checked by the `docker` job in `.github/workflows/ci.yml`, which starts the proxy on a real Docker engine and sends it allowed and refused requests. The demo has its own port of the label parsing (`demo/src/docker.js`, tested by `demo/test/docker.test.js`); keep it in step with `serverhub/integrations/docker.py` when labels change, as with the other mock API parts. Frontend helpers are tested in `web/tests/docker.test.mjs`.

## Frontend

The frontend is plain HTML, CSS and ES modules served as they are. There is no bundler, transpiler, package manager or runtime dependency; `web/package.json` only marks the files as modules for `node --test`.

- Pages: `index.html` (dashboard), `login.html` (sign in, 2FA, first-run setup, sign up), `settings.html`. Each loads one module: `dashboard.js`, `login.js` or `settings.js`.
- `static/js/api.js` is the API client (it reaches `fetch` through `client.js`). It sends `X-ServerHub-Client: web` on every request and turns error bodies into `ApiError`. Add new calls there rather than calling `fetch` elsewhere.
- `store.js` is the settings store (optimistic updates, one debounced save), `state.js` a small observable container, `cache.js` the per-user first-paint cache; `features/` has the dashboard parts (services, bookmarks, search, status, stats, clock, dialogs); `settings/` has one module per settings section; `lib/` has pure helpers with unit tests (search ranking, column layout, cross-tab change notification); `categorize.js` is the automatic categorization.
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

## The demo (GitHub Pages)

`demo/` builds a fully static copy of the real UI from `web/` and answers the HTTP API inside the browser, so it can be hosted on GitHub Pages. `web/` is not modified; `demo/build.js` copies the pages and `web/static/`, rewrites root-absolute URLs for the chosen base path and adds a banner and the mock backend. Its data lives in the visitor's `localStorage`. The demo sign-in is shown on its login page, and [demo/README.md](../demo/README.md) lists what is simulated.

Node.js is the only requirement; there are no dependencies to install. From the repository root:

```bash
cd demo
npm test
```

```bash
node build.js --base /server-hub/ --out dist
```

`dist/` is ignored by Git. To preview it under the sub-path it is built for, serve a directory that contains it as `server-hub/`:

```bash
mkdir -p /tmp/site && cp -r dist /tmp/site/server-hub
```

```bash
python -m http.server -d /tmp/site 8080
```

Then open `http://localhost:8080/server-hub/`. In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` before the build command so the base path is not rewritten to a Windows path.

The workflow `.github/workflows/pages.yml` runs the demo tests, builds with `--base /server-hub/` and deploys to GitHub Pages on pushes to `main` that touch `web/` or `demo/`. `demo/src/validate.js` is a port of the request validation in `serverhub/api/schemas.py` and `demo/src/backend.js` mirrors the API: when you change the HTTP contract, update them together with [API.md](API.md).

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

1. Add a `<symbol id="my-icon" viewBox="0 0 24 24">...</symbol>` to `web/static/img/icons.svg` (24x24 grid; copy the stroke style of the neighboring symbols).
2. Add the id to `ICON_IDS` in `web/static/js/lib/icon-ids.js`.
3. Add the id to `KNOWN_ICONS` in `serverhub/api/schemas.py`.
4. Optionally map keywords to it in `suggestIcon` in `web/static/js/categorize.js`.

Category `Example`:

1. Add the name to `KNOWN_CATEGORIES` in `serverhub/api/schemas.py` and to `CATEGORIES` in `web/static/js/categorize.js`.
2. Add keywords under `KEYWORD_RULES` and, so it can win over others, a position in `RANK` in the same file.
3. Run `npm test` in `web/` and `python -m pytest`.

## Updating dependencies

How the files relate:

- `pyproject.toml` pins the direct dependencies exactly: `dependencies` for runtime, the `dev` extra for pytest, ruff and `colorama` (pytest's Windows-only dependency, listed so the dev lock records it with its `sys_platform == "win32"` marker).
- `requirements.lock` is the full runtime set (direct and transitive) with sha256 hashes of every published file. The Docker image installs only this file.
- `requirements-dev.lock` starts with `-r requirements.lock` and then lists only what the tools add (pytest, ruff and their dependencies). It is compiled with the runtime lock as a constraint, so packages shared by both files always have the same pin.
- Docker and CI install with `pip install --require-hashes --no-deps -r <file>`: pip refuses any file whose hash is not in the lock, and `--no-deps` stops it from resolving anything else.

Both files are produced by pip-tools. The versions used for the committed files are in their headers (pip-tools 7.6.2, pip 26.1.2, Python 3.14.6); regenerating them with this procedure reproduces the committed pins and hashes exactly. Run it from the repository root, in a POSIX shell (Git Bash on Windows), with a throwaway virtual environment that is not your development `.venv`:

```bash
python -m venv /tmp/locktools           # Windows: any directory outside the repository
/tmp/locktools/bin/python -m pip install pip-tools==7.6.2   # Windows: Scripts/ instead of bin/ (and pip-compile.exe)
PC=/tmp/locktools/bin/pip-compile
PYT=/tmp/locktools/bin/python
OPTS="--generate-hashes --strip-extras --no-annotate --no-header --quiet"
head_of() { awk '/^#/ {print; next} {exit}' "$1"; }   # a file's leading comment block

# 1. Runtime lock. Existing pins are kept; add --upgrade or --upgrade-package NAME to move them.
head_of requirements.lock > rt.hdr
$PC $OPTS --output-file requirements.lock pyproject.toml
cat rt.hdr requirements.lock > rt.tmp && mv rt.tmp requirements.lock

# 2. Dev lock: the [dev] extra on stdin, constrained to the runtime lock.
head_of requirements-dev.lock > dev.hdr
$PYT -c "import tomllib;print(*tomllib.load(open('pyproject.toml','rb'))['project']['optional-dependencies']['dev'],sep='\n')" \
  | $PC $OPTS --constraint requirements.lock --output-file requirements-dev.lock -
{ cat dev.hdr; echo "-r requirements.lock"; cat requirements-dev.lock; } > dev.tmp && mv dev.tmp requirements-dev.lock
rm -f rt.hdr dev.hdr
```

`--no-header` suppresses pip-tools' own header; the comment block at the top of each file is kept by the `head_of` steps, so update the version numbers there if you use a newer pip-tools.

Two requirements:

- Use Python 3.14 (the version the Docker image uses) for both steps.
- Run the dev step on Windows. pip-compile evaluates environment markers for the machine it runs on, so on Linux or macOS it drops the Windows-only `colorama` entry; if that happens, restore that stanza from Git.

After any change, prove the result before committing:

```bash
python -m venv /tmp/verify && /tmp/verify/bin/python -m pip install --require-hashes --no-deps -r requirements-dev.lock
/tmp/verify/bin/python -m pytest
```

and install `requirements.lock` alone into a second fresh environment the same way (`--require-hashes --no-deps`). Re-running step 1 and 2 without changing `pyproject.toml` must leave both files unchanged (`git diff --exit-code requirements*.lock`).

## Conventions

- Commit messages use Conventional Commits (`feat:`, `fix:`, `docs:`; `!` for breaking changes).
- Keep `docs/API.md` and the demo's mock API (`demo/src/`) in step with any change to the HTTP contract, and add an entry to [CHANGELOG.md](../CHANGELOG.md) for user-visible changes.
- Security-sensitive changes (authentication, sessions, the outbound client, the middleware) need tests next to the existing ones in `tests/`.

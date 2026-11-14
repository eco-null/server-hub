# Server Hub demo (GitHub Pages)

Published at <https://eco-null.github.io/server-hub/>. A fully static build of the real web UI from `web/`, with the HTTP API
(`docs/API.md`) answered inside the browser. Nothing is sent anywhere: the
visitor's changes live in `localStorage` under `serverhub-demo:v1`.

## How it works

- `build.js` copies `web/index.html`, `settings.html`, `login.html` and
  `web/static/**` into the output and rewrites root-absolute URLs so the site
  works under any base path (`/static/…`, `/api/…`, `/login` → `login.html`,
  `/settings` → `settings.html`, `/` → the base). It then fails if any app URL
  would still leave the base path. `web/` itself is not modified.
- Each page gets a strict CSP `<meta>` (the real policy minus `frame-ancestors`,
  which a meta tag cannot carry, and with `img-src` limited to the site), the
  demo banner, and `static/demo/install.js`, a module loaded before the app's
  own module that wraps `window.fetch` for this site's `api/` paths.
- `src/backend.js` implements the API on top of `src/validate.js` (a port of
  `serverhub/api/schemas.py`), `src/totp.js` (RFC 6238 via WebCrypto),
  `src/qr.js` (QR encoder for the 2FA setup), `src/sim.js` (status checks,
  Beszel metrics, host stats and the Docker containers, deterministic and
  drifting over time) and `src/docker.js` (a port of
  `serverhub/integrations/docker.py`: discovery and suggestions).
- `404.html` sends `…/settings` and `…/login` (with query and hash) to the real
  files and anything else to the dashboard.

Sign in with `demo` / `serverhub-demo` (shown on the login page).

## Commands

```sh
cd demo
npm test                                   # node --test, no dependencies
node build.js --base /server-hub/ --out dist
```

Preview under the sub-path with any static server that serves `dist/` at
`/server-hub/`, for example:

```sh
mkdir -p /tmp/site && cp -r dist /tmp/site/server-hub
python -m http.server -d /tmp/site 8080   # open http://localhost:8080/server-hub/
```

(`--base=/server-hub/` works too. In Git Bash on Windows, set
`MSYS_NO_PATHCONV=1` so the base is not turned into a Windows path.)

`.github/workflows/pages.yml` runs the tests, builds with `/server-hub/` and
deploys to GitHub Pages on pushes to `main` that touch `web/` or `demo/`.

## Differences from the real app

- No server: status checks, Beszel hubs and host stats are simulated. Service
  links point at `*.home.arpa` and do not resolve.
- Changing your own password is checked but not applied, so the demo
  credentials keep working. Resetting the demo account's password from
  Administration is ignored for the same reason.
- No rate limiting, sessions are not per device (one demo session per
  browser), and first-run setup is never shown.
- Docker auto-discovery runs against a made-up Docker host: a fixed list of
  containers (`src/seed.js`) goes through a port of the real label parsing
  (`src/docker.js`), so cards, skipped and warning notes and the admin
  suggestions look like the real thing. Container uptimes and health move with
  the clock (the one that is "starting" turns healthy after about a minute), and
  status checks of discovered services follow their container state. The
  "Show discovered services to all users" switch works, so you can sign in as
  another user to see both sides. The simulated Docker API never fails, so the
  "not responding" and "unavailable" states cannot be seen here.
- A Beszel hub you add always connects (use the password `wrong` to see a
  failed login) and reports one or two made-up systems.
- Wallpaper images from other sites are blocked by the demo's CSP
  (`img-src 'self' data:`), and `/static/…` wallpaper paths resolve against
  the domain root, not the demo's base path.
- Two-factor authentication works with a real authenticator app; "Reset demo"
  is the way out if you lose the codes.

# Server Hub Login + Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Server Hub fully functional on a Proxmox LXC cloud VPS with a styled login page, session auth, and live system stats — served by a single stdlib-only `server.py` (no nginx, no cloudflared required to start).

**Architecture:** A Python 3 stdlib `ThreadingHTTPServer` (`server.py`) sits in front of the existing static files. It redirects unauthenticated requests to a new `login.html`, verifies a single user/password from env vars on `POST /login`, issues an in-memory session cookie, and serves `/api/stats` (from `/proc`) and `/api/me`. The existing `index.html` already polls both endpoints, so no frontend logic changes.

**Tech Stack:** Python 3 standard library only (`http.server`, `secrets`, `json`, `urllib.parse`, `os`, `socket`, `threading`, `time`). Zero third-party packages.

## Global Constraints

- Python 3 stdlib only — no `pip install`, no `requirements.txt`.
- Port: `8642` default (env override `HUB_PORT`). Binds `0.0.0.0` (env override `HUB_HOST`).
- Credentials: `HUB_USER` (default `admin`), `HUB_PASSWORD` (required — server exits without it).
- Single user account only.
- Plain HTTP for now. TLS later via Cloudflare Tunnel from the Zero Trust panel (documented, not implemented).
- Session cookie: `hub_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, 30-day `Max-Age`, in-memory token store.
- Brute-force guard: 5 failed logins per client IP → 60s lockout.
- `/api/stats` → `{ "host": str, "cpu": 0-100|None, "mem": 0-100|None, "disk": 0-100|None }`.
- `/api/me` → `{ "email": "<username>" }` when authenticated (401 JSON otherwise).
- All non-public page paths redirect to `/login` when unauthenticated. API paths (`/api/stats`, `/api/me`) return 401 JSON when unauthenticated instead. Only `/login` and `/login.html` are served without a session.
- `login.html` self-contained inline CSS — no Tailwind/fonts CDN dependency.
- `index.html`, `settings.js`, `categorize.js`, `settings.html`, `tests.html` must NOT be modified.

---

### Task 1: server.py + login.html + test_server.py

**Files:**
- Create: `server.py`
- Create: `login.html`
- Create: `test_server.py`
- Modify: `.gitignore` (add `__pycache__/`, `*.pyc`)

**Interfaces:**
- Produces:
  - `server.create_server(host: str, port: int, user: str, password: str) -> HubServer` — returns running-capable server; `HubServer.server_address` gives the bound address (usable for tests with `port=0`).
  - `HubServer.sessions.get(token: str|None) -> str|None` — per-server session lookup returning username.
  - `server.guard` — module-level `LoginGuard`; `.reset(ip)` used by tests.
  - `server.stats_payload() -> dict` — `{host, cpu, mem, disk}`.
  - Constants `SESSION_TTL`, `MAX_ATTEMPTS`, `LOCKOUT_SECONDS`, `WEB_ROOT`, `MIME`.
  - CLI: `python3 server.py` reads `HUB_USER`, `HUB_PASSWORD`, `HUB_PORT`, `HUB_HOST` from env; exits with a clear message if `HUB_PASSWORD` missing.

- [ ] **Step 1: Write the failing tests**

`test_server.py`:

```python
import http.cookiejar
import json
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

import server


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ServerHubTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.create_server("127.0.0.1", 0, user="alice", password="s3cret")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, path, method="GET", data=None, jar=None):
        if jar is None:
            jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(jar)
        )
        body = urllib.parse.urlencode(data).encode() if data else None
        req = urllib.request.Request(self.base + path, data=body, method=method)
        try:
            resp = opener.open(req)
            return resp.status, dict(resp.headers), resp.read(), jar
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read(), jar

    def login(self, jar, username="alice", password="s3cret"):
        return self.request("/login", "POST", {"username": username, "password": password}, jar)

    def test_unauthenticated_root_redirects_to_login(self):
        status, headers, _, _ = self.request("/")
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "/login")

    def test_login_page_served_without_auth(self):
        status, _, body, _ = self.request("/login")
        self.assertEqual(status, 200)
        html = body.decode("utf-8")
        self.assertIn("Server Hub", html)
        self.assertIn("name=\"password\"", html)

    def test_wrong_password_redirects_with_error(self):
        status, headers, _, _ = self.login(http.cookiejar.CookieJar(), password="wrong")
        self.assertEqual(status, 302)
        self.assertIn("error=1", headers["Location"])

    def test_correct_login_grants_cookie_and_redirects(self):
        jar = http.cookiejar.CookieJar()
        status, headers, _, jar = self.login(jar)
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "/")
        self.assertIn("hub_session", {c.name for c in jar})

    def test_authenticated_root_serves_index(self):
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, _, body, _ = self.request("/", jar=jar)
        self.assertEqual(status, 200)
        self.assertIn(b"Server Hub", body)

    def test_static_asset_requires_auth(self):
        status, headers, _, _ = self.request("/categorize.js")
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "/login")

    def test_api_me_returns_username(self):
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, _, body, _ = self.request("/api/me", jar=jar)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode())["email"], "alice")

    def test_api_me_rejects_anonymous(self):
        status, _, _, _ = self.request("/api/me")
        self.assertEqual(status, 401)

    def test_api_stats_shape(self):
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, _, body, _ = self.request("/api/stats", jar=jar)
        self.assertEqual(status, 200)
        data = json.loads(body.decode())
        self.assertIn("host", data)
        for key in ("cpu", "mem", "disk"):
            value = data[key]
            self.assertTrue(value is None or (0 <= value <= 100), key + ": " + repr(value))

    def test_logout_invalidates_session(self):
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, _, _, jar = self.request("/logout", jar=jar)
        self.assertEqual(status, 302)
        status, headers, _, _ = self.request("/", jar=jar)
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "/login")

    def test_path_traversal_blocked(self):
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, _, _, _ = self.request("/..%2fserver.py", jar=jar)
        self.assertEqual(status, 404)

    def test_lockout_after_five_failures(self):
        server.guard.reset("127.0.0.1")
        jar = http.cookiejar.CookieJar()
        for _ in range(5):
            self.login(jar, password="bad")
        status, headers, _, _ = self.login(jar)
        self.assertEqual(status, 302)
        self.assertIn("error=locked", headers["Location"])
        server.guard.reset("127.0.0.1")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest test_server -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server'`

- [ ] **Step 3: Write `server.py`**

```python
#!/usr/bin/env python3
"""server.py — single-file static server + login + stats for Server Hub.

Zero third-party dependencies (Python 3 stdlib only).

Env vars:
  HUB_USER       default: admin
  HUB_PASSWORD   required — server refuses to start without it
  HUB_PORT       default: 8642
  HUB_HOST       default: 0.0.0.0
"""

import json
import os
import secrets
import socket
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEB_ROOT = os.path.dirname(os.path.abspath(__file__))
SESSION_TTL = 30 * 24 * 60 * 60  # 30 days
MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 60
PUBLIC_PATHS = {"/login", "/login.html"}

MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
}


def read_env(name, default=None):
    return os.environ.get(name) or default


class Sessions:
    """In-memory session store: token -> (expiry_timestamp, username)."""

    def __init__(self):
        self._tokens = {}
        self._lock = threading.Lock()

    def create(self, user):
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._tokens[token] = (time.time() + SESSION_TTL, user)
        return token

    def get(self, token):
        if not token:
            return None
        with self._lock:
            entry = self._tokens.get(token)
        if not entry:
            return None
        expiry, user = entry
        if time.time() > expiry:
            with self._lock:
                self._tokens.pop(token, None)
            return None
        return user

    def delete(self, token):
        if not token:
            return
        with self._lock:
            self._tokens.pop(token, None)


class LoginGuard:
    """Brute-force protection: N failed attempts per IP -> lockout."""

    def __init__(self, max_attempts=MAX_ATTEMPTS, lockout_seconds=LOCKOUT_SECONDS):
        self.max_attempts = max_attempts
        self.lockout_seconds = lockout_seconds
        self._state = {}
        self._lock = threading.Lock()

    def is_locked(self, ip):
        with self._lock:
            entry = self._state.get(ip)
            if not entry:
                return False
            fails, locked_until = entry
            if locked_until and time.time() < locked_until:
                return True
            if locked_until:
                self._state[ip] = (0, 0)
            return False

    def record_failure(self, ip):
        with self._lock:
            fails, locked_until = self._state.get(ip, (0, 0))
            fails += 1
            if fails >= self.max_attempts:
                fails = 0
                locked_until = time.time() + self.lockout_seconds
            self._state[ip] = (fails, locked_until)

    def reset(self, ip):
        with self._lock:
            self._state.pop(ip, None)


guard = LoginGuard()


# ---- system stats (Linux /proc; returns None when unavailable) ----

def cpu_percent():
    """Overall CPU usage percent (0-100) from two /proc/stat samples."""

    def read():
        try:
            with open("/proc/stat") as f:
                for line in f:
                    if line.startswith("cpu "):
                        nums = [int(x) for x in line.split()[1:]]
                        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
                        return sum(nums), idle
        except (OSError, ValueError):
            return None
        return None

    a = read()
    time.sleep(0.1)
    b = read()
    if not a or not b:
        return None
    total_delta = b[0] - a[0]
    idle_delta = b[1] - a[1]
    if total_delta <= 0:
        return None
    return round(100 * (1 - idle_delta / total_delta))


def mem_percent():
    try:
        data = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if parts:
                    data[parts[0].rstrip(":")] = int(parts[1])
        total = data.get("MemTotal")
        available = data.get("MemAvailable")
        if not total or available is None:
            return None
        return round(100 * (total - available) / total)
    except (OSError, ValueError):
        return None


def disk_percent(path="/"):
    try:
        st = os.statvfs(path)
    except (OSError, AttributeError):
        return None
    total = st.f_blocks
    used = st.f_blocks - st.f_bfree
    if total <= 0:
        return None
    return round(100 * used / total)


def stats_payload():
    try:
        with open("/etc/hostname") as f:
            host = f.read().strip() or socket.gethostname()
    except OSError:
        host = socket.gethostname()
    return {"host": host, "cpu": cpu_percent(), "mem": mem_percent(), "disk": disk_percent()}


# ---- HTTP handler ----

class HubHandler(BaseHTTPRequestHandler):
    server_version = "ServerHub/1.0"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.address_string(), fmt % args))

    def client_ip(self):
        return self.client_address[0]

    def send_bytes(self, body, status=200, ctype="text/html; charset=utf-8", extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location, extra_headers=None):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def read_cookie(self, name):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith(name + "="):
                return part[len(name) + 1:]
        return None

    def session_user(self):
        return self.server.sessions.get(self.read_cookie("hub_session"))

    def session_cookie(self, token):
        return "hub_session=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=%d" % (token, SESSION_TTL)

    def clear_cookie(self):
        return {"Set-Cookie": "hub_session=; Path=/; Max-Age=0"}

    def serve_file(self, rel):
        if not rel:
            return self.send_bytes("Not found", 404)
        full = os.path.normpath(os.path.join(WEB_ROOT, rel))
        if full != WEB_ROOT and not full.startswith(WEB_ROOT + os.sep):
            return self.send_bytes("Forbidden", 403)
        if not os.path.isfile(full):
            return self.send_bytes("Not found", 404)
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        return self.send_bytes(body, 200, ctype, {"Cache-Control": "no-cache"})

    # ---- routes ----

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in PUBLIC_PATHS:
            user = self.session_user()
            if user:
                return self.redirect("/")
            return self.serve_file("login.html")
        if path == "/logout":
            self.server.sessions.delete(self.read_cookie("hub_session"))
            return self.redirect("/login", self.clear_cookie())
        user = self.session_user()
        if path == "/api/stats":
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self.send_bytes(json.dumps(stats_payload()), 200, "application/json; charset=utf-8")
        if path == "/api/me":
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self.send_bytes(json.dumps({"email": user}), 200, "application/json; charset=utf-8")
        if not user:
            return self.redirect("/login")
        if path == "/":
            return self.serve_file("index.html")
        return self.serve_file(path.lstrip("/"))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path != "/login":
            return self.send_bytes("Not found", 404)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        form = urllib.parse.parse_qs(raw)
        username = (form.get("username") or [""])[0]
        password = (form.get("password") or [""])[0]
        ip = self.client_ip()
        if guard.is_locked(ip):
            return self.redirect("/login?error=locked")
        if secrets.compare_digest(username, self.server.hub_user) and secrets.compare_digest(
            password, self.server.hub_password
        ):
            guard.reset(ip)
            token = self.server.sessions.create(username)
            return self.redirect("/", {"Set-Cookie": self.session_cookie(token)})
        guard.record_failure(ip)
        return self.redirect("/login?error=1")


class HubServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, handler, hub_user, hub_password):
        super().__init__(addr, handler)
        self.hub_user = hub_user
        self.hub_password = hub_password
        self.sessions = Sessions()


def create_server(host="0.0.0.0", port=8642, user=None, password=None):
    user = user or read_env("HUB_USER", "admin")
    password = password or read_env("HUB_PASSWORD")
    if not password:
        raise SystemExit("HUB_PASSWORD must be set (and not empty).")
    return HubServer((host, port), HubHandler, user, password)


def main():
    host = read_env("HUB_HOST", "0.0.0.0")
    port = int(read_env("HUB_PORT", "8642"))
    httpd = create_server(host, port)
    print("Server Hub listening on http://%s:%d" % (host, port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBye")
        httpd.server_close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they still fail (only the /login body test)**

Run: `python -m unittest test_server -v`
Expected: mostly PASS, but `test_login_page_served_without_auth` FAILS with 404 (no `login.html` yet).

- [ ] **Step 5: Write `login.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in — Server Hub</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235E6AD2' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='7' height='7' rx='1'/%3E%3Crect x='14' y='3' width='7' height='7' rx='1'/%3E%3Crect x='3' y='14' width='7' height='7' rx='1'/%3E%3Crect x='14' y='14' width='7' height='7' rx='1'/%3E%3C/svg%3E" />
  <style>
    :root {
      --bg-deep: #020203; --bg-base: #050506; --bg-elev: #0a0a0c;
      --surface: rgba(255,255,255,0.05); --surface-hi: rgba(255,255,255,0.08);
      --border: rgba(255,255,255,0.08);  --border-hi: rgba(255,255,255,0.16);
      --fg: #EDEDEF; --fg-muted: #8A8F98;
      --accent: #5E6AD2; --accent-glow: rgba(94,106,210,0.20);
      --red: #EF4444;
      --blob-a: #5E6AD2; --blob-b: #8B5CF6; --blob-c: #22C55E;
      --blob-opacity: 0.18;
      --ease: cubic-bezier(0.16, 1, 0.3, 1);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
      background-color: var(--bg-deep);
      color: var(--fg);
      display: flex; align-items: center; justify-content: center;
      padding: 1.5rem;
      background:
        radial-gradient(1200px 800px at 12% -8%, color-mix(in srgb, var(--blob-a) 16%, transparent), transparent 60%),
        radial-gradient(900px 700px at 92% 8%, color-mix(in srgb, var(--blob-b) 12%, transparent), transparent 55%),
        linear-gradient(180deg, var(--bg-elev) 0%, var(--bg-deep) 70%);
    }
    .blob {
      position: fixed; border-radius: 9999px; filter: blur(60px);
      opacity: var(--blob-opacity); pointer-events: none; z-index: 0;
      animation: drift 22s var(--ease) infinite alternate;
    }
    .blob.a { width: 420px; height: 420px; background: var(--blob-a); top: -120px; left: -80px; }
    .blob.b { width: 360px; height: 360px; background: var(--blob-b); top: 10vh; right: -120px; animation-delay: -6s; }
    .blob.c { width: 320px; height: 320px; background: var(--blob-c); bottom: -120px; left: 35%; opacity: calc(var(--blob-opacity) * 0.55); animation-delay: -12s; }
    @keyframes drift {
      0%   { transform: translate3d(0,0,0) scale(1); }
      50%  { transform: translate3d(40px,30px,0) scale(1.08); }
      100% { transform: translate3d(-30px,-20px,0) scale(0.96); }
    }
    .card {
      position: relative; z-index: 1;
      width: 100%; max-width: 380px;
      background: var(--surface);
      backdrop-filter: blur(20px) saturate(140%);
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2.25rem 2rem;
      text-align: center;
    }
    .logo {
      width: 52px; height: 52px; margin: 0 auto 1rem;
      display: flex; align-items: center; justify-content: center;
      border-radius: 14px;
      background: var(--accent); color: #fff;
      box-shadow: 0 8px 28px -8px var(--accent-glow);
    }
    h1 { margin: 0 0 0.25rem; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.01em; }
    .sub { margin: 0 0 1.75rem; font-size: 0.85rem; color: var(--fg-muted); }
    label { display: block; text-align: left; margin-bottom: 1rem; font-size: 0.8rem; color: var(--fg-muted); }
    input {
      width: 100%; margin-top: 0.4rem; padding: 0.65rem 0.8rem;
      background: transparent; border: 1px solid var(--border); border-radius: 10px;
      color: var(--fg); font-size: 0.9rem; outline: none;
      transition: border-color 200ms var(--ease), background-color 200ms var(--ease);
    }
    input::placeholder { color: var(--fg-muted); }
    input:focus { border-color: var(--accent); background: var(--surface-hi); }
    button {
      width: 100%; margin-top: 0.5rem; padding: 0.7rem 1rem;
      background: var(--accent); color: #fff; border: none; border-radius: 10px;
      font-size: 0.9rem; font-weight: 500; cursor: pointer;
      transition: background-color 200ms var(--ease), transform 150ms var(--ease);
    }
    button:hover { background: color-mix(in srgb, var(--accent) 88%, white); transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    .error {
      margin-top: 1.1rem; padding: 0.6rem 0.8rem;
      border: 1px solid color-mix(in srgb, var(--red) 45%, var(--border));
      background: color-mix(in srgb, var(--red) 10%, transparent);
      border-radius: 10px; font-size: 0.8rem; color: var(--red);
    }
    .hidden { display: none; }
    .foot { margin-top: 1.4rem; font-size: 0.7rem; color: var(--fg-muted); font-family: 'Fira Code', monospace; }
    @media (prefers-reduced-motion: reduce) { .blob { animation: none; } }
  </style>
</head>
<body>
  <div class="blob a" aria-hidden="true"></div>
  <div class="blob b" aria-hidden="true"></div>
  <div class="blob c" aria-hidden="true"></div>

  <div class="card">
    <div class="logo">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    </div>
    <h1>Server Hub</h1>
    <p class="sub">Sign in to your self-hosted dashboard</p>
    <form method="post" action="/login">
      <label>Username
        <input name="username" autocomplete="username" autofocus required placeholder="admin" />
      </label>
      <label>Password
        <input type="password" name="password" autocomplete="current-password" required placeholder="••••••••" />
      </label>
      <button type="submit">Sign in</button>
    </form>
    <p id="error-bad" class="error hidden">Invalid username or password.</p>
    <p id="error-locked" class="error hidden">Too many attempts. Try again in a minute.</p>
    <p class="foot">self-hosted · 8642</p>
  </div>

  <script>
    var q = new URLSearchParams(location.search);
    if (q.get('error') === '1') {
      document.getElementById('error-bad').classList.remove('hidden');
    } else if (q.get('error') === 'locked') {
      document.getElementById('error-locked').classList.remove('hidden');
    }
  </script>
</body>
</html>
```

- [ ] **Step 6: Run all tests to verify they pass**

Run: `python -m unittest test_server -v`
Expected: ALL 12 tests PASS (11 named + lockout). Confirm the `/login` body test now passes.

- [ ] **Step 7: Update `.gitignore`**

Append:

```
__pycache__/
*.pyc
```

- [ ] **Step 8: Commit**

```bash
git add server.py login.html test_server.py .gitignore
git commit -m "feat: add server.py auth + stats backend and login page"
```

---

### Task 2: Update SETUP-LXC.md and README.md

**Files:**
- Modify: `SETUP-LXC.md` (rewrite hosting sections)
- Modify: `README.md` (deploy section + files table)

**Interfaces:**
- Consumes: `server.py` env vars `HUB_USER`, `HUB_PASSWORD`, `HUB_PORT` (default `8642`), `HUB_HOST`; systemd unit runs `python3 /srv/server-hub/server.py`.

- [ ] **Step 1: Rewrite `SETUP-LXC.md` hosting path**

Replace the nginx/cloudflared/Access content with the `server.py` path. Keep sections numbered; the file must end with a working, copy-pasteable flow:

```
# Host on Proxmox LXC (no nginx, no cloudflared required)

Goal: a single Debian LXC container on your Proxmox node runs `server.py`
(no third-party packages) serving the static files behind a styled login page.
TLS/HTTPS can be added later from the Cloudflare Zero Trust panel via a
Cloudflare Tunnel — the container needs no nginx and no public port
configuration for that either.
```

Sections to write:

1. **Create the LXC container** — same steps as the current doc §1 (Debian 12, 1 core, 512 MB, 4 GB disk).
2. **Get the files in** — `scp` the 6 files (`index.html`, `categorize.js`, `settings.js`, `settings.html`, `tests.html`, `login.html`, `server.py`) to `/srv/server-hub/`, or `git clone` the repo.
3. **Run `server.py`** — as a systemd service:

   `/etc/systemd/system/server-hub.service`:

   ```ini
   [Unit]
   Description=Server Hub (static + login + stats)
   After=network.target

   [Service]
   WorkingDirectory=/srv/server-hub
   Environment=HUB_USER=admin
   Environment=HUB_PASSWORD=CHANGE_ME_LONG_RANDOM
   Environment=HUB_PORT=8642
   Environment=HUB_HOST=0.0.0.0
   ExecStart=/usr/bin/python3 /srv/server-hub/server.py
   Restart=always
   RestartSec=2

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   systemctl daemon-reload
   systemctl enable --now server-hub
   curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8642/login   # → 200
   ```

4. **Make it reachable** — router port-forward `8642` to the container IP, or (recommended, later) a Cloudflare Tunnel from the Zero Trust panel with service `http://<container-ip>:8642` — no nginx involved.
5. **Security notes** — password lives in the systemd unit (root-only readable); session cookie is HttpOnly; 5-failed-login lockout. When you add the tunnel, keep `HUB_HOST=0.0.0.0` since the tunnel connects from inside the container.
6. **Update checklist** — `scp` new files, `systemctl restart server-hub` (sessions reset — fine).
7. **Troubleshooting table** — keep relevant rows and add: wrong password loops → check `HUB_PASSWORD` in the unit; 404 on `/login` → `server.py` running? (`systemctl status server-hub`).

> Remove all cloudflared + nginx + Cloudflare Access config blocks and the Access policy section — the login is now enforced by `server.py` itself. Cross-reference `SETUP.md` no longer applies for auth.

- [ ] **Step 2: Update `README.md`**

- Files table: add `server.py` ("Auth + static server + /api/stats + /api/me (stdlib only)") and `login.html` ("Styled login page, served by server.py").
- "Host it (TL;DR)" — replace with: set `HUB_PASSWORD`, run `python3 server.py`, visit `http://<host>:8642`.
- Quick start (local):

  ```bash
  HUB_PASSWORD=change-me python3 server.py
  # visit http://localhost:8642
  ```

- Quick start (public, with secure login): point to `SETUP-LXC.md`.
- Architecture diagram "Origin" block: replace "nginx on 127.0.0.1:80" with `server.py` and list `/login`, `/api/stats`, `/api/me`.
- Known limits: replace the "stats stay at —" line (now wired) and remove the Cloudflare Access references; keep the localStorage per-device note.

- [ ] **Step 3: Verify by reading both files end-to-end**

Run: `Get-Content SETUP-LXC.md` and `Get-Content README.md` (or open them).
Expected: no remaining mentions of `nginx`, `cloudflared`, or "Cloudflare Access" as the auth mechanism.

- [ ] **Step 4: Commit**

```bash
git add SETUP-LXC.md README.md
git commit -m "docs: switch hosting guide to server.py auth (no nginx/cloudflared)"
```

---

### Task 3: End-to-end verification

**Files:**
- None (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1-2.

- [ ] **Step 1: Run the unit suite**

Run: `python -m unittest test_server -v`
Expected: 12/12 PASS.

- [ ] **Step 2: Boot the real server and curl the flow**

Run:

```powershell
$env:HUB_USER="admin"; $env:HUB_PASSWORD="test-pass"; Start-Process python -ArgumentList "server.py" -PassThru
Start-Sleep -Seconds 2
# 1. anonymous root → redirect to /login
(Invoke-WebRequest -Uri http://127.0.0.1:8642/ -MaximumRedirection 0 -ErrorAction SilentlyContinue).Headers.Location
# 2. login page body contains password field
(Invoke-WebRequest -Uri http://127.0.0.1:8642/login).Content -match 'name="password"'
# 3. wrong password → /login?error=1
$r = Invoke-WebRequest -Uri http://127.0.0.1:8642/login -Method POST -Body @{username='admin';password='wrong'} -MaximumRedirection 0 -ErrorAction SilentlyContinue
$r.Headers.Location
# 4. correct login → cookie + redirect; then /api/stats with session
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-WebRequest -Uri http://127.0.0.1:8642/login -Method POST -Body @{username='admin';password='test-pass'} -WebSession $s | Out-Null
(Invoke-WebRequest -Uri http://127.0.0.1:8642/api/stats -WebSession $s).Content
Stop-Process -Name python
```

Expected: step 1 prints `/login`, step 2 `True`, step 3 `/login?error=1`, step 4 prints a JSON object with `host` plus `cpu`/`mem`/`disk` (numbers or `null` on Windows).

- [ ] **Step 3: Run the existing browser suite**

Open `tests.html` locally in a browser (or `python -m http.server 8000` then visit it) — confirm `ALL GREEN`. Note: `tests.html` tests the client-side DOM, not auth; it is unaffected by `server.py`.

- [ ] **Step 4: Run the tests with a missing password to confirm fail-fast**

Run: `python -m unittest test_server -v` is unaffected (passes explicit creds); then run `python server.py` with no env vars.
Expected: exits with `HUB_PASSWORD must be set (and not empty).` and no server starts.

- [ ] **Step 5: Commit any fixes**

If Steps 2-4 surfaced bugs, fix them in `server.py`/`login.html` and commit:

```bash
git add -A
git commit -m "fix: <describe the fix>"
```

(If nothing to fix, run `git status` and confirm a clean tree instead — do NOT create an empty commit.)

- [ ] **Step 6: Update the knowledge graph**

Run: `graphify update .`
Expected: graph updated with the new files (AST-only, no API cost).

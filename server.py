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
MAX_LOGIN_BODY = 64 * 1024  # reject larger login POST bodies before reading them
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
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return self.send_bytes("Bad request", 400, "text/plain; charset=utf-8")
        if length < 0:
            return self.send_bytes("Bad request", 400, "text/plain; charset=utf-8")
        if length > MAX_LOGIN_BODY:
            return self.send_bytes("Payload too large", 413, "text/plain; charset=utf-8")
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

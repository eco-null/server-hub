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
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEB_ROOT = os.path.dirname(os.path.abspath(__file__))
SESSION_TTL = 30 * 24 * 60 * 60  # 30 days
MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 60
MAX_LOGIN_BODY = 64 * 1024  # reject larger login POST bodies before reading them
PUBLIC_PATHS = {"/login", "/login.html"}

MAX_API_BODY = 64 * 1024  # reject larger API JSON bodies before reading them
SERVICES_FILE = os.path.join(WEB_ROOT, "services.json")

KNOWN_ICONS = {
    "chart", "pulse", "database", "shield", "shield-check", "key", "lock",
    "lock-key", "cloud", "note", "file", "film", "music", "headphones", "git",
    "branch", "terminal", "globe", "home", "broadcast", "cog", "box",
    "shopping", "flask", "sparkles",
}
KNOWN_CATEGORIES = {
    "Monitoring", "Security", "Network", "Media", "Productivity", "Files",
    "Dev", "Communication", "Home", "Finance", "AI", "Search", "Database",
    "Other",
}


def validate_service(data, partial=False):
    """Validate a service object. Returns (fields, None) or (None, error)."""
    if not isinstance(data, dict):
        return None, "body must be a JSON object"
    fields = {}
    if "name" in data or not partial:
        name = str(data.get("name") or "").strip()
        if not name:
            return None, "name is required"
        if len(name) > 200:
            return None, "name too long"
        fields["name"] = name
    if "url" in data or not partial:
        url = str(data.get("url") or "").strip()
        if not url:
            return None, "url is required"
        if len(url) > 2000:
            return None, "url too long"
        if not re.match(r"^https?://", url):
            return None, "url must start with http:// or https://"
        try:
            if not urllib.parse.urlparse(url).netloc:
                return None, "url must be a valid http(s) URL"
        except ValueError:
            return None, "url must be a valid http(s) URL"
        fields["url"] = url
    if "desc" in data or not partial:
        desc = str(data.get("desc") or "").strip()
        if len(desc) > 500:
            return None, "desc too long"
        fields["desc"] = desc
    if "icon" in data or not partial:
        icon = str(data.get("icon") or "box")
        fields["icon"] = icon if icon in KNOWN_ICONS else "box"
    if "ping" in data or not partial:
        fields["ping"] = bool(data.get("ping", True))
    if "categoryOverride" in data or not partial:
        cat = data.get("categoryOverride") or None
        if cat is not None and cat not in KNOWN_CATEGORIES:
            return None, "unknown category: " + str(cat)
        fields["categoryOverride"] = cat
    return fields, None


def validate_bookmark(data, partial=False):
    """Validate a bookmark object. Returns (fields, None) or (None, error)."""
    if not isinstance(data, dict):
        return None, "body must be a JSON object"
    fields = {}
    if "name" in data or not partial:
        name = str(data.get("name") or "").strip()
        if not name:
            return None, "name is required"
        if len(name) > 200:
            return None, "name too long"
        fields["name"] = name
    if "url" in data or not partial:
        url = str(data.get("url") or "").strip()
        if not url:
            return None, "url is required"
        if len(url) > 2000:
            return None, "url too long"
        if not re.match(r"^https?://", url):
            return None, "url must start with http:// or https://"
        fields["url"] = url
    if "icon" in data or not partial:
        icon = str(data.get("icon") or "link").strip()
        fields["icon"] = icon or "link"
    return fields, None


class ServiceStore:
    """Thread-safe JSON-backed service list. Atomic writes (tmp + os.replace)."""

    def __init__(self, path):
        self._path = path
        self._lock = threading.Lock()
        self._services = self._load()
        self._bookmarks = self._load("bookmarks")

    def _load(self, key="services"):
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
            items = data.get(key, [])
            if not isinstance(items, list):
                return []
            return [s for s in items if isinstance(s, dict) and s.get("id")]
        except (OSError, ValueError):
            return []

    def _save(self):
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"services": self._services, "bookmarks": self._bookmarks}, f, indent=2)
        os.replace(tmp, self._path)

    def list(self):
        with self._lock:
            return [dict(s) for s in self._services]

    def add(self, entry):
        entry = dict(entry)
        entry["id"] = secrets.token_urlsafe(12)
        with self._lock:
            self._services.append(entry)
            self._save()
        return dict(entry)

    def update(self, sid, fields):
        with self._lock:
            for i, s in enumerate(self._services):
                if s["id"] == sid:
                    self._services[i] = {**s, **fields, "id": sid}
                    self._save()
                    return dict(self._services[i])
        return None

    def delete(self, sid):
        with self._lock:
            before = len(self._services)
            self._services = [s for s in self._services if s["id"] != sid]
            if len(self._services) != before:
                self._save()
                return True
        return False

    def list_bookmarks(self):
        with self._lock:
            return [dict(b) for b in self._bookmarks]

    def add_bookmark(self, entry):
        entry = dict(entry)
        entry["id"] = secrets.token_urlsafe(12)
        with self._lock:
            self._bookmarks.append(entry)
            self._save()
        return dict(entry)

    def update_bookmark(self, bid, fields):
        with self._lock:
            for i, b in enumerate(self._bookmarks):
                if b["id"] == bid:
                    self._bookmarks[i] = {**b, **fields, "id": bid}
                    self._save()
                    return dict(self._bookmarks[i])
        return None

    def delete_bookmark(self, bid):
        with self._lock:
            before = len(self._bookmarks)
            self._bookmarks = [b for b in self._bookmarks if b["id"] != bid]
            if len(self._bookmarks) != before:
                self._save()
                return True
        return False

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


# ---- Beszel multi-server stats proxy ----

BESZEL_CACHE_TTL = 10.0
_beszel_cache = {}


def clear_beszel_cache():
    _beszel_cache.clear()


def read_beszel_env():
    url = read_env("BESZEL_URL", "").rstrip("/")
    if not url:
        return None
    return {
        "url": url,
        "user": read_env("BESZEL_USER", ""),
        "password": read_env("BESZEL_PASSWORD", ""),
    }


def normalize_beszel_system(rec):
    """Map a Beszel systems-collection record to the dashboard shape.

    stat_cpu/stat_mem/stat_disk are pinned to the live Beszel/PocketBase
    instance; if the fields drift this is the one-line fix.
    """
    return {
        "name": rec.get("name"),
        "cpu": rec.get("stat_cpu"),
        "mem": rec.get("stat_mem"),
        "disk": rec.get("stat_disk"),
        "status": rec.get("status", "unknown"),
    }


def _beszel_urlopen(req):
    try:
        return urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as e:
        e.close()
        raise


def _beszel_login(cfg):
    url = cfg["url"].rstrip("/") + "/api/collections/users/auth-with-password"
    payload = json.dumps({
        "identity": cfg["user"],
        "password": cfg["password"],
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with _beszel_urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("token")  # PocketBase-issued JWT


def _beszel_systems():
    """Fetch + normalize Beszel systems, cached in-process for 10s.

    Returns a list of {name, cpu, mem, disk, status} dicts, or None when
    Beszel is unconfigured. Raises on connection/auth/fetch failure.
    """
    cfg = read_beszel_env()
    if not cfg:
        return None
    now = time.time()
    cached = _beszel_cache.get(cfg["url"])
    if cached and now - cached[0] < BESZEL_CACHE_TTL:
        return cached[1]

    # Always obtain a fresh JWT via the login flow (token-based API keys
    # can be misconfigured/expired; user/password is the reliable path).
    token = _beszel_login(cfg)
    if not token:
        return None

    req = urllib.request.Request(
        cfg["url"].rstrip("/") + "/api/collections/systems?perPage=100",
        headers={
            # PocketBase accepts both "Bearer <token>" and bare "<token>".
            "Authorization": f"Bearer {token}",
        },
    )
    with _beszel_urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    systems = [normalize_beszel_system(rec) for rec in data.get("items", [])]
    _beszel_cache[cfg["url"]] = (now, systems)
    return systems


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

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return None, "bad content-length"
        if length < 0:
            return None, "bad content-length"
        if length > MAX_API_BODY:
            return None, "payload too large"
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            return json.loads(raw), None
        except ValueError:
            return None, "invalid JSON"

    def session_user(self):
        return self.server.sessions.get(self.read_cookie("hub_session"))

    def session_cookie(self, token):
        return "hub_session=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=%d" % (token, SESSION_TTL)

    def clear_cookie(self):
        return {"Set-Cookie": "hub_session=; Path=/; Max-Age=0"}

    # ---- services API helpers ----

    def _api_services(self):
        return self.server.services.list()

    def _services_response(self, services):
        return self.send_bytes(json.dumps({"services": services}), 200, "application/json; charset=utf-8")

    def _api_error(self, status, message):
        return self.send_bytes(json.dumps({"error": message}), status, "application/json; charset=utf-8")

    def _handle_services_list(self):
        return self._services_response(self._api_services())

    def _handle_services_create(self):
        data, err = self.read_json_body()
        if err:
            if err == "payload too large":
                return self._api_error(413, err)
            return self._api_error(400, err)
        fields, err = validate_service(data, partial=False)
        if err:
            return self._api_error(400, err)
        self.server.services.add(fields)
        return self._services_response(self._api_services())

    def _handle_services_update(self, sid):
        data, err = self.read_json_body()
        if err:
            if err == "payload too large":
                return self._api_error(413, err)
            return self._api_error(400, err)
        fields, err = validate_service(data, partial=True)
        if err:
            return self._api_error(400, err)
        if self.server.services.update(sid, fields) is None:
            return self._api_error(404, "service not found")
        return self._services_response(self._api_services())

    def _handle_services_delete(self, sid):
        if not self.server.services.delete(sid):
            return self._api_error(404, "service not found")
        return self._services_response(self._api_services())

    # ---- bookmarks API helpers ----

    def _bookmarks_response(self, bookmarks):
        return self.send_bytes(json.dumps({"bookmarks": bookmarks}), 200, "application/json; charset=utf-8")

    def _handle_bookmarks_list(self):
        return self._bookmarks_response(self.server.services.list_bookmarks())

    def _handle_bookmarks_create(self):
        data, err = self.read_json_body()
        if err:
            if err == "payload too large":
                return self._api_error(413, err)
            return self._api_error(400, err)
        fields, err = validate_bookmark(data, partial=False)
        if err:
            return self._api_error(400, err)
        self.server.services.add_bookmark(fields)
        return self._bookmarks_response(self.server.services.list_bookmarks())

    def _handle_bookmarks_update(self, bid):
        data, err = self.read_json_body()
        if err:
            if err == "payload too large":
                return self._api_error(413, err)
            return self._api_error(400, err)
        fields, err = validate_bookmark(data, partial=True)
        if err:
            return self._api_error(400, err)
        if self.server.services.update_bookmark(bid, fields) is None:
            return self._api_error(404, "bookmark not found")
        return self._bookmarks_response(self.server.services.list_bookmarks())

    def _handle_bookmarks_delete(self, bid):
        if not self.server.services.delete_bookmark(bid):
            return self._api_error(404, "bookmark not found")
        return self._bookmarks_response(self.server.services.list_bookmarks())

    # ---- Beszel API helpers ----

    def _handle_beszel(self):
        try:
            systems = _beszel_systems()
        except Exception as e:
            return self.send_bytes(
                json.dumps({"enabled": True, "error": str(e)}), 200,
                "application/json; charset=utf-8")
        if systems is None:
            return self.send_bytes(json.dumps({"enabled": False}), 200, "application/json; charset=utf-8")
        return self.send_bytes(
            json.dumps({"enabled": True, "systems": systems}), 200,
            "application/json; charset=utf-8")

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
        if path == "/api/services":
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_services_list()
        if path == "/api/beszel":
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_beszel()
        if path == "/api/bookmarks":
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_bookmarks_list()
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
        if path == "/api/services":
            user = self.session_user()
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_services_create()
        if path == "/api/bookmarks":
            user = self.session_user()
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_bookmarks_create()
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

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/api/services/([^/]+)$", path)
        if m:
            user = self.session_user()
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_services_update(m.group(1))
        m = re.match(r"^/api/bookmarks/([^/]+)$", path)
        if m:
            user = self.session_user()
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_bookmarks_update(m.group(1))
        return self.send_bytes("Not found", 404)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/api/services/([^/]+)$", path)
        if m:
            user = self.session_user()
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_services_delete(m.group(1))
        m = re.match(r"^/api/bookmarks/([^/]+)$", path)
        if m:
            user = self.session_user()
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_bookmarks_delete(m.group(1))
        return self.send_bytes("Not found", 404)


class HubServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, handler, hub_user, hub_password, services_path=None):
        super().__init__(addr, handler)
        self.hub_user = hub_user
        self.hub_password = hub_password
        self.sessions = Sessions()
        self.services = ServiceStore(services_path or SERVICES_FILE)


def create_server(host="0.0.0.0", port=8642, user=None, password=None, services_path=None):
    user = user or read_env("HUB_USER", "admin")
    password = password or read_env("HUB_PASSWORD")
    if not password:
        raise SystemExit("HUB_PASSWORD must be set (and not empty).")
    return HubServer((host, port), HubHandler, user, password, services_path)


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

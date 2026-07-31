# Server Hub — Persistent Services, Hover Edit/Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make service links permanent (server-stored in `services.json`) with hover-revealed edit/delete buttons on every dashboard card and an edit modal with an icon picker.

**Architecture:** `server.py` gains a `ServiceStore` (thread-safe, atomic JSON writes) plus authenticated CRUD endpoints under `/api/services`. `index.html` drops the `SERVICES_DEFAULT` array, loads services from the API, one-time-migrates any leftover `localStorage` services up, and renders hover edit/delete on every card backed by an edit modal. `settings.html`'s "Your links" editor is repointed to the same API. `tests.html` stubs the API for deterministic DOM tests.

**Tech Stack:** Python 3 standard library only (`http.server`, `secrets`, `json`, `os`, `re`, `threading`, `urllib.parse`). Frontend is plain HTML/JS with inline SVG icons (existing pattern). Zero third-party packages.

## Global Constraints

- Python 3 stdlib only — no `pip install`, no `requirements.txt`.
- `services.json` lives next to `server.py` (`WEB_ROOT/services.json`); configurable via `create_server(..., services_path=...)` for tests.
- All `/api/services*` endpoints require a session — unauthenticated requests return `401 {"error":"unauthenticated"}` (same as `/api/stats`, `/api/me`).
- Writes are atomic: write `services.json.tmp` then `os.replace(...)`, all under a `threading.Lock`.
- Service `id` is server-assigned (`secrets.token_urlsafe(12)`) and stable across edits.
- Validation limits: `name` required ≤200 chars; `url` required ≤2000 chars must start `http://`/`https://` and parse with a host; `desc` optional ≤500; `icon` must be in `KNOWN_ICONS` (else `box`); `categoryOverride` must be null or a known category; body ≤64 KB.
- Success responses: GET → `{"services": [...]}`, POST/PUT/DELETE → updated `{"services": [...]}`. Errors → `{"error": "<msg>"}` with 400/404/401/413.
- No localStorage for services after migration — server JSON is the single source of truth. Non-2xx writes never mutate local state.
- Windows: run `python` (not `python3`). Test command: `python -m unittest test_server`.
- `services.json` must be added to `.gitignore` (user data, not committed).
- Frontend keeps existing patterns: inline `onclick` handlers with `event.preventDefault()`, `esc()` for HTML escaping, `svgFor()` for icons, Tailwind CDN classes.

---

### Task 1: server.py — services store + CRUD API + tests

**Files:**
- Modify: `server.py`
- Modify: `test_server.py`
- Modify: `.gitignore` (add `services.json`)

**Interfaces:**
- Produces:
  - `server.ServiceStore(path: str) -> ServiceStore` with `list() -> list[dict]`, `add(entry: dict) -> dict` (assigns `id`), `update(sid: str, fields: dict) -> dict|None`, `delete(sid: str) -> bool`.
  - `server.validate_service(data: dict, partial: bool) -> (dict, str|None)` — returns `(validated_fields, None)` or `(None, error_msg)`. When `partial=True`, only keys present in `data` are validated/returned.
  - `server.KNOWN_ICONS`, `server.KNOWN_CATEGORIES` sets.
  - `server.MAX_API_BODY = 64 * 1024`.
  - `HubServer.__init__(addr, handler, hub_user, hub_password, services_path=None)` — adds `self.services = ServiceStore(...)`.
  - `create_server(host, port, user, password, services_path=None)` — passes through to `HubServer`.
  - Routes: `GET /api/services`, `POST /api/services`, `PUT /api/services/<id>`, `DELETE /api/services/<id>`.
  - Handler helper `HubHandler.read_json_body() -> (dict|None, str|None)` — reads Content-Length-guarded body, returns `(json_data, None)` or `(None, error_msg)`.

- [ ] **Step 1: Write the failing tests**

Add `import os`, `import tempfile` to `test_server.py`. Update `setUpClass` so the server uses a temp `services_path` (never the repo's real file), and clean up in `tearDownClass`:

```python
@classmethod
def setUpClass(cls):
    cls.tmpdir = tempfile.TemporaryDirectory()
    cls.services_path = os.path.join(cls.tmpdir.name, "services.json")
    cls.httpd = server.create_server(
        "127.0.0.1", 0, user="alice", password="s3cret", services_path=cls.services_path
    )
    cls.port = cls.httpd.server_address[1]
    cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
    cls.thread.start()
    cls.base = "http://127.0.0.1:%d" % cls.port

@classmethod
def tearDownClass(cls):
    cls.httpd.shutdown()
    cls.httpd.server_close()
    cls.tmpdir.cleanup()
```

Add a JSON helper method (after `login`):

```python
def api(self, path, method="GET", body=None, jar=None):
    data = json.dumps(body).encode() if body is not None else None
    if jar is None:
        jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPCookieProcessor(jar)
    )
    req = urllib.request.Request(
        self.base + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with contextlib.closing(opener.open(req)) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}"), jar
    except urllib.error.HTTPError as e:
        with contextlib.closing(e):
            return e.code, json.loads(e.read().decode() or "{}"), jar
```

Add these test methods:

```python
def test_services_requires_auth(self):
    status, _, _ = self.api("/api/services")
    self.assertEqual(status, 401)
    status, _, _ = self.api("/api/services", "POST", {})
    self.assertEqual(status, 401)

def test_services_empty_by_default(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    status, data, _ = self.api("/api/services", jar=jar)
    self.assertEqual(status, 200)
    self.assertEqual(data, {"services": []})

def test_add_service_roundtrip(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    entry = {"name": "Grafana", "url": "https://grafana.example.com",
             "desc": "Metrics", "icon": "chart", "ping": True, "categoryOverride": None}
    status, data, _ = self.api("/api/services", "POST", entry, jar)
    self.assertEqual(status, 200)
    added = data["services"][0]
    self.assertEqual(added["name"], "Grafana")
    self.assertTrue(added["id"])
    status, data, _ = self.api("/api/services", jar=jar)
    self.assertEqual(len(data["services"]), 1)
    self.assertEqual(data["services"][0]["id"], added["id"])

def test_add_validation_failures(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    for bad in (
        {"name": "", "url": "https://x.example.com"},
        {"name": "X", "url": ""},
        {"name": "X", "url": "not-a-url"},
        {"name": "X", "url": "ftp://x.example.com"},
        {"name": "X", "url": "https://x.example.com", "categoryOverride": "Nope"},
    ):
        status, data, _ = self.api("/api/services", "POST", bad, jar)
        self.assertEqual(status, 400, "url" in data and data.get("error") or bad)
        self.assertIn("error", data)

def test_add_unknown_icon_falls_back(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    status, data, _ = self.api(
        "/api/services", "POST",
        {"name": "X", "url": "https://x.example.com", "icon": "nope"}, jar)
    self.assertEqual(status, 200)
    self.assertEqual(data["services"][0]["icon"], "box")

def test_update_service_preserves_id_and_ping(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    status, data, _ = self.api(
        "/api/services", "POST",
        {"name": "Grafana", "url": "https://grafana.example.com",
         "desc": "Metrics", "icon": "chart", "ping": True, "categoryOverride": None}, jar)
    sid = data["services"][0]["id"]
    status, data, _ = self.api(
        "/api/services/" + sid, "PUT",
        {"name": "Grafana Ops", "url": "https://grafana2.example.com", "desc": "Dashboards",
         "icon": "pulse", "categoryOverride": "Monitoring"}, jar)
    self.assertEqual(status, 200)
    upd = data["services"][0]
    self.assertEqual(upd["id"], sid)
    self.assertEqual(upd["name"], "Grafana Ops")
    self.assertEqual(upd["url"], "https://grafana2.example.com")
    self.assertEqual(upd["icon"], "pulse")
    self.assertTrue(upd["ping"])  # not sent → preserved

def test_update_unknown_id_404(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    status, data, _ = self.api(
        "/api/services/missing", "PUT",
        {"name": "X", "url": "https://x.example.com"}, jar)
    self.assertEqual(status, 404)
    self.assertIn("error", data)

def test_delete_service(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    for i in range(2):
        self.api("/api/services", "POST",
                 {"name": "Svc" + str(i), "url": "https://s" + str(i) + ".example.com"}, jar)
    status, data, _ = self.api("/api/services", jar=jar)
    sid = data["services"][0]["id"]
    status, data, _ = self.api("/api/services/" + sid, "DELETE", jar=jar)
    self.assertEqual(status, 200)
    self.assertEqual(len(data["services"]), 1)
    self.assertNotEqual(data["services"][0]["id"], sid)

def test_delete_unknown_id_404(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    status, data, _ = self.api("/api/services/missing", "DELETE", jar=jar)
    self.assertEqual(status, 404)

def test_services_persist_across_restart(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    self.api("/api/services", "POST",
             {"name": "Jellyfin", "url": "https://media.example.com", "icon": "film"}, jar)
    srv2 = server.create_server("127.0.0.1", 0, user="alice", password="s3cret",
                                services_path=self.services_path)
    port2 = srv2.server_address[1]
    t2 = threading.Thread(target=srv2.serve_forever, daemon=True)
    t2.start()
    try:
        jar2 = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(jar2))
        urllib.request.urlopen(
            urllib.request.Request(
                "http://127.0.0.1:%d/login" % port2,
                data=urllib.parse.urlencode({"username": "alice", "password": "s3cret"}).encode(),
                method="POST")).close()
        with contextlib.closing(
                opener.open("http://127.0.0.1:%d/api/services" % port2)) as resp:
            data = json.loads(resp.read().decode())
        self.assertEqual(len(data["services"]), 1)
        self.assertEqual(data["services"][0]["name"], "Jellyfin")
    finally:
        srv2.shutdown()
        srv2.server_close()

def test_services_oversized_body_413(self):
    jar = http.cookiejar.CookieJar()
    self.login(jar)
    status, data, _ = self.api(
        "/api/services", "POST",
        {"name": "X" * 70000, "url": "https://x.example.com"}, jar)
    self.assertEqual(status, 413)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest test_server`
Expected: FAIL — `AttributeError: 'ServerHubTests' object has no attribute 'api'` or `TypeError: create_server() got an unexpected keyword argument 'services_path'`.

- [ ] **Step 3: Implement the server store + endpoints**

In `server.py`:

Add `import re` to the imports. Add after `MAX_LOGIN_BODY`:

```python
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


class ServiceStore:
    """Thread-safe JSON-backed service list. Atomic writes (tmp + os.replace)."""

    def __init__(self, path):
        self._path = path
        self._lock = threading.Lock()
        self._services = self._load()

    def _load(self):
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
            svcs = data.get("services", [])
            if not isinstance(svcs, list):
                return []
            return [s for s in svcs if isinstance(s, dict) and s.get("id")]
        except (OSError, ValueError):
            return []

    def _save(self):
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"services": self._services}, f, indent=2)
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
```

In `HubHandler`, add after `read_cookie`:

```python
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
```

Add helper methods on `HubHandler` for the API (place near the stats routes):

```python
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
```

Wire routes. In `do_GET`, after the `/api/stats` block, add:

```python
        if path == "/api/services":
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_services_list()
```

Restructure `do_POST` to handle both `/login` and `/api/services`. Replace the current `do_POST` with:

```python
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/services":
            user = self.session_user()
            if not user:
                return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
            return self._handle_services_create()
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
        if not m:
            return self.send_bytes("Not found", 404)
        user = self.session_user()
        if not user:
            return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
        return self._handle_services_update(m.group(1))

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/api/services/([^/]+)$", path)
        if not m:
            return self.send_bytes("Not found", 404)
        user = self.session_user()
        if not user:
            return self.send_bytes(json.dumps({"error": "unauthenticated"}), 401, "application/json; charset=utf-8")
        return self._handle_services_delete(m.group(1))
```

Update `HubServer.__init__` and `create_server`:

```python
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
```

Add to `.gitignore`:

```
services.json
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest test_server`
Expected: PASS — all existing 17 tests plus the new ones. Confirm `test_services_persist_across_restart` passes (validates file reload + atomic write).

Also verify no `services.json` was created in the repo root:
Run: `Get-ChildItem . -Filter services.json*` → expected no results (temp dir only).

- [ ] **Step 5: Commit**

```bash
git add server.py test_server.py .gitignore
git commit -m "feat: add persistent services store and CRUD API"
```

---

### Task 2: index.html — API-driven services, migration, add/remove → API

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes:
  - `GET /api/services` → `{ "services": [{id,name,url,desc,icon,ping,categoryOverride}] }`.
  - `POST /api/services` body `{name,url,desc,icon,ping,categoryOverride}` → updated `{ "services": [...] }`.
  - `DELETE /api/services/<id>` → updated `{ "services": [...] }`.
- Produces:
  - `const API_SERVICES = '/api/services'` and `const SERVICES_DEFAULT = []` (empty export kept for tests).
  - `async fetchServices() -> array` — GETs list, throws on failure.
  - `async migrateLegacyServices() -> bool` — pushes legacy localStorage entries to the API, clears local keys, returns whether any were pushed.
  - `async loadServices() -> array` — fetch + assign `SERVICES` + `renderGroups()`.
  - `async remove(id)` — confirm + DELETE + re-render.
  - `async addService(entry)` — POST + re-render (used by the add form).
  - `showToast(msg)` helper + `#toast` element.
  - `#api-offline` notice element (hidden by default).
  - `window.__HUB__` now exports `{ SERVICES, SERVICES_DEFAULT, renderGroups, filter, applyTheme, cycleTheme, remove, edit, closeEdit, saveEdit, loadServices, reloadServices, setServices, getSearchInput, autoCategorize, categorized, openIconPicker }`.

- [ ] **Step 1: Remove SERVICES_DEFAULT and switch to API state**

In `index.html`:

Replace the `SERVICES_DEFAULT` block (lines ~291-303) with:

```javascript
  /* ============================================================
     SERVICES — loaded from the server (services.json) via the API.
     No bundled defaults; everything is added through the UI and
     stored permanently on the server.
     ============================================================ */
  const SERVICES_DEFAULT = [];
  const API_SERVICES = '/api/services';
```

Replace the `loadServices` / `saveExtraServices` / `getExtraServices` block (lines ~344-372, including `const LS_SERVICES = ...` lines) with:

```javascript
  /* ============================================================
     State
     ============================================================ */
  const LS_SERVICES = 'server-hub:services'; // legacy key — migrated to server once

  let SERVICES = [];

  async function fetchServices() {
    const r = await fetch(API_SERVICES, { cache: 'no-store' });
    if (!r.ok) throw new Error('services api ' + r.status);
    const d = await r.json();
    return Array.isArray(d.services) ? d.services : [];
  }

  async function loadServices() {
    SERVICES = await fetchServices();
    renderGroups();
    return SERVICES;
  }

  async function migrateLegacyServices() {
    const legacyRaw = (() => {
      try { return JSON.parse((window.localStorage || localStorage).getItem(LS_SERVICES) || '[]'); }
      catch { return []; }
    })();
    const settingsServices = (window.HubSettings.get().services || []);
    const candidates = [...legacyRaw, ...settingsServices]
      .filter(s => s && s.name && s.url);
    if (!candidates.length) return false;
    let serverList;
    try { serverList = await fetchServices(); } catch { serverList = []; }
    const existing = new Set(serverList.map(s => s.url + '|' + s.name));
    let pushed = 0;
    for (const s of candidates) {
      const key = s.url + '|' + s.name;
      if (existing.has(key)) continue;
      existing.add(key);
      try {
        const r = await fetch(API_SERVICES, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: s.name, url: s.url, desc: s.desc || '',
            icon: s.icon || 'box', ping: s.ping !== false,
            categoryOverride: s.categoryOverride || null,
          }),
        });
        if (r.ok) pushed++;
      } catch {}
    }
    if (pushed > 0) {
      window.HubSettings.set({ services: [] });
      try { (window.localStorage || localStorage).removeItem(LS_SERVICES); } catch {}
    }
    return pushed > 0;
  }

  async function apiJson(method, url, body) {
    const opts = { method, cache: 'no-store' };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('request failed (' + r.status + ')');
    return r.json();
  }
```

Note: `SERVICES` is no longer initialized from `loadServices()` — change `let SERVICES = loadServices();` to `let SERVICES = [];`. Delete the old `let SERVICES = loadServices();` line.

- [ ] **Step 2: Add toast + offline notice elements**

In the HTML body, right before `<script>` (near the add-form block), add:

```html
  <!-- Toast -->
  <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>

  <!-- API offline notice -->
  <div id="api-offline" class="hidden fixed top-4 left-1/2 -translate-x-1/2 z-40 glass px-4 py-2 rounded-xl text-xs text-[color:var(--fg-muted)]">
    Can't reach the services API — showing saved list only. Edits won't persist until the server responds.
  </div>
```

In the `<style>` block, add near the `.glass` rules:

```css
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: var(--surface-hi); border: 1px solid var(--border-hi);
      color: var(--fg); padding: 0.55rem 1rem; border-radius: 12px;
      font-size: 0.8rem; box-shadow: 0 12px 32px -12px rgba(0,0,0,.5);
      z-index: 60; transition: opacity 200ms var(--ease);
    }
    .toast.hidden { opacity: 0; pointer-events: none; }
```

Add the `showToast` helper near `esc()`:

```javascript
  let toastT;
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), 2000);
  }
```

- [ ] **Step 3: Point the add form + remove at the API**

Replace the add-form submit handler (lines ~478-497) with:

```javascript
  async function addService(entry) {
    const data = await apiJson('POST', API_SERVICES, entry);
    SERVICES = Array.isArray(data.services) ? data.services : SERVICES;
    renderGroups();
  }

  addForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name = addName.value.trim();
    const url  = addUrl.value.trim();
    const desc = addDesc.value.trim();
    if (!name || !url) return;
    const result = window.autoCategorize(name, url, desc);
    const icon = pickIcon(result.category, name.toLowerCase());
    try {
      await addService({ name, url, desc, icon, ping: true, categoryOverride: result.category });
      addName.value = ''; addUrl.value = ''; addDesc.value = '';
      addPreview.textContent = '✓ Added to ' + result.category;
      setTimeout(() => addPreview.textContent = '', 2500);
    } catch (err) {
      addPreview.textContent = '✗ ' + err.message;
      setTimeout(() => addPreview.textContent = '', 2500);
      showToast('Failed to add link');
    }
  });
```

Replace the `remove` function (lines ~512-520) with:

```javascript
  /* ============================================================
     Remove (server-persisted)
     ============================================================ */
  async function remove(id) {
    if (!id) return;
    const svc = SERVICES.find(s => s.id === id);
    const name = svc ? svc.name : 'this link';
    if (!confirm('Delete "' + name + '"?')) return;
    try {
      const data = await apiJson('DELETE', API_SERVICES + '/' + encodeURIComponent(id));
      SERVICES = Array.isArray(data.services) ? data.services : SERVICES;
      renderGroups();
      showToast('Link deleted');
    } catch (err) {
      showToast('Failed to delete link');
    }
  }
```

- [ ] **Step 4: Async boot with migration**

Replace the boot block (lines ~714-717) with:

```javascript
  /* ============================================================
     Boot
     ============================================================ */
  (async function boot() {
    try {
      await migrateLegacyServices();           // pushes any legacy local links, clears local keys
      SERVICES = await fetchServices();        // always re-fetch the authoritative list after migration
      renderGroups();
    } catch {
      document.getElementById('api-offline').classList.remove('hidden');
      renderGroups();
    }
  })();
```

Update the `window.__HUB__` export (lines ~705-712) — remove `remove` old signature references, keep `edit`/`closeEdit`/`saveEdit`/`openIconPicker` (defined in Task 3), and make `reloadServices` async:

```javascript
  window.__HUB__ = {
    SERVICES, SERVICES_DEFAULT,
    renderGroups, filter, applyTheme, cycleTheme, remove,
    edit: openEditModal, closeEdit: closeEditModal,
    saveEdit: saveEditModal, openIconPicker: renderIconPicker,
    loadServices, reloadServices: loadServices,
    autoCategorize: (n,u,d) => window.autoCategorize(n,u,d),
    categorized, setServices: arr => { SERVICES = arr; },
    getSearchInput: () => searchInput,
  };
```

Note: this references `openEditModal`, `closeEditModal`, `saveEditModal`, `renderIconPicker` which are defined in Task 3 — the code won't run until then, but it must be present for the export to resolve at boot. Implement Task 3 next before running the page.

- [ ] **Step 5: Manual smoke test**

Run: `python server.py` with `HUB_PASSWORD` set (e.g. `$env:HUB_PASSWORD='x'; python server.py`). Login at `http://localhost:8642/`.
Expected: dashboard loads with an empty service grid; the "+ Add" form adds a link that persists across a page reload and is visible in `services.json` (check `Get-Content services.json`).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: load services from server API, migrate legacy local links"
```

---

### Task 3: index.html — hover edit/delete buttons + edit modal + icon picker

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes:
  - `SERVICES` array with `id` fields (from Task 2).
  - `renderGroups()` / `filter()` / `esc()` / `svgFor()` / `showToast()`.
  - `PUT /api/services/<id>` body `{name,url,desc,icon,ping,categoryOverride}` → updated `{ "services": [...] }`.
- Produces:
  - `.card-actions` hover-revealed container + `.card-action` buttons on every card.
  - `openEditModal(id)`, `closeEditModal()`, `saveEditModal()`, `renderIconPicker(currentIcon)`.
  - `#edit-modal` dialog with `#edit-name`, `#edit-url`, `#edit-desc`, `#edit-icons`, `#edit-cat` fields.

- [ ] **Step 1: CSS for hover actions + modal**

In the `<style>` block, replace the `.remove-btn` rules (lines ~145-147) with:

```css
    .card-actions { opacity: 0; transition: opacity 200ms var(--ease); }
    .card:hover .card-actions, .card:focus-within .card-actions { opacity: 1; }
    .card-action {
      color: var(--fg-muted); background: transparent; border: none; cursor: pointer;
      padding: 4px; border-radius: 8px; transition: color 150ms var(--ease), background-color 150ms var(--ease);
    }
    .card-action:hover { color: var(--fg); background: var(--surface-hi); }
    .card-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .icon-opt {
      padding: 6px; border-radius: 10px; border: 1px solid var(--border);
      color: var(--fg-muted); background: transparent; cursor: pointer; display: flex;
      align-items: center; justify-content: center;
      transition: color 150ms var(--ease), border-color 150ms var(--ease), background-color 150ms var(--ease);
    }
    .icon-opt:hover { color: var(--fg); border-color: var(--border-hi); }
    .icon-opt.selected { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 50; }
    .modal-panel {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(92vw, 420px); max-height: 88vh; overflow-y: auto;
      background: var(--surface); border: 1px solid var(--border-hi); border-radius: 18px;
      padding: 1.25rem; z-index: 51; box-shadow: 0 24px 64px -20px rgba(0,0,0,.6);
    }
```

- [ ] **Step 2: Card markup — hover actions on every card**

Replace `renderCard` (lines ~426-450) with:

```javascript
  const ICON_PENCIL = '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="m13.5 6.5 3 3"/>';
  const ICON_TRASH  = '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>';

  function renderCard(s) {
    const target = s.url.startsWith('http') ? s.url : 'https://' + s.url;
    const actions = s.id
      ? '<span class="card-actions flex gap-0.5 shrink-0 mt-1">'
          + '<button type="button" class="card-action" title="Edit" aria-label="Edit ' + esc(s.name) + '" '
          + 'onclick="event.preventDefault(); event.stopPropagation(); window.__HUB__.edit(\'' + esc(s.id) + '\')">'
          + '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICON_PENCIL + '</svg></button>'
          + '<button type="button" class="card-action" title="Delete" aria-label="Delete ' + esc(s.name) + '" '
          + 'onclick="event.preventDefault(); event.stopPropagation(); window.__HUB__.remove(\'' + esc(s.id) + '\')">'
          + '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICON_TRASH + '</svg></button>'
        + '</span>'
      : '';
    return '<a href="' + target + '" target="_blank" rel="noopener noreferrer" '
      + 'class="card reveal glass flex items-start gap-3 p-4 focus-ring cursor-pointer relative overflow-hidden" '
      + 'data-name="' + esc(s.name.toLowerCase()) + '" data-desc="' + esc((s.desc || '').toLowerCase()) + '" '
      + 'data-category="' + esc(s.category) + '" data-ping-url="' + (s.ping !== false ? esc(s.url) : '') + '" '
      + 'data-id="' + esc(s.id || '') + '">'
      + '<span class="accent-bar absolute left-0 top-0 h-full w-[3px] opacity-70" aria-hidden="true"></span>'
      + '<span class="shrink-0 mt-0.5 text-[color:var(--fg)]">' + svgFor(s.icon) + '</span>'
      + '<span class="min-w-0 flex-1">'
      + '<span class="flex items-center gap-2">'
      + '<span class="text-sm font-medium text-[color:var(--fg)] truncate">' + esc(s.name) + '</span>'
      + '<span class="status-dot status-idle" data-status role="img" aria-label="checking status"></span>'
      + '</span>'
      + '<span class="block text-xs text-[color:var(--fg-muted)] mt-0.5 truncate">' + esc(s.desc || '') + '</span>'
      + '<span class="block text-[11px] text-[color:var(--fg-muted)]/70 font-mono mt-1 truncate">' + esc(hostOf(s.url)) + '</span>'
      + '</span>'
      + actions
      + '</a>';
  }
```

- [ ] **Step 3: Edit modal markup**

In the HTML body, right before the main `<script>` (after the add-form block), add:

```html
  <!-- Edit modal -->
  <div id="edit-modal" class="hidden" role="dialog" aria-modal="true" aria-labelledby="edit-title">
    <div class="modal-backdrop" onclick="window.__HUB__.closeEdit()"></div>
    <div class="modal-panel space-y-3">
      <h2 id="edit-title" class="text-base font-semibold">Edit link</h2>
      <label class="block">
        <span class="text-xs text-[color:var(--fg-muted)]">Name</span>
        <input id="edit-name" class="form-input mt-1" placeholder="e.g. Grafana" />
      </label>
      <label class="block">
        <span class="text-xs text-[color:var(--fg-muted)]">URL</span>
        <input id="edit-url" class="form-input mt-1" type="url" placeholder="https://…" />
      </label>
      <label class="block">
        <span class="text-xs text-[color:var(--fg-muted)]">Description</span>
        <input id="edit-desc" class="form-input mt-1" placeholder="Optional" />
      </label>
      <div>
        <span class="text-xs text-[color:var(--fg-muted)]">Icon</span>
        <div id="edit-icons" class="grid grid-cols-6 gap-2 mt-1"></div>
      </div>
      <label class="block">
        <span class="text-xs text-[color:var(--fg-muted)]">Category</span>
        <select id="edit-cat" class="form-input mt-1">
          <option value="auto">Auto</option>
          <option value="Monitoring">Monitoring</option>
          <option value="Security">Security</option>
          <option value="Network">Network</option>
          <option value="Media">Media</option>
          <option value="Productivity">Productivity</option>
          <option value="Files">Files</option>
          <option value="Dev">Dev</option>
          <option value="Communication">Communication</option>
          <option value="Home">Home</option>
          <option value="Finance">Finance</option>
          <option value="AI">AI</option>
          <option value="Search">Search</option>
          <option value="Database">Database</option>
          <option value="Other">Other</option>
        </select>
      </label>
      <div class="flex justify-end gap-2 pt-1">
        <button id="edit-cancel" class="btn-ghost focus-ring" type="button">Cancel</button>
        <button id="edit-save" class="btn-primary focus-ring" type="button">Save</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 4: Edit modal logic**

Add after the `remove` function (before the Search filter section):

```javascript
  /* ============================================================
     Edit modal (hover edit button)
     ============================================================ */
  let editingId = null;
  let selectedIcon = 'box';

  const EDIT_CATEGORIES = ['Monitoring','Security','Network','Media','Productivity',
    'Files','Dev','Communication','Home','Finance','AI','Search','Database','Other'];

  function renderIconPicker(current) {
    selectedIcon = ICONS[current] ? current : 'box';
    const grid = document.getElementById('edit-icons');
    grid.innerHTML = '';
    for (const key of Object.keys(ICONS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-opt focus-ring' + (key === selectedIcon ? ' selected' : '');
      b.dataset.icon = key;
      b.title = key;
      b.innerHTML = svgFor(key, 'w-5 h-5');
      b.addEventListener('click', () => {
        selectedIcon = key;
        grid.querySelectorAll('.icon-opt').forEach(x => x.classList.toggle('selected', x === b));
      });
      grid.appendChild(b);
    }
  }

  function openEditModal(id) {
    const s = SERVICES.find(x => x.id === id);
    if (!s) return;
    editingId = id;
    document.getElementById('edit-name').value = s.name;
    document.getElementById('edit-url').value = s.url;
    document.getElementById('edit-desc').value = s.desc || '';
    renderIconPicker(s.icon);
    document.getElementById('edit-cat').value = s.categoryOverride || 'auto';
    document.getElementById('edit-modal').classList.remove('hidden');
    document.getElementById('edit-name').focus();
  }

  function closeEditModal() {
    editingId = null;
    document.getElementById('edit-modal').classList.add('hidden');
  }

  async function saveEditModal() {
    if (!editingId) return;
    const cur = SERVICES.find(s => s.id === editingId);
    const name = document.getElementById('edit-name').value.trim();
    const url  = document.getElementById('edit-url').value.trim();
    const desc = document.getElementById('edit-desc').value.trim();
    const cat  = document.getElementById('edit-cat').value;
    if (!name || !url) { showToast('Name and URL are required'); return; }
    try {
      const data = await apiJson('PUT', API_SERVICES + '/' + encodeURIComponent(editingId), {
        name, url, desc, icon: selectedIcon,
        ping: cur ? cur.ping !== false : true,
        categoryOverride: cat === 'auto' ? null : cat,
      });
      SERVICES = Array.isArray(data.services) ? data.services : SERVICES;
      closeEditModal();
      renderGroups();
      showToast('Link updated');
    } catch (err) {
      showToast('Failed to save link');
    }
  }

  document.getElementById('edit-save').addEventListener('click', saveEditModal);
  document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('edit-modal').classList.contains('hidden')) {
      closeEditModal();
    }
  });
```

Note: there is already a `document.addEventListener('keydown', ...)` for the search `/` shortcut earlier — this adds a second listener, which is fine.

- [ ] **Step 5: Verify hover actions + modal**

Run: `python server.py` with `HUB_PASSWORD` set; log in; add a link. Expected:
- Every card shows pencil + trash on hover (and on keyboard focus).
- Clicking pencil opens the modal prefilled with name/url/desc/icon/category.
- Icon grid highlights the current icon; clicking another selects it.
- Saving changes the card without a reload; changes persist in `services.json`.
- Clicking trash prompts confirm, deletes, re-renders, and removes from `services.json`.
- Clicking a card body (not the buttons) still opens the link in a new tab.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: hover edit/delete buttons with edit modal and icon picker"
```

---

### Task 4: settings.html — services editor → API

**Files:**
- Modify: `settings.html`

**Interfaces:**
- Consumes:
  - `GET /api/services`, `POST /api/services`, `PUT /api/services/<id>`, `DELETE /api/services/<id>` (same shapes as Task 1).
  - `window.autoCategorize(name, url, desc)`.
- Produces:
  - `let svcs = []` module-level current list.
  - `async loadServices()` — GET + `renderServices()`.
  - `async onEdit(e)` / `async onDelete(e)` / `async addNew()` — call API, update `svcs` from response, re-render.
  - `toast(msg)` unchanged.

- [ ] **Step 1: Repoint the services editor to the API**

Replace the services editor block (lines ~318-409) with:

```javascript
  /* ============================================================
     Services editor (server-persisted via /api/services)
     ============================================================ */
  const svcListEl = document.getElementById('svc-list');
  const addBtn    = document.getElementById('add-svc');
  const addForm   = document.getElementById('add-form');
  const newName   = document.getElementById('new-name');
  const newUrl    = document.getElementById('new-url');
  const newDesc   = document.getElementById('new-desc');
  const newCat    = document.getElementById('new-cat');
  const newSave   = document.getElementById('new-save');

  const API_SERVICES = '/api/services';
  let svcs = [];

  async function apiJson(method, url, body) {
    const opts = { method, cache: 'no-store' };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = 'request failed (' + r.status + ')';
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }

  async function loadServices() {
    try {
      svcs = (await apiJson('GET', API_SERVICES)).services || [];
    } catch {
      svcs = [];
    }
    renderServices();
  }

  function renderServices() {
    if (svcs.length === 0) {
      svcListEl.innerHTML = '<p class="text-xs text-[color:var(--fg-muted)] py-3">No links yet. Click “+ Add link”.</p>';
      return;
    }
    svcListEl.innerHTML = '';
    svcs.forEach((s, i) => {
      const auto = s.categoryOverride || window.autoCategorize(s.name, s.url, s.desc).category;
      const row = document.createElement('div');
      row.className = 'svc-row';
      row.innerHTML =
        '<input class="field focus-ring svc-name" data-i="' + i + '" value="' + esc(s.name) + '" placeholder="Name" />'
        + '<input class="field focus-ring svc-url"  data-i="' + i + '" value="' + esc(s.url) + '" placeholder="URL" />'
        + '<input class="field focus-ring svc-desc" data-i="' + i + '" value="' + esc(s.desc || '') + '" placeholder="Description" />'
        + '<span class="hide-sm text-xs text-[color:var(--fg-muted)]">→ <span class="pill">' + esc(auto) + '</span></span>'
        + '<button class="btn btn-danger focus-ring text-xs svc-del" data-i="' + i + '" aria-label="Delete ' + esc(s.name) + '">✕</button>';
      svcListEl.appendChild(row);
    });

    svcListEl.querySelectorAll('.svc-name').forEach(el => el.addEventListener('change', onEdit));
    svcListEl.querySelectorAll('.svc-url').forEach(el => {
      el.addEventListener('change', onEdit);
      el.addEventListener('input', e => {
        const i = +e.target.dataset.i;
        const sv = svcs[i];
        if (!sv) return;
        const autoCat = window.autoCategorize(sv.name, e.target.value, sv.desc).category;
        const pill = e.target.closest('.svc-row').querySelector('.pill');
        if (pill) pill.textContent = autoCat;
      });
    });
    svcListEl.querySelectorAll('.svc-desc').forEach(el => el.addEventListener('change', onEdit));
    svcListEl.querySelectorAll('.svc-del').forEach(el => el.addEventListener('click', onDelete));
  }

  async function onEdit(e) {
    const i = +e.target.dataset.i;
    const field = e.target.classList.contains('svc-name') ? 'name'
      : e.target.classList.contains('svc-url') ? 'url' : 'desc';
    const s = svcs[i];
    if (!s) return;
    s[field] = e.target.value.trim();
    try {
      svcs = (await apiJson('PUT', API_SERVICES + '/' + encodeURIComponent(s.id), {
        name: s.name, url: s.url, desc: s.desc || '', icon: s.icon || 'box',
        ping: s.ping !== false, categoryOverride: s.categoryOverride || null,
      })).services || svcs;
      toast('Saved');
    } catch (err) {
      toast('Save failed: ' + err.message);
    }
    if (field !== 'desc') renderServices();
  }

  async function onDelete(e) {
    const i = +e.currentTarget.dataset.i;
    const s = svcs[i];
    if (!s) return;
    if (!confirm('Delete "' + s.name + '"?')) return;
    try {
      svcs = (await apiJson('DELETE', API_SERVICES + '/' + encodeURIComponent(s.id))).services || svcs;
      renderServices();
      toast('Link removed');
    } catch (err) {
      toast('Delete failed: ' + err.message);
    }
  }

  addBtn.addEventListener('click', () => {
    const open = !addForm.classList.contains('hidden');
    addForm.classList.toggle('hidden');
    addBtn.textContent = open ? '+ Add link' : 'Cancel';
    if (!open) newName.focus();
  });
  [newName, newUrl, newDesc].forEach(el => el.addEventListener('input', () => {
    newCat.textContent = window.autoCategorize(newName.value, newUrl.value, newDesc.value).category;
  }));
  async function addNew() {
    const name = newName.value.trim();
    const url  = newUrl.value.trim();
    if (!name || !url) { toast('Name and URL required'); return; }
    const desc = newDesc.value.trim();
    const cat = window.autoCategorize(name, url, desc).category;
    try {
      svcs = (await apiJson('POST', API_SERVICES, {
        name, url, desc, icon: 'box', ping: true, categoryOverride: cat,
      })).services || svcs;
      newName.value = ''; newUrl.value = ''; newDesc.value = ''; newCat.textContent = 'auto';
      renderServices();
      toast('Link added to ' + cat);
    } catch (err) {
      toast('Add failed: ' + err.message);
    }
  }
  newSave.addEventListener('click', addNew);
  addForm.addEventListener('submit', e => { e.preventDefault(); addNew(); });

  loadServices();
```

Update the helper text under "Your links" (line ~191):

```html
      <p class="text-xs text-[color:var(--fg-muted)] mb-4">Links are stored permanently on the server (<code class="text-[color:var(--fg)]">services.json</code>) and shared across all devices.</p>
```

Update the Reset section (line ~211) — resetting settings no longer wipes links (they're server-side now):

```html
        <p class="text-sm text-[color:var(--fg-muted)] max-w-md">Wipe all settings (theme, accent, features). Links live on the server and are managed here.</p>
```

Also update the footer (line ~216-218) to remove the localStorage mention:

```html
    <footer class="pt-2 pb-8 text-center text-xs text-[color:var(--fg-muted)] font-mono">
      Links stored server-side in <code class="text-[color:var(--fg)]">services.json</code>. <a href="tests.html" class="underline hover:text-[color:var(--accent)]">Run tests</a>
    </footer>
```

- [ ] **Step 2: Verify settings editor**

Run: `python server.py` with `HUB_PASSWORD` set; log in; open `settings.html`. Expected:
- Existing server links appear in "Your links".
- Editing a name/url/desc and tabbing out saves (PUT) and persists after reload.
- Delete removes the link and persists.
- "+ Add link" adds and persists.
- The same links show on the dashboard (`index.html`).

- [ ] **Step 3: Commit**

```bash
git add settings.html
git commit -m "feat: repoint settings services editor to server API"
```

---

### Task 5: tests.html — deterministic API-stubbed DOM tests

**Files:**
- Modify: `tests.html`

**Interfaces:**
- Consumes:
  - `window.__HUB__` exports from Tasks 2-3: `reloadServices` (async), `setServices(arr)`, `renderGroups()`, `edit(id)`, `closeEdit()`, `saveEdit()`, `remove(id)` (async), `SERVICES_DEFAULT`.
  - `#edit-modal`, `#edit-name`, `#edit-icons`, `.card-action`, `.card` elements inside the iframe document.
- Produces: updated `runDomTests` (async) that stubs the iframe's `fetch` and asserts hover actions + edit modal + delete flow.

- [ ] **Step 1: Make the DOM test runner async and API-stubbed**

Replace the DOM test section (lines ~175-270) with:

```javascript
  /* ============================================================
     3. index.html — DOM behaviour (loaded in iframe)
     ============================================================ */
  group('index.html — DOM integration (iframe)');

  const iframe = document.createElement('iframe');
  iframe.src = 'index.html';
  iframe.style.cssText = 'position:fixed; bottom:0; right:0; width:480px; height:600px; opacity:0.6; border:1px solid #444; z-index:50;';
  iframe.id = 'hub';
  document.body.appendChild(iframe);

  let hubWin, runDomTests;
  iframe.addEventListener('load', () => {
    hubWin = iframe.contentWindow;
    runDomTests().then(finish).catch(e => {
      out('iframe DOM tests ran', false, String(e));
      finish();
    });
  });

  // Safety timeout in case iframe load never fires
  setTimeout(() => { if (!hubWin) { skip('iframe DOM tests', 'iframe did not load (open via http/file)'); finish(); } }, 4000);

  let finished = false;
  function finish() {
    if (finished) return; finished = true;
    summary.textContent =
      passed + ' passed · ' + failed + ' failed · ' + skipped + ' skipped '
      + (failed === 0 ? '— ✅ ALL GREEN' : '— ❌ FAILURES');
    summary.style.color = failed === 0 ? '#22C55E' : '#EF4444';
    if (window.__testAuto) console.log('done');
  }

  runDomTests = async function () {
    const w = hubWin;
    ok(typeof w.__HUB__ === 'object', '__HUB__ exported on index.html window');
    eq(w.__HUB__.SERVICES_DEFAULT, [], 'no bundled default services');

    // Stub the API so DOM behaviour is deterministic
    const CANNED = [
      { id: 'svc-1', name: 'Grafana',    url: 'https://grafana.example.com', desc: 'Metrics & dashboards',       icon: 'chart', ping: true,  categoryOverride: null },
      { id: 'svc-2', name: 'Uptime Kuma',url: 'https://status.example.com',  desc: 'Uptime & incident tracking', icon: 'pulse', ping: true,  categoryOverride: null },
      { id: 'svc-3', name: 'Jellyfin',   url: 'https://media.example.com',   desc: 'Movies & music streaming',   icon: 'film',  ping: true,  categoryOverride: null },
    ];
    let apiLog = [];
    function stubFetch(list) {
      w.fetch = (url, opts = {}) => {
        const method = opts.method || 'GET';
        apiLog.push(method + ' ' + url);
        const id = String(url).split('/').pop();
        if (method === 'GET' && String(url).includes('/api/services')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ services: list }) });
        }
        if (method === 'DELETE') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ services: list.filter(s => s.id !== id) }) });
        }
        if (method === 'POST') {
          const body = JSON.parse(opts.body);
          const created = { id: 'svc-new', ...body, categoryOverride: body.categoryOverride || null };
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ services: [...list, created] }) });
        }
        if (method === 'PUT') {
          const body = JSON.parse(opts.body);
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ services: list.map(s => s.id === id ? { ...s, ...body, id } : s) }) });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'nope' }) });
      };
    }

    // reloadServices fetches from the (stubbed) API
    stubFetch(CANNED);
    const fetched = await w.__HUB__.reloadServices();
    ok(Array.isArray(fetched) && fetched.length === CANNED.length,
       'reloadServices loads from /api/services', 'got ' + fetched.length);

    // Render fixture; every card must carry hover edit/delete buttons
    w.__HUB__.setServices(fetched);
    w.__HUB__.renderGroups();
    const cards = w.document.querySelectorAll('.card');
    ok(cards.length === fetched.length, 'rendered cards count == services', cards.length + ' vs ' + fetched.length);
    const withCat = w.document.querySelectorAll('.card[data-category]');
    ok(withCat.length === cards.length, 'every card tagged with category');
    ok(cards.length > 0 && cards[0].querySelector('.card-action[title="Edit"]'),
       'every card has an edit button');
    ok(cards.length > 0 && cards[0].querySelector('.card-action[title="Delete"]'),
       'every card has a delete button');

    // Search filter still works
    const input = w.__HUB__.getSearchInput();
    input.value = 'grafana';
    w.__HUB__.filter('grafana');
    const visible = Array.from(w.document.querySelectorAll('.card')).filter(c => c.style.display !== 'none');
    ok(visible.length === 1 && visible[0].dataset.name.includes('grafana'), 'search "grafana" narrows to 1', 'visible=' + visible.length);

    // Clear filter
    input.value = '';
    w.__HUB__.filter('');
    const allVisible = Array.from(w.document.querySelectorAll('.card')).filter(c => c.style.display !== 'none');
    ok(allVisible.length === fetched.length, 'clearing filter restores all cards', allVisible.length);

    // Theme still works
    w.document.documentElement.classList.remove('light', 'dark');
    w.HubSettings.set({ theme: 'light' });
    w.__HUB__.applyTheme('light');
    ok(w.document.documentElement.classList.contains('light'), 'applyTheme(light) adds html.light');
    w.__HUB__.applyTheme('dark');
    ok(w.document.documentElement.classList.contains('dark') && !w.document.documentElement.classList.contains('light'), 'applyTheme(dark) sets html.dark, removes light');

    // autoCategorize passthrough
    eq(w.__HUB__.autoCategorize('Jellyfin', 'https://media.local', 'Movies').category, 'Media', '__HUB__.autoCategorize passthrough');

    // Edit modal opens prefilled, icon grid renders, current icon selected
    w.confirm = () => true; // no native dialogs in tests
    w.__HUB__.edit('svc-1');
    const modal = w.document.getElementById('edit-modal');
    ok(modal && !modal.classList.contains('hidden'), 'edit button opens the modal');
    eq(w.document.getElementById('edit-name').value, 'Grafana', 'modal prefills name');
    eq(w.document.getElementById('edit-url').value, 'https://grafana.example.com', 'modal prefills url');
    const iconOpts = w.document.querySelectorAll('#edit-icons .icon-opt');
    ok(iconOpts.length > 0, 'icon picker grid rendered');
    ok(w.document.querySelector('#edit-icons .icon-opt.selected').dataset.icon === 'chart', 'current icon highlighted');

    // Save edit issues PUT and re-renders renamed card
    apiLog = [];
    stubFetch(CANNED);
    w.document.getElementById('edit-name').value = 'Grafana Ops';
    await w.__HUB__.saveEdit();
    ok(apiLog.some(x => x === 'PUT /api/services/svc-1'), 'save issues PUT to /api/services/<id>');
    ok(modal.classList.contains('hidden'), 'modal closes after save');
    const renamed = Array.from(w.document.querySelectorAll('.card')).some(c => c.dataset.name === 'grafana ops');
    ok(renamed, 'renamed card rendered after save');

    // Delete issues DELETE and re-renders
    apiLog = [];
    stubFetch(CANNED);
    await w.__HUB__.remove('svc-3');
    ok(apiLog.some(x => x === 'DELETE /api/services/svc-3'), 'remove issues DELETE to /api/services/<id>');
    const cardsAfter = w.document.querySelectorAll('.card');
    ok(cardsAfter.length === CANNED.length - 1, 'card removed after delete', 'got ' + cardsAfter.length);

    // Status dot exists on each pingable card
    const dots = w.document.querySelectorAll('.status-dot');
    ok(dots.length > 0, 'status dots present on cards');

    // Restore default state for any subsequent test runs
    w.HubSettings.set({ theme: 'auto', features: {}, services: [] });
  };
```

Note: delete assertions use `CANNED` (3 items) because `stubFetch(CANNED)` resets the list each call; `remove('svc-3')` then deletes from that 3-item snapshot. The rename test renders from the PUT response, so the card list is re-rendered from the stub's 3-item base each time — assertions stay deterministic.

- [ ] **Step 2: Run the DOM suite**

Serve the project and run tests:
- Run `python server.py` with `HUB_PASSWORD` set, log in, open `/tests.html` (or open `tests.html` directly via a static server / file double-click).
Expected: ALL GREEN — categorize 32 + settings 21 + DOM ~22 assertions.
- Sanity-check in the headless harness (Windows): use the jsdom harness with `beforeParse` polyfilling `matchMedia` + `fetch`, and injecting the same polyfills into the served `index.html` so the iframe boot doesn't crash.

- [ ] **Step 3: Commit**

```bash
git add tests.html
git commit -m "test: stub services API in DOM suite, cover hover edit/delete"
```

---

### Task 6: docs — README + SETUP-LXC

**Files:**
- Modify: `README.md`
- Modify: `SETUP-LXC.md`

**Interfaces:**
- Consumes: `services.json` behavior, `/api/services` endpoints, `HUB_PASSWORD` env requirement.

- [ ] **Step 1: Update README.md**

In the "Customizing" section, replace the "Default services" bullet:

```markdown
- **Services** — added via the "+ Add" form on the dashboard or in `settings.html` → "Your links". Every link is stored permanently on the server in `services.json` (next to `server.py`) and shared across all devices. Edit a link (name / URL / description / icon / category) or delete it via the pencil / trash buttons that appear when you hover a card.
```

Update the "Known limits" bullets — replace the localStorage bullet:

```markdown
- Adding, editing, and deleting services requires the server (`server.py`) to be running and you to be signed in — the links live in `services.json` on the server, not in your browser. If the API is unreachable, the dashboard shows an empty grid.
```

And add an API note:

```markdown
- Service CRUD API: `GET|POST /api/services`, `PUT|DELETE /api/services/<id>` (authenticated). Back up `services.json` with your other server data.
```

- [ ] **Step 2: Update SETUP-LXC.md**

Add a "Services data" note in the deployment section:

```markdown
### Services data

Added links are stored in `services.json` in the same directory as `server.py` (`/srv/server-hub/services.json`). It is created on first write and is **not** part of the git repo — `git pull` will never overwrite it. Back it up alongside your other VPS data; if you ever rebuild the container, copy it back before starting `server-hub`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md SETUP-LXC.md
git commit -m "docs: document server-persisted services and API"
```

---

## Self-review notes

- **Spec coverage:** storage+API (Task 1), migration + no-cache fallback + async load (Task 2), hover edit/delete + modal + icon picker (Task 3), settings.html repoint (Task 4), server CRUD tests + DOM hover/edit/delete tests (Tasks 1 & 5), docs (Task 6). The spec's "failure keeps last good list" is honored: `SERVICES` only changes on 2xx responses; `renderGroups()` always works off the current `SERVICES`.
- **Type consistency:** `openEditModal`/`closeEditModal`/`saveEditModal`/`renderIconPicker` are defined in Task 3 and referenced in Task 2's `__HUB__` export — Tasks 2 and 3 both modify `index.html` and must land together before the page runs. `reloadServices` is async everywhere it's used (Task 2 export, Task 5 tests). `validate_service(data, partial)` matches all call sites.
- **Placeholder scan:** no TBD/TODO; every step has concrete code.

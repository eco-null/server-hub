import contextlib
import http.cookiejar
import http.client
import http.server
import json
import os
import tempfile
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

    def tearDown(self):
        server.guard.reset("127.0.0.1")
        for svc in self.httpd.services.list():
            self.httpd.services.delete(svc["id"])
        for bm in self.httpd.services.list_bookmarks():
            self.httpd.services.delete_bookmark(bm["id"])

    def request(self, path, method="GET", data=None, jar=None):
        if jar is None:
            jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(jar)
        )
        body = urllib.parse.urlencode(data).encode() if data else None
        req = urllib.request.Request(self.base + path, data=body, method=method)
        try:
            with contextlib.closing(opener.open(req)) as resp:
                return resp.status, dict(resp.headers), resp.read(), jar
        except urllib.error.HTTPError as e:
            with contextlib.closing(e):
                return e.code, dict(e.headers), e.read(), jar

    def raw_post(self, extra_headers):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        try:
            conn.putrequest("POST", "/login")
            for key, value in extra_headers:
                conn.putheader(key, value)
            conn.endheaders()
            resp = conn.getresponse()
            try:
                resp.read()
                return resp.status
            finally:
                resp.close()
        finally:
            conn.close()

    def login(self, jar, username="alice", password="s3cret"):
        return self.request("/login", "POST", {"username": username, "password": password}, jar)

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
        set_cookie = headers["Set-Cookie"]
        for attr in ("HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"):
            self.assertIn(attr, set_cookie, attr)

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

    def test_api_stats_rejects_anonymous(self):
        status, _, _, _ = self.request("/api/stats")
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
        status, _, _, _ = self.request("/../server.py", jar=jar)
        self.assertEqual(status, 403)

    def test_missing_file_returns_404(self):
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, _, _, _ = self.request("/nonexistent.html", jar=jar)
        self.assertEqual(status, 404)

    def test_login_body_over_limit_returns_413(self):
        status, _, _, _ = self.request(
            "/login", "POST", {"username": "u" * 70000, "password": "p"}
        )
        self.assertEqual(status, 413)

    def test_login_malformed_content_length_returns_400(self):
        status = self.raw_post([("Content-Length", "banana")])
        self.assertEqual(status, 400)

    def test_login_negative_content_length_returns_400(self):
        status = self.raw_post([("Content-Length", "-5")])
        self.assertEqual(status, 400)

    def test_lockout_after_five_failures(self):
        server.guard.reset("127.0.0.1")
        jar = http.cookiejar.CookieJar()
        for _ in range(5):
            self.login(jar, password="bad")
        status, headers, _, _ = self.login(jar)
        self.assertEqual(status, 302)
        self.assertIn("error=locked", headers["Location"])

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
            try:
                opener.open(urllib.request.Request(
                    "http://127.0.0.1:%d/login" % port2,
                    data=urllib.parse.urlencode({"username": "alice", "password": "s3cret"}).encode(),
                    method="POST"))
            except urllib.error.HTTPError as e:
                with contextlib.closing(e):
                    e.read()
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

    def test_bookmarks_crud(self):
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, data, _ = self.api("/api/bookmarks", jar=jar)
        self.assertEqual(status, 200)
        self.assertEqual(data["bookmarks"], [])
        status, data, _ = self.api("/api/bookmarks", "POST",
                                   {"name": "YouTube", "url": "https://youtube.com", "icon": "youtube"}, jar)
        self.assertEqual(status, 200)
        self.assertEqual(len(data["bookmarks"]), 1)
        bid = data["bookmarks"][0]["id"]
        status, data, _ = self.api("/api/bookmarks/" + bid, "PUT", {"name": "Kick"}, jar)
        self.assertEqual(status, 200)
        self.assertEqual(data["bookmarks"][0]["name"], "Kick")
        status, data, _ = self.api("/api/bookmarks/" + bid, "DELETE", jar=jar)
        self.assertEqual(status, 200)
        self.assertEqual(data["bookmarks"], [])

    def test_bookmarks_require_auth(self):
        status, _, _, _ = self.request("/api/bookmarks")
        self.assertEqual(status, 401)


class ServiceStoreBookmarks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = server.ServiceStore(os.path.join(self.tmp.name, "services.json"))
        self.addCleanup(self.tmp.cleanup)

    def test_load_missing_bookmarks_defaults_empty(self):
        # write a services-only file, then confirm bookmarks load as []
        with open(self.store._path, "w") as f:
            json.dump({"services": []}, f)
        s2 = server.ServiceStore(self.store._path)
        self.assertEqual(s2.list_bookmarks(), [])

    def test_bookmark_crud(self):
        b = self.store.add_bookmark({"name": "YouTube", "url": "https://youtube.com", "icon": "youtube"})
        self.assertIn("id", b)
        self.assertEqual(self.store.list_bookmarks()[0]["name"], "YouTube")
        upd = self.store.update_bookmark(b["id"], {"name": "Kick"})
        self.assertEqual(upd["name"], "Kick")
        self.assertEqual(self.store.list_bookmarks()[0]["name"], "Kick")
        self.assertTrue(self.store.delete_bookmark(b["id"]))
        self.assertEqual(self.store.list_bookmarks(), [])


class BeszelStubHandler(http.server.BaseHTTPRequestHandler):
    """Minimal PocketBase-like stub for Beszel."""
    fail = False
    auth_hits = 0
    last_auth = ""

    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        BeszelStubHandler.auth_hits += 1
        if BeszelStubHandler.fail:
            return self._send_json({"error": "boom"}, 500)
        return self._send_json({"token": "tok123"})

    def do_GET(self):
        BeszelStubHandler.last_auth = self.headers.get("Authorization", "")
        if BeszelStubHandler.fail:
            return self._send_json({"error": "boom"}, 500)
        return self._send_json({"items": [
            {"name": "casaos", "status": "up", "stat_cpu": 42.0, "stat_mem": 55.0, "stat_disk": 61.0},
        ]})


class BeszelStub:
    """Minimal PocketBase-like stub for Beszel."""
    def __init__(self):
        self.handler = BeszelStubHandler

    def start(self):
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self.handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        return "http://127.0.0.1:%d" % self.srv.server_address[1]

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()


class BeszelTests(unittest.TestCase):
    """End-to-end tests for the Beszel proxy endpoint using a stub Beszel server."""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.TemporaryDirectory()
        cls.services_path = os.path.join(cls.tmpdir.name, "services.json")
        cls.httpd = server.create_server(
            "127.0.0.1", 0, user="alice", password="s3cret", services_path=cls.services_path)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmpdir.cleanup()

    def setUp(self):
        self._beszel_env = {k: os.environ.get(k) for k in (
            "BESZEL_URL", "BESZEL_USER", "BESZEL_PASSWORD", "BESZEL_API_KEY")}
        for k in self._beszel_env:
            os.environ.pop(k, None)
        BeszelStubHandler.fail = False
        BeszelStubHandler.auth_hits = 0
        BeszelStubHandler.last_auth = ""
        self._stubs = []
        server.clear_beszel_cache()

    def tearDown(self):
        for stub in self._stubs:
            stub.stop()
        BeszelStubHandler.fail = False
        server.clear_beszel_cache()
        for k, v in self._beszel_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def start_beszel(self):
        stub = BeszelStub()
        url = stub.start()
        self._stubs.append(stub)
        return url

    def request(self, path, method="GET", data=None, jar=None):
        if jar is None:
            jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(jar))
        body = urllib.parse.urlencode(data).encode() if data else None
        req = urllib.request.Request(self.base + path, data=body, method=method)
        try:
            with contextlib.closing(opener.open(req)) as resp:
                return resp.status, dict(resp.headers), resp.read(), jar
        except urllib.error.HTTPError as e:
            with contextlib.closing(e):
                return e.code, dict(e.headers), e.read(), jar

    def login(self, jar):
        return self.request("/login", "POST", {"username": "alice", "password": "s3cret"}, jar)

    def api(self, path, jar=None):
        if jar is None:
            jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(jar))
        req = urllib.request.Request(self.base + path, method="GET")
        try:
            with contextlib.closing(opener.open(req)) as resp:
                return resp.status, json.loads(resp.read().decode() or "{}"), jar
        except urllib.error.HTTPError as e:
            with contextlib.closing(e):
                return e.code, json.loads(e.read().decode() or "{}"), jar

    def test_beszel_requires_auth(self):
        status, _, _ = self.api("/api/beszel")
        self.assertEqual(status, 401)

    def test_beszel_disabled_when_unconfigured(self):
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, data, _ = self.api("/api/beszel", jar=jar)
        self.assertEqual(status, 200)
        self.assertEqual(data, {"enabled": False})

    def test_beszel_returns_normalized_systems(self):
        url = self.start_beszel()
        os.environ["BESZEL_URL"] = url
        os.environ["BESZEL_USER"] = "admin@beszel"
        os.environ["BESZEL_PASSWORD"] = "secret"
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, data, _ = self.api("/api/beszel", jar=jar)
        self.assertEqual(status, 200)
        self.assertEqual(data, {
            "enabled": True,
            "systems": [{"name": "casaos", "cpu": 42.0, "mem": 55.0, "disk": 61.0, "status": "up"}],
        })

    def test_beszel_error_when_stub_returns_500(self):
        url = self.start_beszel()
        os.environ["BESZEL_URL"] = url
        os.environ["BESZEL_USER"] = "admin@beszel"
        os.environ["BESZEL_PASSWORD"] = "secret"
        BeszelStubHandler.fail = True
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, data, _ = self.api("/api/beszel", jar=jar)
        self.assertEqual(status, 200)
        self.assertTrue(data["enabled"])
        self.assertIn("error", data)

    def test_beszel_api_key_skips_login(self):
        url = self.start_beszel()
        os.environ["BESZEL_URL"] = url
        os.environ["BESZEL_API_KEY"] = "key123"
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, data, _ = self.api("/api/beszel", jar=jar)
        self.assertEqual(status, 200)
        self.assertTrue(data["enabled"])
        self.assertEqual(BeszelStubHandler.auth_hits, 0)
        self.assertEqual(BeszelStubHandler.last_auth, "Bearer key123")

    def test_beszel_caches_within_ttl(self):
        url = self.start_beszel()
        os.environ["BESZEL_URL"] = url
        os.environ["BESZEL_USER"] = "admin@beszel"
        os.environ["BESZEL_PASSWORD"] = "secret"
        jar = http.cookiejar.CookieJar()
        self.login(jar)
        status, data, _ = self.api("/api/beszel", jar=jar)
        self.assertTrue(data["enabled"])
        BeszelStubHandler.fail = True
        status, data, _ = self.api("/api/beszel", jar=jar)
        self.assertEqual(status, 200)
        self.assertTrue(data["enabled"])
        self.assertEqual(data["systems"][0]["name"], "casaos")


if __name__ == "__main__":
    unittest.main()

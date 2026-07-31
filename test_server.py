import contextlib
import http.cookiejar
import http.client
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


if __name__ == "__main__":
    unittest.main()

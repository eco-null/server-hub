import contextlib
import http.cookiejar
import http.client
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

    def tearDown(self):
        server.guard.reset("127.0.0.1")

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


if __name__ == "__main__":
    unittest.main()

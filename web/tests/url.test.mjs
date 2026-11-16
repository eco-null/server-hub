import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, hostOf, splitScheme, buildServiceUrl, serviceFormUrl, withScheme, cssUrl, hasCredentials } from '../static/js/lib/url.js';

test('safeUrl accepts only http(s)', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('  http://example.com  '), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://x.example.com', '//example.com', '/relative', 'example.com', '', '   ', null, undefined, 42, {}]) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
});

test('safeUrl rejects absurdly long and malformed input', () => {
  assert.equal(safeUrl('https://example.com/' + 'a'.repeat(2100)), null);
  assert.equal(safeUrl('https://'), null);
  assert.equal(safeUrl('https://exa mple.com'), null);
  assert.equal(safeUrl('https://example.com/a b'), null);
  assert.equal(safeUrl('https://example.com/\u0001'), null);
});

test('safeUrl httpsOnly', () => {
  assert.equal(safeUrl('http://example.com', { httpsOnly: true }), null);
  assert.equal(safeUrl('https://example.com', { httpsOnly: true }), 'https://example.com/');
});

test('hostOf handles scheme-less input', () => {
  assert.equal(hostOf('https://grafana.home.arpa:3000/x'), 'grafana.home.arpa:3000');
  assert.equal(hostOf('grafana.home.arpa'), 'grafana.home.arpa');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('splitScheme', () => {
  assert.deepEqual(splitScheme('http://a.example.com'), { scheme: 'http://', rest: 'a.example.com' });
  assert.deepEqual(splitScheme('HTTPS://a.example.com'), { scheme: 'https://', rest: 'a.example.com' });
  assert.deepEqual(splitScheme('a.example.com'), { scheme: null, rest: 'a.example.com' });
});

test('buildServiceUrl expands bare hosts with the default domain', () => {
  assert.equal(buildServiceUrl('https://', 'grafana', 'home.arpa'), 'https://grafana.home.arpa');
  assert.equal(buildServiceUrl('https://', 'grafana', '.home.arpa'), 'https://grafana.home.arpa');
  assert.equal(buildServiceUrl('http://', 'grafana/dash', 'home.arpa'), 'http://grafana.home.arpa/dash');
  assert.equal(buildServiceUrl('https://', 'grafana', ''), 'https://grafana');
});

test('buildServiceUrl leaves real hosts alone', () => {
  assert.equal(buildServiceUrl('https://', 'nas.example.com', 'home.arpa'), 'https://nas.example.com');
  assert.equal(buildServiceUrl('https://', '192.168.1.5:8080', 'home.arpa'), 'https://192.168.1.5:8080');
  assert.equal(buildServiceUrl('https://', 'localhost', 'home.arpa'), 'https://localhost');
  assert.equal(buildServiceUrl('https://', 'host:3000', 'home.arpa'), 'https://host:3000');
});

test('serviceFormUrl: saving an edit never rewrites an unchanged single-label address', () => {
  // Editing only the name or description of "http://nas" used to save "http://nas.home.arpa".
  assert.equal(serviceFormUrl('http://', 'nas', 'home.arpa', 'nas'), 'http://nas');
  assert.equal(serviceFormUrl('https://', 'nas', 'home.arpa', 'nas'), 'https://nas', 'the scheme select still applies');
  // A changed address is expanded as before, and so is a new form.
  assert.equal(serviceFormUrl('http://', 'nas2', 'home.arpa', 'nas'), 'http://nas2.home.arpa');
  assert.equal(serviceFormUrl('http://', 'nas', 'home.arpa', null), 'http://nas.home.arpa');
  // A prefilled draft without an address: what the user types is expanded.
  assert.equal(serviceFormUrl('http://', 'grafana', 'home.arpa', ''), 'http://grafana.home.arpa');
});

test('buildServiceUrl: a typed scheme beats the select', () => {
  assert.equal(buildServiceUrl('https://', 'http://nas.example.com', ''), 'http://nas.example.com');
  assert.equal(buildServiceUrl('https://', '   ', 'home.arpa'), '');
});

test('withScheme', () => {
  assert.equal(withScheme('example.com'), 'https://example.com');
  assert.equal(withScheme('http://example.com'), 'http://example.com');
  assert.equal(withScheme('  '), '');
});

test('cssUrl escapes characters that could end the url() token', () => {
  assert.equal(cssUrl('https://img.example.com/a.jpg'), 'url("https://img.example.com/a.jpg")');
  const u = cssUrl('https://img.example.com/a(1).jpg?x="y"');
  assert.ok(u.startsWith('url("') && u.endsWith('")'));
  assert.ok(!u.slice(5, -2).includes('"'));
  assert.ok(!u.slice(5, -2).includes('('));
  assert.ok(!u.slice(5, -2).includes(')'));
  assert.equal(cssUrl('http://img.example.com/a.jpg'), null, 'CSP only allows https images');
  assert.equal(cssUrl('javascript:alert(1)'), null);
  assert.equal(cssUrl(''), null);
});

test('hasCredentials: user info in a service address', () => {
  assert.equal(hasCredentials('https://user:pass@nas.lan/app'), true);
  assert.equal(hasCredentials('http://user@nas.lan'), true);
  assert.equal(hasCredentials(buildServiceUrl('https://', 'admin:secret@grafana.example.com:3000')), true);
  assert.equal(hasCredentials('https://nas.lan/a@b'), false);
  assert.equal(hasCredentials('https://nas.lan:8080/?u=a:b@c'), false);
  assert.equal(hasCredentials('not a url'), false);
  assert.equal(hasCredentials(''), false);
});

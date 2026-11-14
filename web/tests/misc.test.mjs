import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseShortcut } from '../static/js/lib/hotkeys.js';
import { balancedColumns, columnsFor } from '../static/js/lib/layout.js';
import { buildSearchUrl, rankServices, hostLabels } from '../static/js/lib/search.js';
import { formatUptime, clampPct, loadLevel, greetingFor, formatClock } from '../static/js/lib/format.js';
import { contrast, ensureContrast, readableOn, isHex, rgba } from '../static/js/lib/color.js';

test('shortcuts ignore Ctrl/Meta/Alt (Ctrl+F must stay the browser find)', () => {
  const plain = { target: { tagName: 'BODY' } };
  assert.equal(canUseShortcut(plain), true);
  assert.equal(canUseShortcut({ ...plain, ctrlKey: true }), false);
  assert.equal(canUseShortcut({ ...plain, metaKey: true }), false);
  assert.equal(canUseShortcut({ ...plain, altKey: true }), false);
});

test('shortcuts ignore form controls, editable areas, modals and IME', () => {
  for (const tagName of ['INPUT', 'textarea', 'SELECT']) assert.equal(canUseShortcut({ target: { tagName } }), false, tagName);
  assert.equal(canUseShortcut({ target: { tagName: 'DIV', isContentEditable: true } }), false);
  assert.equal(canUseShortcut({ target: { tagName: 'BODY' } }, { modalOpen: true }), false);
  assert.equal(canUseShortcut({ target: { tagName: 'BODY' }, isComposing: true }), false);
  assert.equal(canUseShortcut({ target: { tagName: 'BODY' }, defaultPrevented: true }), false);
});

test('buildSearchUrl: every provider, encoding and fallbacks', () => {
  assert.equal(buildSearchUrl({ provider: 'google' }, 'a b&c'), 'https://www.google.com/search?q=a%20b%26c');
  assert.equal(buildSearchUrl({ provider: 'duckduckgo' }, 'x'), 'https://duckduckgo.com/?q=x');
  assert.equal(buildSearchUrl({ provider: 'bing' }, 'x'), 'https://www.bing.com/search?q=x');
  assert.equal(buildSearchUrl({ provider: 'startpage' }, 'x'), 'https://www.startpage.com/sp/search?query=x');
  assert.equal(buildSearchUrl({ provider: 'searxng', searxngUrl: 'https://searx.example.com/' }, 'x y'), 'https://searx.example.com/search?q=x+y');
  // invalid SearXNG url, unknown provider, missing settings -> Google
  assert.equal(buildSearchUrl({ provider: 'searxng', searxngUrl: 'javascript:alert(1)' }, 'x'), 'https://www.google.com/search?q=x');
  assert.equal(buildSearchUrl({ provider: 'searxng', searxngUrl: '' }, 'x'), 'https://www.google.com/search?q=x');
  assert.equal(buildSearchUrl({ provider: 'toString' }, 'x'), 'https://www.google.com/search?q=x');
  assert.equal(buildSearchUrl(undefined, 'x'), 'https://www.google.com/search?q=x');
});

test('rankServices: all words must match, name matches first', () => {
  const svcs = [
    { name: 'Notes', description: 'grafana notes', url: 'https://n.example.com' },
    { name: 'Grafana', description: 'metrics', url: 'https://g.example.com' },
    { name: 'Gitea', description: '', url: 'https://git.example.com' },
  ];
  assert.deepEqual(rankServices(svcs, 'gra').map((s) => s.name), ['Grafana', 'Notes']);
  assert.deepEqual(rankServices(svcs, 'graf metrics').map((s) => s.name), ['Grafana']);
  assert.deepEqual(rankServices(svcs, 'zzz'), []);
  assert.equal(rankServices(svcs, '').length, 3);
  assert.equal(rankServices(svcs, '', 2).length, 2);
});

test('rankServices: tiers are name prefix > name word > name substring > host or description', () => {
  const svc = (name, description = '', host = 'x.example.com') => ({ name, description, url: 'https://' + host });
  const svcs = [
    svc('Alpha', 'a reverse proxy for apps'),
    svc('Photo Proxy'),
    svc('Reproduce'),
    svc('Proxmox'),
    svc('Beta', '', 'proxy.example.com'),
  ];
  assert.deepEqual(
    rankServices(svcs, 'pro').map((s) => s.name),
    ['Proxmox', 'Photo Proxy', 'Reproduce', 'Beta', 'Alpha'],
  );
});

test('rankServices: no loose or domain-suffix matches', () => {
  const svcs = [
    { name: 'Nextcloud', description: 'Files, calendar and contacts', url: 'https://nextcloud.home.arpa' },
    { name: 'Proxmox', description: '', url: 'https://proxmox.home.arpa:8006' },
    { name: 'Paperless', description: '', url: 'https://paperless.home.arpa' },
  ];
  // "pro" is a subsequence of home.arpa-based strings and a prefix of the Productivity category, but not a match.
  assert.deepEqual(rankServices(svcs, 'pro').map((s) => s.name), ['Proxmox']);
  assert.deepEqual(rankServices(svcs, 'arpa'), []);
  assert.deepEqual(rankServices(svcs, 'home'), []);
  assert.deepEqual(rankServices(svcs, 'ncd'), [], 'no subsequence matching');
  assert.deepEqual(rankServices(svcs, 'nxtcld'), []);
  assert.deepEqual(rankServices(svcs, 'prod').map((s) => s.name), ['Nextcloud', 'Paperless'], 'a 4-letter category prefix still works');
  assert.deepEqual(rankServices(svcs, 'cloud').map((s) => s.name), ['Nextcloud'], 'name substring');
  assert.deepEqual(rankServices(svcs, 'calendar').map((s) => s.name), ['Nextcloud'], 'description word');
});

test('rankServices: unicode names and multi-word queries', () => {
  const svcs = [
    { name: 'Überwachung', description: '', url: 'https://u.example.com' },
    { name: 'Home Assistant', description: '', url: 'https://ha.example.com' },
    { name: 'خادم الملفات', description: '', url: 'https://f.example.com' },
  ];
  assert.deepEqual(rankServices(svcs, 'über').map((s) => s.name), ['Überwachung']);
  assert.deepEqual(rankServices(svcs, 'ass home').map((s) => s.name), ['Home Assistant']);
  assert.deepEqual(rankServices(svcs, 'الملفات').map((s) => s.name), ['خادم الملفات']);
});

test('hostLabels drops the domain suffix and the port', () => {
  assert.deepEqual(hostLabels('nextcloud.home.arpa'), ['nextcloud']);
  assert.deepEqual(hostLabels('a.b.example.com:8443'), ['a', 'b']);
  assert.deepEqual(hostLabels('github.com'), ['github']);
  assert.deepEqual(hostLabels('192.168.1.4:8080'), ['192.168.1.4']);
  assert.deepEqual(hostLabels('nas'), ['nas']);
  assert.deepEqual(hostLabels(''), []);
});

test('balancedColumns avoids a lone item in the last row', () => {
  assert.equal(balancedColumns(4, 3), 2, '4 services with room for 3 give 2 x 2');
  assert.equal(balancedColumns(4, 4), 4);
  assert.equal(balancedColumns(4, 6), 4, 'one row when everything fits');
  assert.equal(balancedColumns(5, 3), 3);
  assert.equal(balancedColumns(5, 4), 3);
  assert.equal(balancedColumns(7, 6), 4);
  assert.equal(balancedColumns(9, 4), 3);
  assert.equal(balancedColumns(10, 3), 2);
  assert.equal(balancedColumns(13, 3) >= 2, true, 'an orphan that cannot be avoided stays harmless');
  assert.equal(balancedColumns(2, 3), 2);
  assert.equal(balancedColumns(1, 3), 1);
  assert.equal(balancedColumns(0, 3), 1);
  assert.equal(balancedColumns(8, 1), 1);
  assert.equal(balancedColumns(8, 0), 1);
  assert.equal(balancedColumns(8, NaN), 1);
  for (let n = 1; n <= 60; n++) {
    for (let m = 1; m <= 8; m++) {
      const c = balancedColumns(n, m);
      assert.ok(c >= 1 && c <= Math.max(1, m), `${n}/${m}`);
      if (n > m && c > 1 && n % c === 1) {
        // an orphan is only allowed when no column count in 2..m avoids it
        for (let k = 2; k <= m; k++) assert.ok(n % k === 1, `${n} items, max ${m}: ${c} columns leave an orphan but ${k} would not`);
      }
    }
  }
});

test('columnsFor counts the columns that fit', () => {
  assert.equal(columnsFor(240, 240, 12), 1);
  assert.equal(columnsFor(492, 240, 12), 2);
  assert.equal(columnsFor(491, 240, 12), 1);
  assert.equal(columnsFor(0, 240, 12), 1);
  assert.equal(columnsFor(1000, 0, 12), 1);
});

test('format helpers', () => {
  assert.equal(formatUptime(30), '30s');
  assert.equal(formatUptime(90), '1m 30s');
  assert.equal(formatUptime(3600), '1h');
  assert.equal(formatUptime(3 * 86400 + 4 * 3600), '3d 4h');
  assert.equal(formatUptime(null), '');
  assert.equal(formatUptime(0.2), '');
  assert.equal(clampPct(120), 100);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(NaN), null);
  assert.equal(clampPct('5'), null);
  assert.equal(loadLevel(74.9), 'ok');
  assert.equal(loadLevel(75), 'warn');
  assert.equal(loadLevel(89.9), 'warn');
  assert.equal(loadLevel(90), 'crit');
  assert.equal(loadLevel(null), 'ok');
  assert.equal(greetingFor(3), 'Good night');
  assert.equal(greetingFor(9), 'Good morning');
  assert.equal(greetingFor(14), 'Good afternoon');
  assert.equal(greetingFor(21), 'Good evening');
  assert.equal(formatClock(new Date(2026, 0, 1, 7, 5, 9)), '07:05:09');
});

test('colour helpers: contrast guarantees for any accent', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01);
  assert.equal(readableOn('#EAB308'), '#0b0f19', 'yellow accent gets dark button text');
  assert.equal(readableOn('#5E6AD2'), '#ffffff');
  for (const accent of ['#EAB308', '#22C55E', '#5E6AD2', '#F97316', '#EC4899', '#64748B', '#ffffff', '#000000']) {
    for (const bg of ['#080b12', '#f3f6fb', '#ffffff', '#111827']) {
      assert.ok(contrast(ensureContrast(accent, bg, 4.5), bg) >= 4.5, `${accent} on ${bg}`);
    }
    const fg = readableOn(accent);
    assert.ok(contrast(fg, accent) >= 4.5, `button text on ${accent}`);
  }
  assert.equal(ensureContrast('#ffffff', '#000000'), '#ffffff', 'already readable colours are unchanged');
  assert.equal(isHex('#12abEF'), true);
  assert.equal(isHex('#12abE'), false);
  assert.equal(isHex('red'), false);
  assert.equal(rgba('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
  assert.match(rgba('nope', 0.2), /^rgba\(94,106,210,0\.2\)$/);
});

import { svgDataUrl } from '../static/js/lib/qr.js';
test('svgDataUrl adds the namespace and rejects non-SVG', () => {
  const url = svgDataUrl('<svg width="5" height="5"><path d="M0 0"/></svg>');
  const decoded = Buffer.from(url.split(',')[1], 'base64').toString();
  assert.match(decoded, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(svgDataUrl('<html><svg></svg></html>'), null);
  assert.equal(svgDataUrl(5), null);
});

import { stripTrailingSlashes, beszelUrlProblem } from '../static/js/lib/url.js';
import { createApi } from '../static/js/api.js';

test('searxng url is built with the URL API', () => {
  const q = (u, s = 'a b') => buildSearchUrl({ provider: 'searxng', searxngUrl: u }, s);
  assert.equal(q('https://s.example.com'), 'https://s.example.com/search?q=a+b');
  assert.equal(q('https://s.example.com/'), 'https://s.example.com/search?q=a+b');
  assert.equal(q('https://s.example.com/searx/'), 'https://s.example.com/searx/search?q=a+b');
  assert.equal(q('https://s.example.com/searx?x=1'), 'https://s.example.com/searx/search?x=1&q=a+b');
  assert.equal(q('https://s.example.com/search'), 'https://s.example.com/search?q=a+b');
  assert.equal(q('https://s.example.com/?q=old#frag', 'new'), 'https://s.example.com/search?q=new');
  assert.equal(q('https://s.example.com', 'x&y=1'), 'https://s.example.com/search?q=x%26y%3D1');
});

test('beszel url helpers', () => {
  assert.equal(stripTrailingSlashes('https://b.example.com///'), 'https://b.example.com');
  assert.equal(beszelUrlProblem('https://b.example.com/'), null);
  assert.equal(beszelUrlProblem('http://b.example.com:8090/path'), null);
  assert.match(beszelUrlProblem('https://b.example.com?x=1'), /query/);
  assert.match(beszelUrlProblem('https://b.example.com/#top'), /fragment/);
  assert.match(beszelUrlProblem('https://u:p@b.example.com'), /username/);
  assert.match(beszelUrlProblem('javascript:alert(1)'), /valid address/);
});

test('api sends the client header and survives plain-text errors', async () => {
  const calls = [];
  const mk = (res) => createApi({ fetchImpl: async (p, i) => (calls.push(i), res) });
  const text = (status, body) => ({ status, ok: false, headers: { get: () => null }, text: async () => body });
  await assert.rejects(mk(text(400, 'Invalid host header')).get('/api/x'), (e) => e.status === 400 && /rejected the request/.test(e.message));
  await assert.rejects(mk(text(502, '<html>x</html>')).post('/api/x', {}), (e) => e.status === 502 && !/JSON|Unexpected/.test(e.message));
  await assert.rejects(mk(text(403, '')).del('/api/x'), (e) => e.status === 403);
  assert.equal(calls.every((c) => c.headers['X-ServerHub-Client'] === 'web'), true);
});

import { fieldMessage } from '../static/js/lib/format.js';
test('fieldMessage turns terse API field codes into sentences', () => {
  assert.equal(fieldMessage('incorrect'), 'That is incorrect. Check it and try again.');
  assert.equal(fieldMessage('taken'), 'That is already taken.');
  assert.equal(fieldMessage('required'), 'This field is required.');
  assert.equal(fieldMessage('must not contain spaces'), 'must not contain spaces');
  assert.equal(fieldMessage(undefined), '');
});

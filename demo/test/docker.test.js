/**
 * Docker auto-discovery in the mock backend.
 *
 * Two fixtures were produced by the real implementation (serverhub/, run once
 * from the repo's .venv, not part of this test run):
 * - fixtures/docker-parity.json: a container list in the Docker Engine API's
 *   shape (the demo's own containers at t0 and three hours later, plus a set
 *   of awkward ones: bad labels, odd ports, control characters) together with
 *   what `integrations.docker.discover()` and `suggest()` returned for it;
 * - fixtures/docker-api-real.json: the responses of the real HTTP handlers
 *   (/api/docker, suggestions, admin config, bootstrap, authorization errors)
 *   for that same container list.
 * The mock's parser and routes must reproduce both exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBackend, memoryKv, STATE_KEY } from '../src/backend.js';
import { discover, suggest, normalizeUrl, prettify, cleanText } from '../src/docker.js';
import { humanDuration, dockerContainers, dockerServiceHealth } from '../src/sim.js';
import { DOCKER_CONTAINERS, DOCKER_PUBLIC_HOST, DOCKER_PROXY_HOST, DOCKER_SELF_ID_PREFIX, DEMO_PASSWORD } from '../src/seed.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'));
const parity = read('docker-parity.json');
const real = read('docker-api-real.json');

const T0 = parity.t0;
let clock = T0;
function setup(storage = memoryKv()) {
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const b = createBackend({ storage, now: () => clock, uuid });
  const call = (method, path, body) => b.handle(method, path, body === undefined ? undefined : JSON.stringify(body));
  const login = async (identifier, password) => {
    await call('POST', '/api/auth/logout');
    const r = await call('POST', '/api/auth/login', { identifier, password });
    assert.equal(r.status, 200);
  };
  return { b, call, storage, login, asJordan: () => login('jordan', 'jordan-password-1'), asDemo: () => login('demo', DEMO_PASSWORD) };
}

const ids = (r) => r.body.services.map((s) => s.id);

test.beforeEach(() => {
  clock = T0;
});

// ---------- the port of integrations/docker.py ----------

const opts = (o = {}) => ({ publicHost: 'docker.home.arpa', existingUrls: [], excludeNames: ['docker-proxy'], excludeIdPrefix: '5c1f0a9e2b4d', ...o });

test('discover() and suggest() give what the real implementation gives', () => {
  assert.deepEqual(discover(parity.demo), parity.expected.demo.discover);
  assert.deepEqual(discover(parity.demoLater), parity.expected.demoLater.discover);
  assert.deepEqual(discover(parity.tricky), parity.expected.tricky.discover);
  assert.deepEqual(suggest(parity.demo, opts()), parity.expected.demo.suggest);
  assert.deepEqual(suggest(parity.demo, opts({ existingUrls: parity.expected.demo.existing })), parity.expected.demo.suggestExisting);
  assert.deepEqual(suggest(parity.tricky, opts()), parity.expected.tricky.suggest);
  assert.deepEqual(suggest(parity.tricky, opts({ publicHost: null, excludeNames: [], excludeIdPrefix: null })), parity.expected.trickyNoHost.suggest);
});

test('the awkward containers really exercise the rules (skips, warnings, fallbacks)', () => {
  const t = parity.expected.tricky.discover;
  assert.ok(t.skipped.length >= 5 && t.warnings.length >= 5 && t.services.length >= 3);
  assert.ok(suggest(parity.tricky, opts()).some((s) => s.suggested.url === 'https://docker.home.arpa'));
});

test('helpers: prettify, cleanText, normalizeUrl', () => {
  assert.equal(prettify('my_app-1'), 'My App');
  assert.equal(prettify('server-hub'), 'Server Hub');
  assert.equal(cleanText(' a\tb\u0007c\n', 20), 'a bc');
  assert.equal(cleanText(5, 10), '');
  assert.equal(normalizeUrl('HTTPS://Docker.Home.Arpa:443/x/'), 'https://docker.home.arpa:443/x');
  assert.equal(normalizeUrl('http://docker.home.arpa/'), 'http://docker.home.arpa:80');
});

// ---------- the simulated host ----------

test('Docker\'s own duration wording', () => {
  const cases = [[0, 'Less than a second'], [1, '1 second'], [45, '45 seconds'], [60, 'About a minute'], [150, '2 minutes'], [3500, '58 minutes'], [3600, 'About an hour'], [3 * 3600, '3 hours'], [47 * 3600, '47 hours'], [2 * 86400, '2 days'], [13 * 86400, '13 days'], [20 * 86400, '2 weeks'], [90 * 86400, '3 months']];
  for (const [s, text] of cases) assert.equal(humanDuration(s), text, String(s));
});

test('the container list has a mix of states, and drifts with the clock', () => {
  const at = (ms) => Object.fromEntries(dockerContainers(DOCKER_CONTAINERS, T0, T0 + ms).map((c) => [c.Names[0].slice(1), c]));
  const a = at(0);
  assert.equal(a.mealie.Health.Status, 'starting');
  assert.equal(a.mealie.Status, 'Up 20 seconds (health: starting)');
  assert.equal(a.searxng.Status, 'Up 6 hours (unhealthy)');
  assert.equal(a.syncthing.State, 'exited');
  assert.equal(a.syncthing.Status, 'Exited (137) 2 days ago');
  assert.deepEqual(a.syncthing.Ports, []);
  assert.equal(a.dozzle.Status, 'Up 12 days (healthy)');
  assert.deepEqual(a.postgres.Ports, [{ IP: '127.0.0.1', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' }]);
  assert.ok(a['server-hub'].Id.startsWith(DOCKER_SELF_ID_PREFIX) && a['server-hub'].Id.length === 64);
  // 69 seconds in the 90-second health check is still running; at 70 the container has been up 90 seconds.
  assert.equal(at(69000).mealie.Health.Status, 'starting');
  const later = at(70000);
  assert.equal(later.mealie.Health.Status, 'healthy');
  assert.equal(later.mealie.Status, 'Up About a minute (healthy)');
  assert.equal(at(3 * 3600000).searxng.Status, 'Up 9 hours (unhealthy)', 'unhealthy stays unhealthy');
  assert.equal(at(3 * 3600000).syncthing.Status, 'Exited (137) 2 days ago');
  assert.deepEqual(at(5000), at(5000), 'deterministic');
  assert.equal(dockerServiceHealth({ state: 'running', health: null }), 'up');
  assert.equal(dockerServiceHealth({ state: 'running', health: 'healthy' }), 'up');
  assert.equal(dockerServiceHealth({ state: 'running', health: 'starting' }), 'down');
  assert.equal(dockerServiceHealth({ state: 'exited', health: null }), 'down');
});

test('the seed is believable: home.arpa addresses, one duplicate of a seeded service, known icons and categories', async () => {
  const { call } = setup();
  const d = (await call('GET', '/api/docker')).body;
  const own = (await call('GET', '/api/services')).body.services;
  const dup = d.services.filter((s) => own.some((o) => o.url === s.url));
  assert.deepEqual(dup.map((s) => s.id), ['docker:portainer']);
  for (const s of d.services) assert.match(new URL(s.url).hostname, /\.home\.arpa$/);
  assert.equal(new Set(d.services.map((s) => s.container.state)).size, 2);
  assert.deepEqual(d.services.map((s) => s.container.health).filter(Boolean).sort(), ['healthy', 'healthy', 'starting', 'unhealthy']);
  assert.equal(DOCKER_PUBLIC_HOST, 'docker.home.arpa');
  assert.equal(DOCKER_PROXY_HOST, 'docker-proxy');
});

// ---------- API: same responses as the real handlers ----------

test('GET /api/docker, suggestions and config: the real handlers\' responses, byte for byte', async () => {
  const { call, asJordan, asDemo } = setup();
  const same = (name, r) => assert.deepEqual({ status: r.status, body: r.body }, real[name], name);

  // Signed in as the demo admin.
  same('admin:docker', await call('GET', '/api/docker'));
  same('admin:config', await call('GET', '/api/admin/config'));
  same('admin:suggestions', await call('GET', '/api/admin/docker/suggestions'));
  const boot = await call('GET', '/api/bootstrap');
  assert.deepEqual([boot.status, Object.keys(boot.body), boot.body.docker], [real['admin:bootstrap'].status, real['admin:bootstrap'].keys, real['admin:bootstrap'].docker]);

  // A plain user, switch off.
  await asJordan();
  same('bob:docker', await call('GET', '/api/docker'));
  same('bob:suggestions', await call('GET', '/api/admin/docker/suggestions'));
  same('bob:config', await call('GET', '/api/admin/config'));
  assert.deepEqual((await call('GET', '/api/bootstrap')).body.docker, real['bob:bootstrap'].docker);

  // Signed out.
  await call('POST', '/api/auth/logout');
  for (const p of ['/api/docker', '/api/admin/docker/suggestions', '/api/admin/config']) same('anon:' + p, await call('GET', p));
  same('put:anon', await call('PUT', '/api/admin/config', { docker_visible_to_users: true }));

  // The admin turns the switch on.
  await asDemo();
  same('put:docker_on', await call('PUT', '/api/admin/config', { docker_visible_to_users: true }));
  assert.deepEqual((await call('GET', '/api/bootstrap')).body.docker, real['admin:bootstrap:on'].docker);
  await asJordan();
  assert.deepEqual((await call('GET', '/api/bootstrap')).body.docker, real['bob:bootstrap:on'].docker);
  same('bob:docker:on', await call('GET', '/api/docker'));
  same('put:bob', await call('PUT', '/api/admin/config', { docker_visible_to_users: true }));
  await asDemo();

  // Partial updates and the same validation errors.
  same('put:reg_only', await call('PUT', '/api/admin/config', { registration_open: true }));
  same('put:empty', await call('PUT', '/api/admin/config', {}));
  same('put:null', await call('PUT', '/api/admin/config', { docker_visible_to_users: null }));
  same('put:null2', await call('PUT', '/api/admin/config', { registration_open: null, docker_visible_to_users: false }));
  same('put:str', await call('PUT', '/api/admin/config', { docker_visible_to_users: 'yes' }));
  same('put:unknown', await call('PUT', '/api/admin/config', { docker_visible_to_users: true, nope: 1 }));
  same('put:array', await call('PUT', '/api/admin/config', [1]));
  assert.deepEqual((await call('GET', '/api/admin/config')).body, { registration_open: true, docker_visible_to_users: true }, 'failed updates change nothing');

  // Discovered services are not rows: ids that are not UUIDs answer 404 like the real route.
  same('patch:docker-svc', await call('PATCH', '/api/services/docker:dozzle', { name: 'x' }));
  same('delete:docker-svc', await call('DELETE', '/api/services/docker:dozzle'));

  // A backup import answers with the bootstrap, including the docker flag, and never stores discovered services.
  const imp = await call('POST', '/api/backup', { version: 1, services: [], bookmarks: [] });
  assert.deepEqual([imp.status, Object.keys(imp.body), imp.body.docker], [real['backup:import'].status, real['backup:import'].keys, real['backup:import'].docker]);
  assert.equal(imp.body.services.length, 0);
});

test('the response to adding a suggestion matches the real status code, and the row disappears', async () => {
  const { call } = setup();
  const before = (await call('GET', '/api/admin/docker/suggestions')).body.suggestions;
  assert.deepEqual(before.map((s) => s.container.name), ['bookstack', 'filebrowser', 'node-red', 'prometheus']);
  assert.equal(real['post:suggested'].status, 201);
  const pick = before.find((s) => s.container.name === 'prometheus');
  const added = await call('POST', '/api/services', { name: pick.suggested.name, url: pick.suggested.url, icon: pick.suggested.icon, category: pick.suggested.category });
  assert.equal(added.status, 201);
  assert.deepEqual(Object.keys(added.body.service), Object.keys(real['post:suggested'].body.service));
  const after = await call('GET', '/api/admin/docker/suggestions');
  assert.deepEqual(after.body, real['admin:suggestions:after'].body);
  assert.deepEqual(after.body.suggestions.map((s) => s.container.name), ['bookstack', 'filebrowser', 'node-red']);
  // A trailing slash or different case is the same address.
  await call('POST', '/api/services', { name: 'Files', url: 'http://DOCKER.home.arpa:8082/' });
  assert.deepEqual((await call('GET', '/api/admin/docker/suggestions')).body.suggestions.map((s) => s.container.name), ['bookstack', 'node-red']);
  // Other addresses do not hide it.
  await call('POST', '/api/services', { name: 'Elsewhere', url: 'http://other.home.arpa:6875' });
  assert.equal((await call('GET', '/api/admin/docker/suggestions')).body.suggestions.length, 2);
});

test('suggestions are filtered against the signed-in admin\'s own services', async () => {
  const { call, asJordan, asDemo } = setup();
  await asDemo();
  await call('POST', '/api/admin/users', { email: 'root2@home.arpa', username: 'root2', password: 'x'.repeat(12), role: 'admin' });
  await call('POST', '/api/services', { name: 'Prom', url: 'http://docker.home.arpa:9090' });
  assert.equal((await call('GET', '/api/admin/docker/suggestions')).body.suggestions.length, 3);
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { identifier: 'root2', password: 'x'.repeat(12) });
  assert.equal((await call('GET', '/api/admin/docker/suggestions')).body.suggestions.length, 4, 'another admin has not added it');
  await asJordan();
  assert.equal((await call('GET', '/api/admin/docker/suggestions')).status, 403);
});

test('the config switch persists and survives a reload; reset restores the seed', async () => {
  const storage = memoryKv();
  const a = setup(storage);
  assert.equal((await a.call('PUT', '/api/admin/config', { docker_visible_to_users: true })).body.docker_visible_to_users, true);
  const b = setup(storage);
  assert.deepEqual((await b.call('GET', '/api/admin/config')).body, { registration_open: false, docker_visible_to_users: true });
  b.b.reset();
  const c = setup(storage);
  assert.deepEqual((await c.call('GET', '/api/admin/config')).body, { registration_open: false, docker_visible_to_users: false });
  assert.deepEqual((await c.call('GET', '/api/docker')).body.services.map((s) => s.id), ids({ body: { services: parity.expected.demo.discover.services } }));
});

test('non-admin users: discovered services only while the switch is on, without admin diagnostics', async () => {
  const { call, asJordan, asDemo } = setup();
  await asJordan();
  assert.deepEqual((await call('GET', '/api/docker')).body, { enabled: false, available: false, error: null, services: [] });
  assert.deepEqual((await call('GET', '/api/bootstrap')).body.docker, { enabled: false });
  assert.deepEqual(Object.keys((await call('GET', '/api/status')).body.statuses), []);
  await asDemo();
  await call('PUT', '/api/admin/config', { docker_visible_to_users: true });
  await asJordan();
  const r = await call('GET', '/api/docker');
  assert.deepEqual(Object.keys(r.body), ['enabled', 'available', 'error', 'services']);
  assert.equal(r.body.services.length, 9);
  const st = (await call('GET', '/api/status')).body.statuses;
  assert.ok(Object.keys(st).every((k) => k.startsWith('docker:')));
  for (const s of Object.values(st)) assert.ok(s.http_status === null && s.latency_ms === null, 'no probe details for non-admins');
  assert.equal(st['docker:dozzle'].state, 'up');
  assert.equal((await call('GET', '/api/admin/docker/suggestions')).status, 403);
  assert.equal((await call('PUT', '/api/admin/config', { docker_visible_to_users: false })).status, 403);
  // The user's own dashboard data is untouched.
  assert.equal((await call('GET', '/api/bootstrap')).body.services.length, 0);
  await asDemo();
  await call('PUT', '/api/admin/config', { docker_visible_to_users: false });
  await asJordan();
  assert.equal((await call('GET', '/api/docker')).body.enabled, false);
});

test('status: discovered services follow their container, with the same entry shape as any service', async () => {
  const { call } = setup();
  const all = (await call('GET', '/api/status')).body.statuses;
  const docker = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('docker:')));
  assert.deepEqual(Object.keys(docker).sort(), ['docker:dozzle', 'docker:mealie', 'docker:portainer', 'docker:radarr', 'docker:searxng', 'docker:sonarr', 'docker:syncthing', 'docker:vikunja']);
  assert.ok(!('docker:qbittorrent' in docker), 'serverhub.check=false: not checked');
  assert.ok(!('docker:whoami' in docker), 'skipped containers have no card');
  for (const id of ['docker:dozzle', 'docker:radarr', 'docker:sonarr', 'docker:vikunja', 'docker:portainer']) {
    assert.equal(docker[id].state, 'up', id);
    assert.ok(docker[id].http_status < 500 && docker[id].latency_ms > 0 && docker[id].checked_at, id);
  }
  for (const id of ['docker:syncthing', 'docker:searxng', 'docker:mealie']) {
    assert.deepEqual([docker[id].state, docker[id].http_status, docker[id].latency_ms], ['down', null, null], id);
    assert.match(docker[id].checked_at, /^\d{4}-\d\d-\d\dT[\d:]+Z$/);
  }
  for (const s of Object.values(docker)) assert.deepEqual(Object.keys(s), ['state', 'http_status', 'latency_ms', 'checked_at']);
  // The starting container answers once it is healthy.
  clock += 70000;
  assert.equal((await call('GET', '/api/status')).body.statuses['docker:mealie'].state, 'up');
  assert.equal((await call('GET', '/api/docker')).body.services.find((s) => s.id === 'docker:mealie').container.health, 'healthy');
  // Own services are unaffected.
  assert.equal(Object.keys(all).filter((k) => !k.startsWith('docker:')).length, 18);
});

test('GET /api/docker: the admin sees diagnostics, with the real shape', async () => {
  const { call } = setup();
  const r = await call('GET', '/api/docker');
  assert.deepEqual(Object.keys(r.body), ['enabled', 'available', 'error', 'services', 'skipped', 'warnings']);
  assert.deepEqual(r.body.skipped, [{ container: 'whoami', reason: 'serverhub.url is not a valid http(s) URL' }]);
  assert.deepEqual(r.body.warnings, [{ container: 'vikunja', reason: 'serverhub.icon is not a known icon id; using a default' }]);
  const s = r.body.services.find((x) => x.id === 'docker:mealie');
  assert.deepEqual(Object.keys(s), ['id', 'name', 'url', 'description', 'icon', 'category', 'check', 'container']);
  assert.deepEqual(Object.keys(s.container), ['name', 'image', 'state', 'status', 'health']);
  assert.deepEqual(r.body.services.map((x) => x.name.toLowerCase()), [...r.body.services.map((x) => x.name.toLowerCase())].sort());
  // The "Up …" text moves with the clock.
  clock += 86400000;
  assert.equal((await call('GET', '/api/docker')).body.services.find((x) => x.id === 'docker:dozzle').container.status, 'Up 13 days (healthy)');
});

test('state saved before Docker discovery existed still loads (no docker block, no switch)', async () => {
  const storage = memoryKv();
  const first = setup(storage);
  await first.call('GET', '/api/me');
  const doc = JSON.parse(storage.getItem(STATE_KEY));
  delete doc.docker;
  storage.setItem(STATE_KEY, JSON.stringify(doc));
  clock += 600000;
  const next = setup(storage);
  assert.deepEqual((await next.call('GET', '/api/admin/config')).body, { registration_open: false, docker_visible_to_users: false });
  const d = (await next.call('GET', '/api/docker')).body;
  assert.equal(d.available, true);
  assert.equal(d.services.find((s) => s.id === 'docker:mealie').container.health, 'starting', 'the simulated host starts when the visitor first meets it');
  assert.equal(JSON.parse(storage.getItem(STATE_KEY)).docker.t0, clock);
});

test('discovered services are never part of a backup', async () => {
  const { call } = setup();
  const doc = (await call('GET', '/api/backup')).body;
  assert.equal(doc.services.length, 18);
  assert.ok(!JSON.stringify(doc).includes('docker:'));
});

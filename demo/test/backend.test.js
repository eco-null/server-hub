import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, memoryKv, canonicalId, STATE_KEY } from '../src/backend.js';
import { totpAt } from '../src/totp.js';
import { DEMO_PASSWORD } from '../src/seed.js';

let clock = Date.parse('2026-11-14T12:00:00Z');
function setup(storage = memoryKv()) {
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const b = createBackend({ storage, now: () => clock, uuid });
  const call = async (method, path, body) => {
    const r = await b.handle(method, path, body === undefined ? undefined : JSON.stringify(body));
    return r;
  };
  return { b, call, storage };
}

test('starts signed in as the demo admin with the seeded homelab', async () => {
  const { call } = setup();
  const st = await call('GET', '/api/auth/state');
  assert.deepEqual(st.body, { setup_required: false, registration_open: false, authenticated: true });
  const boot = await call('GET', '/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.deepEqual(Object.keys(boot.body).sort(), ['bookmarks', 'docker', 'layout', 'services', 'settings', 'user']);
  assert.deepEqual(boot.body.docker, { enabled: true });
  assert.equal(boot.body.user.username, 'demo');
  assert.equal(boot.body.user.role, 'admin');
  assert.equal(boot.body.services.length, 18);
  assert.equal(boot.body.bookmarks.length, 6);
  assert.ok(new Set(boot.body.services.map((s) => s.category)).size >= 6);
  for (const s of boot.body.services) assert.match(new URL(s.url).hostname, /\.home\.arpa$/);
  assert.equal(boot.body.settings.userName, 'Alex');
  assert.equal(boot.body.settings.pageTitle, 'Homelab');
});

test('errors use the API shape; unknown routes 404, wrong methods 405, bad JSON 400', async () => {
  const { b, call } = setup();
  assert.deepEqual((await call('GET', '/api/nope')).body, { error: { code: 'not_found', message: 'Not found' } });
  assert.equal((await call('PUT', '/api/services')).body.error.code, 'method_not_allowed');
  const bad = await b.handle('POST', '/api/services', '{nope');
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_json']);
  const v = await call('POST', '/api/services', { name: '', url: 'nope' });
  assert.equal(v.status, 400);
  assert.equal(v.body.error.code, 'validation');
  assert.deepEqual(Object.keys(v.body.error.fields).sort(), ['name', 'url']);
  assert.deepEqual((await call('POST', '/api/services', [1])).body.error.fields, { body: 'must be a JSON object' });
});

test('services CRUD, ids, limits on null and unknown ids', async () => {
  const { call } = setup();
  const created = await call('POST', '/api/services', { name: 'Syncthing', url: 'https://sync.home.arpa', icon: 'refresh' });
  assert.equal(created.status, 201);
  const svc = created.body.service;
  assert.deepEqual(Object.keys(svc).sort(), ['category', 'check', 'created_at', 'description', 'icon', 'id', 'name', 'url']);
  assert.equal(svc.category, null);
  const patched = await call('PATCH', '/api/services/' + svc.id.toUpperCase(), { name: 'Sync', category: 'Files' });
  assert.equal(patched.body.service.name, 'Sync');
  assert.equal(patched.body.service.category, 'Files');
  assert.equal((await call('PATCH', '/api/services/' + svc.id, { category: null })).body.service.category, null);
  assert.equal((await call('PATCH', '/api/services/' + svc.id, { url: null })).body.error.fields.url, 'must not be null');
  assert.equal((await call('PATCH', '/api/services/not-a-uuid', { name: 'x' })).status, 404);
  assert.equal((await call('DELETE', '/api/services/' + svc.id)).status, 204);
  assert.equal((await call('DELETE', '/api/services/' + svc.id)).status, 404);
  assert.equal((await call('GET', '/api/services')).body.services.length, 18);
});

test('bookmarks CRUD with validation', async () => {
  const { call } = setup();
  const r = await call('POST', '/api/bookmarks', { name: 'Wiki', url: 'https://wiki.home.arpa' });
  assert.equal(r.status, 201);
  assert.equal(r.body.bookmark.color, '#5E6AD2');
  assert.equal((await call('PATCH', '/api/bookmarks/' + r.body.bookmark.id, { color: 'blue' })).status, 400);
  assert.equal((await call('PATCH', '/api/bookmarks/' + r.body.bookmark.id, { color: '#112233' })).body.bookmark.color, '#112233');
  assert.equal((await call('DELETE', '/api/bookmarks/' + r.body.bookmark.id)).status, 204);
  assert.equal((await call('GET', '/api/bookmarks')).body.bookmarks.length, 6);
});

test('settings PATCH deep-merges, validates the result, DELETE resets', async () => {
  const { call } = setup();
  const r = await call('PATCH', '/api/settings', { theme: 'dark', wallpaper: { mode: 'gradient', gradient: 'forest' } });
  assert.equal(r.body.settings.theme, 'dark');
  assert.deepEqual(r.body.settings.wallpaper, { mode: 'gradient', gradient: 'forest', url: '', showGrid: false });
  const bad = await call('PATCH', '/api/settings', { accent: 'red', features: { clock: 1 } });
  assert.deepEqual(bad.body.error.fields, { accent: "String should match pattern '^#[0-9a-fA-F]{6}$'", 'features.clock': 'Input should be a valid boolean' });
  assert.equal((await call('GET', '/api/settings')).body.settings.theme, 'dark', 'a failed PATCH changes nothing');
  const reset = await call('DELETE', '/api/settings');
  assert.equal(reset.body.settings.theme, 'dark');
  assert.equal(reset.body.settings.userName, '');
});

test('state persists in storage across backend instances (reloads, other pages)', async () => {
  const storage = memoryKv();
  const a = setup(storage);
  await a.call('POST', '/api/bookmarks', { name: 'Kept', url: 'https://kept.home.arpa' });
  await a.call('PATCH', '/api/settings', { theme: 'light' });
  assert.ok(storage.getItem(STATE_KEY));
  const b = setup(storage);
  const boot = (await b.call('GET', '/api/bootstrap')).body;
  assert.ok(boot.bookmarks.some((x) => x.name === 'Kept'));
  assert.equal(boot.settings.theme, 'light');
  b.b.reset();
  assert.equal(storage.getItem(STATE_KEY), null);
  assert.equal((await setup(storage).call('GET', '/api/bootstrap')).body.bookmarks.length, 6);
  storage.setItem(STATE_KEY, '{corrupt');
  assert.equal((await setup(storage).call('GET', '/api/bootstrap')).body.services.length, 18);
});

test('sign out, wrong password, sign in by username or email', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/api/auth/logout')).status, 204);
  const un = await call('GET', '/api/bootstrap');
  assert.deepEqual([un.status, un.body.error.code], [401, 'unauthenticated']);
  const wrong = await call('POST', '/api/auth/login', { identifier: 'demo', password: 'nope' });
  assert.deepEqual(wrong.body, { error: { code: 'invalid_credentials', message: 'Invalid username/email or password' } });
  assert.equal((await call('POST', '/api/auth/login', { identifier: 'nobody', password: DEMO_PASSWORD })).status, 401);
  const ok = await call('POST', '/api/auth/login', { identifier: 'DEMO@home.arpa', password: DEMO_PASSWORD });
  assert.equal(ok.body.user.username, 'demo');
  assert.equal((await call('GET', '/api/me')).body.user.username, 'demo');
  assert.equal((await call('POST', '/api/auth/setup', { email: 'a@b.cd', username: 'abc', password: 'x'.repeat(10), setup_token: 't' })).body.error.code, 'setup_complete');
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.cd', username: 'abc', password: 'x'.repeat(10) })).body.error.code, 'registration_closed');
});

test('password change checks the current password but keeps the demo password', async () => {
  const { call } = setup();
  const bad = await call('PUT', '/api/me/password', { current_password: 'nope', new_password: 'x'.repeat(12) });
  assert.deepEqual(bad.body.error, { code: 'validation', message: 'Current password is incorrect', fields: { current_password: 'incorrect' } });
  assert.equal((await call('PUT', '/api/me/password', { current_password: DEMO_PASSWORD, new_password: 'short' })).body.error.fields.new_password, 'String should have at least 10 characters');
  assert.equal((await call('PUT', '/api/me/password', { current_password: DEMO_PASSWORD, new_password: 'x'.repeat(12) })).status, 204);
  await call('POST', '/api/auth/logout');
  assert.equal((await call('POST', '/api/auth/login', { identifier: 'demo', password: DEMO_PASSWORD })).status, 200);
});

test('2FA: setup, enable with a real TOTP, sign in with code and recovery code, disable', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/api/me/2fa/setup', { current_password: 'nope' })).body.error.fields.current_password, 'incorrect');
  assert.equal((await call('POST', '/api/me/2fa/enable', { code: '123456' })).body.error.code, 'twofa_setup_expired');
  const s = (await call('POST', '/api/me/2fa/setup', { current_password: DEMO_PASSWORD })).body;
  assert.match(s.secret, /^[A-Z2-7]{32}$/);
  assert.equal(s.otpauth_uri, `otpauth://totp/Server%20Hub:demo?secret=${s.secret}&issuer=Server%20Hub`);
  assert.match(s.qr_svg, /^<svg /);
  const now = clock / 1000;
  const good = await totpAt(s.secret, now);
  const wrongCode = good === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/api/me/2fa/enable', { code: wrongCode })).body.error.code, 'invalid_code');
  const en = await call('POST', '/api/me/2fa/enable', { code: good });
  assert.equal(en.body.recovery_codes.length, 10);
  assert.equal((await call('GET', '/api/me')).body.user.twofa_enabled, true);
  assert.equal((await call('POST', '/api/me/2fa/setup', { current_password: DEMO_PASSWORD })).body.error.code, 'twofa_enabled');

  await call('POST', '/api/auth/logout');
  assert.deepEqual((await call('POST', '/api/auth/login', { identifier: 'demo', password: DEMO_PASSWORD })).body, { twofa_required: true });
  assert.equal((await call('POST', '/api/auth/2fa', { code: good })).body.error.code, 'invalid_code', 'a used time step is not accepted again');
  clock += 30000;
  const next = await totpAt(s.secret, clock / 1000);
  assert.equal((await call('POST', '/api/auth/2fa', { code: next })).body.user.username, 'demo');

  await call('POST', '/api/auth/logout');
  assert.equal((await call('POST', '/api/auth/2fa', { code: next })).body.error.code, 'login_expired');
  await call('POST', '/api/auth/login', { identifier: 'demo', password: DEMO_PASSWORD });
  const rc = en.body.recovery_codes[0];
  assert.equal((await call('POST', '/api/auth/2fa', { code: rc.toUpperCase() })).status, 200);
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { identifier: 'demo', password: DEMO_PASSWORD });
  assert.equal((await call('POST', '/api/auth/2fa', { code: rc })).body.error.code, 'invalid_code', 'recovery codes are single use');
  for (let i = 0; i < 4; i++) await call('POST', '/api/auth/2fa', { code: '000000' });
  assert.equal((await call('POST', '/api/auth/2fa', { code: en.body.recovery_codes[1] })).body.error.code, 'login_expired', 'five attempts per pending sign-in');
  await call('POST', '/api/auth/login', { identifier: 'demo', password: DEMO_PASSWORD });
  await call('POST', '/api/auth/2fa', { code: en.body.recovery_codes[1] });

  assert.equal((await call('POST', '/api/me/2fa/disable', { current_password: DEMO_PASSWORD, code: 'zzzzz-zzzzz' })).body.error.code, 'invalid_code');
  assert.equal((await call('POST', '/api/me/2fa/disable', { current_password: DEMO_PASSWORD, code: en.body.recovery_codes[2] })).status, 204);
  assert.equal((await call('POST', '/api/me/2fa/disable', { current_password: DEMO_PASSWORD, code: 'x' })).body.error.code, 'twofa_disabled');
});

test('status: deterministic states, admin-only details, values drift over time', async () => {
  const { call } = setup();
  // Own services only; discovered Docker services are covered in docker.test.js.
  const a = Object.fromEntries(Object.entries((await call('GET', '/api/status')).body.statuses).filter(([k]) => !k.startsWith('docker:')));
  const states = Object.values(a).map((s) => s.state);
  assert.equal(states.length, 18);
  assert.equal(states.filter((s) => s === 'up').length, 16);
  assert.equal(states.filter((s) => s === 'down').length, 1);
  assert.equal(states.filter((s) => s === 'unknown').length, 1);
  const up = Object.entries(a).filter(([, s]) => s.state === 'up');
  for (const [, s] of up) assert.ok(s.http_status < 500 && s.latency_ms > 0 && s.checked_at);
  clock += 60000;
  const b = (await call('GET', '/api/status')).body.statuses;
  assert.ok(up.some(([id, s]) => b[id].latency_ms !== s.latency_ms));
  const svc = (await call('GET', '/api/services')).body.services[0];
  await call('PATCH', '/api/services/' + svc.id, { check: false });
  assert.ok(!((await call('GET', '/api/status')).body.statuses[svc.id]));
});

test('monitoring demo seed uses retained history and recovers old storage without changing bootstrap', async () => {
  const { call, storage } = setup();
  const boot = (await call('GET', '/api/bootstrap')).body;
  const { id } = boot.services.find((service) => service.name === 'Jellyfin');
  const path = '/api/services/' + id + '/monitoring';
  const { status, body } = await call('GET', path);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['available', 'check_enabled', 'enabled', 'incidents', 'last_check', 'next_before', 'summary']);
  assert.equal(body.available, true);
  assert.equal(body.enabled, true);
  assert.equal(body.check_enabled, true);
  assert.equal(body.last_check.state, 'up');
  assert.ok(body.last_check.http_status < 500 && body.last_check.latency_ms > 0);
  assert.deepEqual(body.summary, { uptime_pct: 99.82, checked: 10081, expected: 10081, unknown: 0, missing: 0 });
  assert.equal(body.incidents.length, 2);
  assert.equal(body.incidents[0].end_reason, 'recovered');
  assert.ok(body.incidents[0].started_at > body.incidents[1].started_at);
  assert.equal(body.next_before, null);
  const older = await call('GET', path + '?before=' + body.incidents[0].started_at);
  assert.deepEqual(older.body.incidents, body.incidents.slice(1));
  const upperBound = await call('GET', path + '?before=9223372036854775807');
  assert.deepEqual(upperBound.body.incidents, body.incidents);
  for (const cursor of ['before=0', 'before=3.5', 'before=-100', 'before=9223372036854775808', 'before=42&before=52']) {
    const invalid = await call('GET', path + '?' + cursor);
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.error.fields, { before: 'must be a positive integer timestamp' });
  }

  const stored = JSON.parse(storage.getItem(STATE_KEY));
  delete stored.monitoring;
  storage.setItem(STATE_KEY, JSON.stringify(stored));
  const reloaded = setup(storage).call;
  assert.deepEqual((await reloaded('GET', '/api/bootstrap')).body, boot);
  assert.deepEqual((await reloaded('GET', path)).body, body);
});

test('monitoring settings enforce ownership, admin access and a strict toggle', async () => {
  const { call, storage } = setup();
  const admin = '/api/admin/monitoring';
  const { id } = (await call('GET', '/api/services')).body.services[0];
  const path = '/api/services/' + id + '/monitoring';
  assert.deepEqual((await call('GET', admin)).body, { enabled: true });
  for (const bad of [{}, { enabled: 'true' }, { enabled: null }, { enabled: true, extra: false }]) {
    assert.equal((await call('PUT', admin, bad)).status, 400);
    assert.equal((await call('PUT', path, bad)).status, 400);
  }
  assert.equal((await call('GET', '/api/services/invalid/monitoring')).status, 404);
  assert.equal((await call('PUT', '/api/services/invalid/monitoring', { enabled: true })).status, 404);
  assert.deepEqual((await call('PUT', admin, { enabled: false })).body, { enabled: false });
  assert.equal((await call('PUT', path, { enabled: true })).body.error.code, 'monitoring_disabled');
  assert.equal((await call('GET', path)).body.enabled, true);
  assert.deepEqual((await setup(storage).call('GET', admin)).body, { enabled: false });
  await call('PUT', admin, { enabled: true });
  assert.equal((await call('POST', '/api/auth/login', { identifier: 'jordan', password: 'jordan-password-1' })).status, 200);
  assert.equal((await call('GET', admin)).status, 403);
  assert.equal((await call('PUT', admin, { enabled: false })).status, 403);
  assert.equal((await call('GET', path)).status, 404);
  assert.equal((await call('PUT', path, { enabled: false })).status, 404);
  const created = await call('POST', '/api/services', { name: 'Owner service', url: 'https://owner.home.arpa', check: false });
  const own = '/api/services/' + created.body.service.id;
  assert.equal((await call('PUT', own + '/monitoring', { enabled: true })).body.error.code, 'checks_disabled');
  await call('PATCH', own, { check: true });
  const enabled = await call('PUT', own + '/monitoring', { enabled: true });
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.last_check, null);
  assert.equal((await call('GET', '/api/status')).body.statuses[created.body.service.id].state, 'unknown');
  const original = clock;
  try {
    clock += 60000;
    const { last_check: check } = (await call('GET', own + '/monitoring')).body;
    assert.equal(check.state, 'up');
    assert.ok(check.checked_at);
    assert.equal(check.http_status, null);
    assert.equal(check.latency_ms, null);
  } finally {
    clock = original;
  }
});

test('monitoring limit and cleanup follow pause, edit, delete, and JSON restore', async () => {
  const { call, storage } = setup();
  const services = (await call('GET', '/api/services')).body.services;
  const { id } = services[0];
  const servicePath = '/api/services/' + id;
  const path = servicePath + '/monitoring';
  const original = (await call('GET', path)).body;
  for (const svc of services.slice(1, 10)) {
    assert.equal((await call('PUT', '/api/services/' + svc.id + '/monitoring', { enabled: true })).status, 200);
  }
  assert.equal((await call('PUT', '/api/services/' + services[10].id + '/monitoring', { enabled: true })).body.error.code, 'owner_limit');

  await call('PATCH', servicePath, { check: false });
  const paused = (await call('GET', path)).body;
  assert.equal(paused.enabled, false);
  assert.equal(paused.check_enabled, false);
  assert.deepEqual(paused.incidents, original.incidents);
  assert.deepEqual(paused.summary, original.summary);
  await call('PATCH', servicePath, { check: true, url: 'https://changed.home.arpa' });
  const updated = (await call('GET', path)).body;
  assert.equal(updated.enabled, false);
  assert.equal(updated.last_check, null);
  assert.deepEqual(updated.incidents, []);

  const removed = services[1].id;
  assert.equal((await call('DELETE', '/api/services/' + removed)).status, 204);
  assert.equal((await call('GET', '/api/services/' + removed + '/monitoring')).status, 404);
  assert.equal(JSON.parse(storage.getItem(STATE_KEY)).monitoring.services[removed], undefined);
  const doc = (await call('GET', '/api/backup')).body;
  assert.equal((await call('POST', '/api/backup', doc)).status, 200);
  assert.deepEqual(JSON.parse(storage.getItem(STATE_KEY)).monitoring.services, {});
  assert.equal((await call('GET', path)).status, 404);
});

test('monitoring webhook demo persists only the configured flag and never sends a request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('demo contacted the network'); });
  const { call, storage } = setup();
  const path = '/api/admin/monitoring/webhook';
  const empty = { configured: false, last_delivery: null };
  const configured = { configured: true, last_delivery: null };
  assert.deepEqual((await call('GET', path)).body, empty);

  const older = JSON.parse(storage.getItem(STATE_KEY));
  delete older.monitoring.webhook_configured;
  storage.setItem(STATE_KEY, JSON.stringify(older));
  assert.deepEqual((await setup(storage).call('GET', path)).body, empty);

  const url = 'https://hook.example.test/incoming?token=demo-webhook-token';
  assert.deepEqual((await call('PUT', path, { url })).body, configured);
  assert.deepEqual((await setup(storage).call('GET', path)).body, configured);
  const stored = storage.getItem(STATE_KEY);
  assert.equal(JSON.parse(stored).monitoring.webhook_configured, true);
  assert.doesNotMatch(stored, /hook\.example\.test|demo-webhook-token/);
  assert.deepEqual((await call('DELETE', path)).body, empty);
  assert.deepEqual((await setup(storage).call('GET', path)).body, empty);
  assert.equal(fetch.mock.callCount(), 0);
});

test('monitoring webhook demo enforces admin access and a strict HTTPS destination', async () => {
  const { call } = setup();
  const path = '/api/admin/monitoring/webhook';
  const url = 'https://hook.example.test/incoming';
  for (const body of [
    {}, { url: null }, { url: true }, { url, extra: true },
    { url: 'http://hook.example.test/incoming' }, { url: 'https:///incoming' },
    { url: url + '#' }, { url: 'https://user:pass@hook.example.test/incoming' },
  ]) {
    const response = await call('PUT', path, body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'validation');
  }
  assert.deepEqual((await call('GET', path)).body, { configured: false, last_delivery: null });
  assert.equal((await call('POST', '/api/auth/login', { identifier: 'jordan', password: 'jordan-password-1' })).status, 200);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await call(method, path, method === 'PUT' ? { url } : undefined)).status, 403);
  }
  await call('POST', '/api/auth/logout');
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await call(method, path, method === 'PUT' ? { url } : undefined)).status, 401);
  }
});

test('beszel: two hubs with three systems, drifting within bounds, CRUD and test', async () => {
  const { call } = setup();
  const sys1 = (await call('GET', '/api/beszel/systems')).body.instances;
  assert.equal(sys1.length, 2);
  for (const inst of sys1) {
    assert.equal(inst.ok, true);
    assert.equal(inst.systems.length, 3);
    for (const s of inst.systems) for (const k of ['cpu', 'memory', 'disk']) assert.ok(s[k] >= 0 && s[k] <= 100, `${s.name}.${k}=${s[k]}`);
  }
  clock += 20000;
  const sys2 = (await call('GET', '/api/beszel/systems')).body.instances;
  assert.notDeepEqual(sys1[0].systems.map((s) => s.cpu), sys2[0].systems.map((s) => s.cpu));

  const list = (await call('GET', '/api/beszel/instances')).body.instances;
  assert.deepEqual(Object.keys(list[0]).sort(), ['has_password', 'id', 'name', 'url', 'username']);
  assert.ok(!('password' in list[0]));
  const created = await call('POST', '/api/beszel/instances', { url: 'https://hub.home.arpa/', username: 'me', password: 'pw' });
  assert.equal(created.status, 201);
  assert.equal(created.body.instance.name, 'hub.home.arpa');
  assert.equal(created.body.instance.url, 'https://hub.home.arpa');
  const id = created.body.instance.id;
  assert.equal((await call('PATCH', '/api/beszel/instances/' + id, { name: '' })).body.instance.name, 'hub.home.arpa');
  assert.deepEqual((await call('POST', '/api/beszel/test', { instance_id: id })).body, { ok: true, name: 'me', error: null });
  assert.deepEqual((await call('POST', '/api/beszel/test', { url: 'https://x.home.arpa', username: 'u', password: 'wrong' })).body, { ok: false, name: null, error: 'Beszel rejected the username or password' });
  assert.equal((await call('POST', '/api/beszel/test', { url: 'https://x.home.arpa?x', username: 'u', password: 'p' })).status, 400);
  assert.equal((await call('GET', '/api/beszel/systems')).body.instances.length, 3);
  assert.equal((await call('DELETE', '/api/beszel/instances/' + id)).status, 204);
});

test('host stats are admin only', async () => {
  const { call } = setup();
  const s = (await call('GET', '/api/stats')).body;
  assert.deepEqual(Object.keys(s).sort(), ['cpu', 'disk', 'hostname', 'memory']);
});

test('layout: default, PATCH replaces sent keys, validation, DELETE resets', async () => {
  const { call } = setup();
  const def = { enabled: false, items: [] };
  assert.deepEqual((await call('GET', '/api/layout')).body, { layout: def });
  assert.deepEqual((await call('GET', '/api/bootstrap')).body.layout, def);
  const items = [{ id: 'stats', size: 'm' }, { id: 'group:Media', size: 'l', hidden: true }, { id: 'bookmarks' }];
  const r = await call('PATCH', '/api/layout', { enabled: true, items });
  assert.equal(r.status, 200);
  const full = [{ id: 'stats', size: 'm', hidden: false }, { id: 'group:Media', size: 'l', hidden: true }, { id: 'bookmarks', size: 's', hidden: false }];
  assert.deepEqual(r.body.layout, { enabled: true, items: full });
  // only the sent top-level keys change; null counts as not sent
  assert.deepEqual((await call('PATCH', '/api/layout', { enabled: false })).body.layout, { enabled: false, items: full });
  assert.deepEqual((await call('PATCH', '/api/layout', { items: null })).body.layout, { enabled: false, items: full });
  assert.deepEqual((await call('PATCH', '/api/layout', { items: [] })).body.layout, { enabled: false, items: [] });
  assert.deepEqual((await call('PATCH', '/api/layout', {})).body.layout, { enabled: false, items: [] });
  await call('PATCH', '/api/layout', { enabled: true, items });

  const bad = async (body) => {
    const x = await call('PATCH', '/api/layout', body);
    assert.equal(x.status, 400);
    assert.equal(x.body.error.code, 'validation');
    return x.body.error.fields;
  };
  assert.deepEqual(await bad({ items: [{ id: 'nope' }, { id: 'group:Nope' }, { id: 'stats', size: 'xl', hidden: 1, extra: 1 }], extra: 1 }), {
    'items.0.id': 'unknown tile id',
    'items.1.id': 'unknown tile id',
    'items.2.size': "Input should be 's', 'm' or 'l'",
    'items.2.hidden': 'Input should be a valid boolean',
    'items.2.extra': 'unknown field',
    extra: 'unknown field',
  });
  assert.deepEqual(await bad({ items: [{ id: 'stats' }, { id: 'stats' }] }), { items: 'tile ids must be unique' });
  assert.deepEqual(await bad({ items: [{}] }), { 'items.0.id': 'required' });
  assert.deepEqual(await bad({ enabled: 'yes', items: {} }), { enabled: 'Input should be a valid boolean', items: 'Input should be a valid list' });
  const many = Array.from({ length: 22 }, (_, i) => ({ id: 'stats' + i }));
  assert.match((await bad({ items: many })).items, /^List should have at most 21 items/);
  assert.deepEqual(await bad([]), { body: 'must be a JSON object' });
  assert.deepEqual((await call('GET', '/api/layout')).body.layout, { enabled: true, items: full }, 'a failed PATCH changes nothing');

  assert.deepEqual((await call('DELETE', '/api/layout')).body, { layout: def });
  assert.deepEqual((await call('GET', '/api/layout')).body, { layout: def });
});

test('layout needs a session', async () => {
  const { call } = setup();
  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/layout')).status, 401);
  assert.equal((await call('PATCH', '/api/layout', { enabled: true })).status, 401);
});

test('backup export and import', async () => {
  const { call } = setup();
  const doc = (await call('GET', '/api/backup')).body;
  assert.equal(doc.version, 1);
  assert.equal(doc.services.length, 18);
  assert.deepEqual(Object.keys(doc.services[0]).sort(), ['category', 'check', 'description', 'icon', 'name', 'url']);
  const bad = await call('POST', '/api/backup', { ...doc, settings: { theme: 'neon' } });
  assert.equal(bad.body.error.fields['settings.theme'], "Input should be 'auto', 'light' or 'dark'");
  const res = await call('POST', '/api/backup', { version: 1, settings: { pageTitle: 'Restored' }, services: doc.services.slice(0, 2), bookmarks: [] });
  assert.equal(res.body.settings.pageTitle, 'Restored');
  assert.equal(res.body.settings.userName, '', 'settings merge onto defaults, not the current values');
  assert.equal(res.body.services.length, 2);
  assert.equal(res.body.bookmarks.length, 0);
});

test('backup carries the layout: export, import, missing resets, invalid changes nothing', async () => {
  const { call } = setup();
  const layout = { enabled: true, items: [{ id: 'group:Dev', size: 'm', hidden: false }] };
  await call('PATCH', '/api/layout', layout);
  const doc = (await call('GET', '/api/backup')).body;
  assert.deepEqual(doc.layout, layout);
  await call('DELETE', '/api/layout');
  const res = await call('POST', '/api/backup', doc);
  assert.deepEqual(res.body.layout, layout);
  assert.deepEqual((await call('GET', '/api/layout')).body.layout, layout);
  // fields are filled with defaults on import
  const short = await call('POST', '/api/backup', { ...doc, layout: { items: [{ id: 'stats' }] } });
  assert.deepEqual(short.body.layout, { enabled: false, items: [{ id: 'stats', size: 's', hidden: false }] });
  // an older backup without a layout resets it
  await call('PATCH', '/api/layout', layout);
  const { layout: _drop, ...old } = doc;
  assert.deepEqual((await call('POST', '/api/backup', old)).body.layout, { enabled: false, items: [] });
  // invalid layout: validation error, nothing changed
  await call('PATCH', '/api/layout', layout);
  const before = (await call('GET', '/api/bootstrap')).body;
  const bad = await call('POST', '/api/backup', { ...doc, layout: { items: [{ id: 'nope' }] }, settings: { pageTitle: 'X' }, services: [], bookmarks: [] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.fields['layout.items.0.id'], 'unknown tile id');
  assert.deepEqual((await call('GET', '/api/bootstrap')).body, before);
});

test('admin: users, conflicts, last admin, roles, registration switch', async () => {
  const { call } = setup();
  const users = (await call('GET', '/api/admin/users')).body.users;
  assert.equal(users.length, 3);
  assert.ok('created_at' in users[0]);
  const dup = await call('POST', '/api/admin/users', { email: 'x@home.arpa', username: 'JORDAN', password: 'x'.repeat(10) });
  assert.deepEqual([dup.status, dup.body.error.fields], [409, { username: 'taken' }]);
  const c = await call('POST', '/api/admin/users', { email: 'casey@home.arpa', username: 'casey', password: 'casey-password-1', role: 'user' });
  assert.equal(c.status, 201);
  const me = users.find((u) => u.username === 'demo');
  assert.equal((await call('PATCH', '/api/admin/users/' + me.id, { role: 'user' })).body.error.code, 'last_admin');
  assert.equal((await call('DELETE', '/api/admin/users/' + me.id)).body.error.code, 'last_admin');
  assert.equal((await call('PATCH', '/api/admin/users/' + c.body.user.id, { role: 'admin' })).body.user.role, 'admin');
  assert.equal((await call('PATCH', '/api/admin/users/' + c.body.user.id, { password: 'casey-password-2' })).status, 200);
  assert.equal((await call('PUT', '/api/admin/config', { registration_open: true })).body.registration_open, true);
  assert.equal((await call('GET', '/api/auth/state')).body.registration_open, true);

  // the new user can sign in and gets their own empty dashboard; non-admins get 403 on admin routes
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { identifier: 'jordan', password: 'jordan-password-1' });
  assert.equal((await call('GET', '/api/bootstrap')).body.services.length, 0);
  assert.deepEqual((await call('GET', '/api/admin/users')).body.error, { code: 'forbidden', message: 'Admin access required' });
  assert.equal((await call('GET', '/api/stats')).status, 403);
  await call('POST', '/api/auth/logout');
  const reg = await call('POST', '/api/auth/register', { email: 'new@home.arpa', username: 'newbie', password: 'x'.repeat(10) });
  assert.equal(reg.body.user.role, 'user');
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { identifier: 'demo', password: DEMO_PASSWORD });
  assert.equal((await call('DELETE', '/api/admin/users/' + c.body.user.id)).status, 204);
  assert.equal((await call('DELETE', '/api/admin/users/' + c.body.user.id)).status, 404);
});

test('canonicalId accepts the UUID spellings Python accepts', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (const v of [id, id.toUpperCase(), id.replace(/-/g, ''), `{${id}}`, `urn:uuid:${id}`]) assert.equal(canonicalId(v), id);
  assert.throws(() => canonicalId('nope'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError, normalizeFields } from '../static/js/api.js';
import { createBootCache } from '../static/js/cache.js';
import { memoryStorage, clearUserData, UI_KEY, KEY_PREFIX } from '../static/js/storage.js';

/** @param {{ status?: number, body?: any, headers?: Record<string,string> }} r */
function response({ status = 200, body = null, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k] ?? null },
    text: async () => (body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function setup(handler, extra = {}) {
  const calls = [];
  const unauth = [];
  const fetchImpl = async (path, init) => {
    calls.push({ path, init });
    return handler(path, init, calls.length);
  };
  const api = createApi({ fetchImpl, onUnauthenticated: (e) => unauth.push(e), ...extra });
  return { api, calls, unauth };
}

test('GET sends no body/content-type; POST sends JSON and content-type', async () => {
  const { api, calls } = setup(() => response({ body: { ok: 1 } }));
  await api.get('/api/me');
  await api.post('/api/x', { a: 1 });
  await api.post('/api/auth/logout');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].init.body, '{"a":1}');
  assert.equal(calls[2].init.headers['Content-Type'], 'application/json', 'bodiless POST still carries the JSON content type (CSRF rule)');
  assert.equal(calls[2].init.body, undefined);
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('204 resolves to null', async () => {
  const { api } = setup(() => response({ status: 204 }));
  assert.equal(await api.del('/api/services/1'), null);
});

test('error envelope becomes ApiError with code, message and fields', async () => {
  const { api } = setup(() => response({ status: 400, body: { error: { code: 'validation', message: 'Check the form.', fields: { name: 'Required', url: ['Bad', 'Worse'] } } } }));
  await assert.rejects(api.post('/api/services', {}), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'validation');
    assert.equal(e.message, 'Check the form.');
    assert.deepEqual(e.fields, { name: 'Required', url: 'Bad Worse' });
    return true;
  });
});

test('401 unauthenticated triggers the handler exactly once and still rejects', async () => {
  const { api, unauth } = setup(() => response({ status: 401, body: { error: { code: 'unauthenticated', message: 'No session' } } }));
  await assert.rejects(api.get('/api/bootstrap'), (e) => e.status === 401);
  assert.equal(unauth.length, 1);
});

test('401 invalid_credentials (login) does NOT trigger the session-expired handler', async () => {
  const { api, unauth } = setup(() => response({ status: 401, body: { error: { code: 'invalid_credentials', message: 'Wrong.' } } }));
  await assert.rejects(api.post('/api/auth/login', {}), (e) => e.code === 'invalid_credentials');
  assert.equal(unauth.length, 0);
});

test('silent401 suppresses the handler', async () => {
  const { api, unauth } = setup(() => response({ status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } }));
  await assert.rejects(api.post('/api/auth/logout', undefined, { silent401: true }));
  assert.equal(unauth.length, 0);
});

test('a 401 without a JSON error body is treated as unauthenticated', async () => {
  const { api, unauth } = setup(() => response({ status: 401, body: '<html>proxy</html>' }));
  await assert.rejects(api.get('/api/me'));
  assert.equal(unauth.length, 1);
});

test('429 carries Retry-After into the message', async () => {
  const { api } = setup(() => response({ status: 429, headers: { 'Retry-After': '42' }, body: { error: { code: 'rate_limited' } } }));
  await assert.rejects(api.post('/api/auth/login', {}), (e) => {
    assert.equal(e.retryAfter, 42);
    assert.match(e.message, /42 seconds/);
    return true;
  });
});

test('network failure and timeout are normalised', async () => {
  const net = createApi({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(net.get('/x'), (e) => e.code === 'network' && e.status === 0);
  const slow = createApi({
    fetchImpl: (_p, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))),
    timeoutMs: 20,
  });
  await assert.rejects(slow.get('/x'), (e) => e.code === 'timeout');
});

test('non-JSON error pages fall back to a readable message', async () => {
  const { api } = setup(() => response({ status: 502, body: '<html>Bad gateway</html>' }));
  await assert.rejects(api.get('/x'), (e) => e.status === 502 && /server/i.test(e.message));
});

test('normalizeFields accepts map, list and FastAPI-style shapes', () => {
  assert.deepEqual(normalizeFields({ a: 'x' }), { a: 'x' });
  assert.deepEqual(normalizeFields([{ field: 'a', message: 'x' }]), { a: 'x' });
  assert.deepEqual(normalizeFields([{ loc: ['body', 'url'], msg: 'bad' }]), { url: 'bad' });
  assert.deepEqual(normalizeFields(null), {});
  assert.deepEqual(normalizeFields('nope'), {});
});

test('clearUserData removes user keys but keeps the device UI preference', () => {
  const kv = memoryStorage();
  kv.setItem(UI_KEY, '{"theme":"dark"}');
  kv.setItem(KEY_PREFIX + 'boot:u1', '{}');
  kv.setItem(KEY_PREFIX + 'last-user', 'u1');
  kv.setItem('other-app', 'keep');
  clearUserData(kv);
  assert.equal(kv.getItem(UI_KEY), '{"theme":"dark"}');
  assert.equal(kv.getItem(KEY_PREFIX + 'boot:u1'), null);
  assert.equal(kv.getItem(KEY_PREFIX + 'last-user'), null);
  assert.equal(kv.getItem('other-app'), 'keep');
});

test('boot cache is keyed by user id and never serves another user', () => {
  const kv = memoryStorage();
  let t = 1000;
  const cache = createBootCache(kv, () => t);
  assert.equal(cache.read(), null);
  const a = { user: { id: 'a' }, settings: {}, services: [{ id: 's' }], bookmarks: [] };
  cache.write(a);
  assert.equal(cache.read().user.id, 'a');
  const b = { user: { id: 'b' }, settings: {}, services: [], bookmarks: [] };
  cache.write(b);
  assert.equal(cache.read().user.id, 'b');
  assert.equal(kv.getItem(KEY_PREFIX + 'boot:a'), null, "previous user's entry is removed");
  // tampered: entry for another id
  kv.setItem(KEY_PREFIX + 'boot:b', JSON.stringify({ t, data: a }));
  assert.equal(cache.read(), null);
  // stale
  cache.write(b);
  t += 8 * 24 * 3600 * 1000;
  assert.equal(cache.read(), null);
});

test('signing in as someone else drops the previous user\'s cached dashboard', () => {
  // read() cannot know who is signed in: a session that ended without a 401 in
  // this browser (expired while it was closed) left user a's payload behind.
  const kv = memoryStorage();
  kv.setItem(UI_KEY, '{"theme":"dark"}');
  const cache = createBootCache(kv, () => 1000);
  cache.write({ user: { id: 'a' }, settings: {}, services: [{ id: 's', name: 'private' }], bookmarks: [] });
  cache.forgetOthers('a');
  assert.equal(cache.read().user.id, 'a', 'the same user keeps the instant first paint');
  cache.forgetOthers('b');
  assert.equal(cache.read(), null, "b never gets a's services");
  assert.equal(kv.getItem(KEY_PREFIX + 'boot:a'), null);
  assert.equal(kv.getItem(UI_KEY), '{"theme":"dark"}', 'the device look survives');
});

test('onWrite fires after successful writes only (so other tabs can refresh)', async () => {
  let writes = 0;
  let status = 200;
  const { api } = setup(() => response({ status, body: status === 204 ? null : { ok: 1 } }), { onWrite: () => writes++ });
  await api.get('/api/me');
  assert.equal(writes, 0, 'reads do not notify');
  await api.post('/api/services', { name: 'x' });
  await api.del('/api/services/1');
  assert.equal(writes, 2);
  status = 204;
  await api.patch('/api/settings', {});
  assert.equal(writes, 3, 'a 204 counts as success');
  status = 422;
  await assert.rejects(api.post('/api/services', {}));
  assert.equal(writes, 3, 'failed writes do not notify');
});

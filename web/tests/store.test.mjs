import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, normalizeSettings, DEFAULT_SETTINGS } from '../static/js/store.js';
import { deepMerge, clone, isPlainObject, pick } from '../static/js/lib/merge.js';
import { ApiError } from '../static/js/api.js';

/** Fake api recording every call; PATCH echoes a server-side merge. */
function fakeApi({ failPatch = null, delayMs = 0 } = {}) {
  const calls = [];
  let server = clone(DEFAULT_SETTINGS);
  const api = {
    async patch(path, body) {
      calls.push({ method: 'PATCH', path, body: clone(body) });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (failPatch) throw failPatch;
      server = deepMerge(server, body);
      return { settings: clone(server) };
    },
    async del(path) {
      calls.push({ method: 'DELETE', path });
      server = clone(DEFAULT_SETTINGS);
      return { settings: clone(server) };
    },
  };
  return { api, calls, server: () => server };
}

test('deepMerge: recursive, immutable, arrays replace, undefined skipped', () => {
  const base = { a: 1, o: { x: 1, y: 2 }, arr: [1, 2] };
  const out = deepMerge(base, { o: { y: 3 }, arr: [9], a: undefined });
  assert.deepEqual(out, { a: 1, o: { x: 1, y: 3 }, arr: [9] });
  assert.deepEqual(base, { a: 1, o: { x: 1, y: 2 }, arr: [1, 2] });
});

test('deepMerge ignores prototype-pollution keys', () => {
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"p": 1}}, "ok": 1}');
  const out = deepMerge({}, evil);
  assert.equal(out.ok, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(out, 'constructor'), false);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.deepEqual(pick({ a: 1, b: 2 }, ['b', 'zz']), { b: 2 });
});

test('normalizeSettings fills gaps with defaults', () => {
  const s = normalizeSettings({ theme: 'dark', wallpaper: { mode: 'none' } });
  assert.equal(s.theme, 'dark');
  assert.equal(s.wallpaper.mode, 'none');
  assert.equal(s.wallpaper.showGrid, true);
  assert.equal(s.features.statusChecks, true);
  assert.equal(normalizeSettings(null).accent, '#5E6AD2');
});

test('several quick updates produce ONE patch containing all of them', async () => {
  const { api, calls } = fakeApi();
  const store = createSettingsStore({ api, debounceMs: 5 });
  store.update({ userName: 'Ada' });
  store.update({ pageTitle: 'Lab' });
  store.update({ userName: 'Ada L.' });
  store.update({ features: { clock: false } });
  await store.flush();
  assert.equal(calls.length, 1, 'exactly one PATCH');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].path, '/api/settings');
  assert.equal(calls[0].body.userName, 'Ada L.');
  assert.equal(calls[0].body.pageTitle, 'Lab');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['features', 'pageTitle', 'userName']);
});

test('the debounce timer sends without an explicit flush, once', async () => {
  const { api, calls } = fakeApi();
  const store = createSettingsStore({ api, debounceMs: 10 });
  store.update({ subtitle: 'a' });
  store.update({ subtitle: 'ab' });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.subtitle, 'ab');
});

test('nested objects are sent whole, never half-filled', async () => {
  const { api, calls } = fakeApi();
  const store = createSettingsStore({ api, debounceMs: 5 });
  store.update({ wallpaper: { showGrid: false } });
  await store.flush();
  assert.deepEqual(calls[0].body.wallpaper, { mode: 'gradient', gradient: 'grid', url: '', showGrid: false });
  assert.equal(store.get().wallpaper.showGrid, false);
});

test('an edit made while a save is in flight is neither lost nor overwritten', async () => {
  const { api, calls } = fakeApi({ delayMs: 30 });
  const store = createSettingsStore({ api, debounceMs: 1000 });
  store.update({ userName: 'first' });
  const p = store.flush();
  await new Promise((r) => setTimeout(r, 5));
  store.update({ userName: 'second' }); // while the first PATCH is pending
  await p;
  assert.equal(store.get().userName, 'second', 'local edit survives the response of the earlier save');
  await store.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.userName, 'second');
});

test('a rejected patch rolls the keys back and reports the error', async () => {
  const err = new ApiError({ status: 400, code: 'validation', message: 'bad accent', fields: { accent: 'must be #rrggbb' } });
  const { api } = fakeApi({ failPatch: err });
  const store = createSettingsStore({ api, initial: { accent: '#112233' }, debounceMs: 5 });
  const seen = [];
  store.onSaveState((i) => seen.push(i.status));
  store.update({ accent: 'nope' });
  assert.equal(store.get().accent, 'nope', 'optimistic');
  await store.flush();
  assert.equal(store.get().accent, '#112233', 'rolled back');
  assert.equal(store.saveInfo().status, 'error');
  assert.equal(store.saveInfo().error.fields.accent, 'must be #rrggbb');
  assert.deepEqual(seen, ['saving', 'saving', 'error']);
});

test('reset calls DELETE /api/settings and adopts the defaults', async () => {
  const { api, calls } = fakeApi();
  const store = createSettingsStore({ api, initial: { userName: 'Ada', theme: 'dark' }, debounceMs: 5 });
  store.update({ userName: 'Bob' }); // pending edit must be dropped
  await store.reset();
  const del = calls.filter((c) => c.method === 'DELETE');
  assert.equal(del.length, 1);
  assert.equal(del[0].path, '/api/settings');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0, 'pending edit was dropped, not sent');
  assert.equal(store.get().userName, '');
  assert.equal(store.get().theme, 'auto');
});

test('replace() drops pending edits and notifies as remote', async () => {
  const { api, calls } = fakeApi();
  const store = createSettingsStore({ api, debounceMs: 5 });
  const sources = [];
  store.subscribe((_s, src) => sources.push(src));
  store.update({ userName: 'x' });
  store.replace({ userName: 'server' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
  assert.equal(store.get().userName, 'server');
  assert.deepEqual(sources, ['local', 'remote']);
});

test('update ignores non-objects and dangerous keys', () => {
  const { api } = fakeApi();
  const store = createSettingsStore({ api, debounceMs: 1000 });
  store.update(null);
  store.update('x');
  store.update(JSON.parse('{"__proto__": {"x": 1}}'));
  assert.equal({}.x, undefined);
  assert.equal(store.saveInfo().status, 'idle');
});

// Parity with serverhub/api/schemas.py for the rules the web UI depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/validate.js';

const fields = (model, data) => {
  try {
    S.validate(model, data);
  } catch (e) {
    assert.ok(e instanceof S.ValidationError);
    return e.fields;
  }
  return null;
};

test('settings defaults match the backend', () => {
  assert.deepEqual(S.defaultSettings(), {
    theme: 'dark',
    accent: '#5E6AD2',
    userName: '',
    pageTitle: '',
    subtitle: '',
    defaultDomain: '',
    wallpaper: { mode: 'none', gradient: 'default', url: '', showGrid: false },
    features: { clock: true, greeting: true, stats: true, search: true, statusChecks: true },
    search: { provider: 'duckduckgo', searxngUrl: '' },
  });
});

test('settings: strict types, literals, patterns, nested paths, unknown keys', () => {
  assert.deepEqual(fields(S.Settings, { theme: 'blue', accent: '#12345', userName: 'x'.repeat(101), features: { clock: 'yes', fancy: true }, wallpaper: { mode: 'image', url: 'http://img.example/a.png' }, extra: 1 }), {
    theme: "Input should be 'auto', 'light' or 'dark'",
    accent: "String should match pattern '^#[0-9a-fA-F]{6}$'",
    userName: 'String should have at most 100 characters',
    'wallpaper.url': 'must be an https:// URL',
    'features.clock': 'Input should be a valid boolean',
    'features.fancy': 'unknown field',
    extra: 'unknown field',
  });
  assert.deepEqual(fields(S.Settings, { defaultDomain: 'bad domain', search: { provider: 'searxng', searxngUrl: 'not a url' } }), {
    defaultDomain: "String should match pattern '^[A-Za-z0-9.:-]{0,253}$'",
    'search.searxngUrl': 'must not contain spaces',
  });
  assert.equal(fields(S.Settings, { wallpaper: { mode: 'image', url: '/static/img/x.png' } }), null);
  assert.equal(fields(S.Settings, { wallpaper: { url: '/static/../x.png' } })['wallpaper.url'], 'must be a valid http(s) URL');
  assert.equal(fields(S.Settings, { wallpaper: 'ocean' }).wallpaper, 'Input should be a valid dictionary or instance of Wallpaper');
  assert.deepEqual(fields(S.Settings, []), { body: 'must be a JSON object' });
});

test('deepMerge merges dicts and replaces everything else', () => {
  assert.deepEqual(S.deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] }), { a: { b: 1, c: 3 }, d: [2] });
});

test('services: required fields, URL rules, icon and category ids', () => {
  assert.deepEqual(fields(S.ServiceCreate, {}), { name: 'required', url: 'required' });
  assert.deepEqual(fields(S.ServiceCreate, { name: '   ', url: 'ftp://x', icon: 'rocket', category: 'Stuff', check: 1 }), {
    name: 'String should have at least 1 character',
    url: 'must be a valid http(s) URL',
    icon: 'unknown icon id',
    category: 'unknown category id',
    check: 'Input should be a valid boolean',
  });
  for (const bad of ['http://', 'https://a b.example', 'http://host:0/', 'http://host:70000/', 'javascript:alert(1)', 'http://a​.example', 'x'.repeat(2001)]) {
    assert.ok(fields(S.ServiceCreate, { name: 'n', url: bad }), bad);
  }
  const ok = S.validate(S.ServiceCreate, { name: '  Grafana ', url: ' https://grafana.home.arpa:3000/d ', category: null });
  assert.deepEqual(ok, { name: 'Grafana', url: 'https://grafana.home.arpa:3000/d', description: '', icon: 'box', category: null, check: true });
  assert.equal(fields(S.ServiceCreate, { name: 'x'.repeat(201), url: 'http://a' }).name, 'String should have at most 200 characters');
});

test('patches only return sent keys and reject nulls (category may be null)', () => {
  assert.deepEqual(S.validatePatch(S.ServicePatch, { category: null }, ['category']), { category: null });
  assert.deepEqual(S.validatePatch(S.ServicePatch, { name: 'A' }, ['category']), { name: 'A' });
  assert.throws(() => S.validatePatch(S.ServicePatch, { name: null }, ['category']), (e) => e.fields.name === 'must not be null');
  assert.throws(() => S.validatePatch(S.BookmarkPatch, { color: 'red' }), (e) => /pattern/.test(e.fields.color));
});

test('beszel URLs: no query, fragment, credentials or odd paths', () => {
  const base = { username: 'u', password: 'p' };
  assert.equal(fields(S.BeszelCreate, { ...base, url: 'https://beszel.home.arpa/sub_path-1/' }), null);
  for (const [url, msg] of [
    ['https://b.home.arpa/?x=1', 'must not contain a query, fragment or credentials'],
    ['https://b.home.arpa/#x', 'must not contain a query, fragment or credentials'],
    ['https://user:pw@b.home.arpa', 'must not contain a query, fragment or credentials'],
    ['https://b.home.arpa/a/../b', 'path may only contain letters, digits and . _ ~ - /'],
    ['https://b.home.arpa/a%20b', 'path may only contain letters, digits and . _ ~ - /'],
  ]) assert.equal(fields(S.BeszelCreate, { ...base, url }).url, msg, url);
  assert.deepEqual(fields(S.BeszelCreate, { url: 'https://b' }), { username: 'required', password: 'required' });
});

test('accounts: email, username and password rules', () => {
  assert.deepEqual(fields(S.AdminUserCreate, { email: 'nope', username: 'ab', password: 'short', role: 'root' }), {
    email: 'must be a valid email address',
    username: "String should match pattern '^[a-zA-Z0-9_]{3,20}$'",
    password: 'String should have at least 10 characters',
    role: "Input should be 'admin' or 'user'",
  });
  assert.equal(S.validate(S.AdminUserCreate, { email: ' Casey@Home.ARPA ', username: 'casey', password: 'x'.repeat(10) }).email, 'casey@home.arpa');
  assert.equal(fields(S.AdminUserPatch, { disable_twofa: false }).disable_twofa, 'Input should be True');
  assert.equal(fields(S.CodeIn, { code: '   ' }).code, 'String should have at least 1 character');
});

test('backup documents: version, list limits, extra keys ignored inside items', () => {
  assert.deepEqual(fields(S.BackupDoc, {}), { version: 'required' });
  assert.equal(fields(S.BackupDoc, { version: 2 }).version, 'Input should be 1');
  assert.equal(fields(S.BackupDoc, { version: 1, junk: 1 }).junk, 'unknown field');
  const doc = S.validate(S.BackupDoc, { version: 1, services: [{ id: 'x', created_at: 'y', name: 'A', url: 'http://a.home.arpa' }] });
  assert.deepEqual(doc.services[0], { name: 'A', url: 'http://a.home.arpa', description: '', icon: 'box', category: null, check: true });
  assert.equal(fields(S.BackupDoc, { version: 1, bookmarks: [{ name: 'A', url: 'bad' }] })['bookmarks.0.url'], 'must be a valid http(s) URL');
  assert.match(fields(S.BackupDoc, { version: 1, services: new Array(501).fill({}) }).services, /at most 500 items/);
});

test('URLs without a host are refused like urlsplit does (WHATWG would read "https:///x" as host "x")', () => {
  for (const url of ['https:///path', 'http:///', 'https://:8080/x', 'https://user@/x']) {
    assert.equal(S.urlSyntaxOk(url), false, url);
    assert.throws(() => S.validate(S.ServiceCreate, { name: 'a', url }), S.ValidationError, url);
  }
  for (const url of ['https://a.example.com', 'http://[::1]:8080/x', 'https://nas:8443/']) assert.equal(S.urlSyntaxOk(url), true, url);
});

test('layout: defaults, tile ids, sizes, uniqueness, limits, strict keys', () => {
  assert.deepEqual(S.defaultLayout(), { enabled: false, items: [] });
  assert.deepEqual(S.validate(S.Layout, { items: [{ id: 'group:Media' }] }), { enabled: false, items: [{ id: 'group:Media', size: 's', hidden: false }] });
  assert.equal(S.MAX_TILES, 2 + S.KNOWN_CATEGORIES.size);
  assert.deepEqual(fields(S.Layout, { enabled: 1, items: [{ id: 'group:' }, { id: 'x', size: 'S' }], more: 1 }), {
    enabled: 'Input should be a valid boolean',
    'items.0.id': 'unknown tile id',
    'items.1.id': 'unknown tile id',
    'items.1.size': "Input should be 's', 'm' or 'l'",
    more: 'unknown field',
  });
  assert.deepEqual(fields(S.Layout, { items: [{ id: 'bookmarks' }, { id: 'bookmarks' }] }), { items: 'tile ids must be unique' });
  assert.equal(fields(S.Layout, { items: Array.from({ length: S.MAX_TILES + 1 }, () => ({ id: 'stats' })) }).items, `List should have at most ${S.MAX_TILES} items after validation, not ${S.MAX_TILES + 1}`);
  assert.equal(fields(S.LayoutPatch, { enabled: null, items: null }), null, 'null means not sent');
  assert.deepEqual(fields(S.BackupDoc, { version: 1, layout: { items: [{ id: 'nope' }] } }), { 'layout.items.0.id': 'unknown tile id' });
  assert.equal(fields(S.BackupDoc, { version: 1, layout: null }), null);
});

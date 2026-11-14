import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoCategorize, resolveCategory, suggestIcon, tokenize, CATEGORIES, KEYWORD_RULES, RANK,
} from '../static/js/categorize.js';
import { ICON_SET, ICON_IDS } from '../static/js/lib/icon-ids.js';

test('tokenize splits on non-alphanumerics and lowercases', () => {
  assert.deepEqual(tokenize('Pi-Hole_v6 (Admin)'), ['pi', 'hole', 'v6', 'admin']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('whole-word matching: "git" does not match inside other words', () => {
  assert.equal(autoCategorize('Digital Signage', 'https://signage.example.com').category, 'Other');
  assert.equal(autoCategorize('Legit stuff', 'https://legit.example.com').category, 'Other');
  assert.equal(autoCategorize('Git server', 'https://git.example.com').category, 'Dev');
  assert.equal(autoCategorize('Gitea', 'https://gitea.example.com').category, 'Dev');
});

test('separators are ignored: pi-hole, Pi Hole and pihole are the same', () => {
  for (const name of ['Pi-hole', 'Pi Hole', 'pihole', 'PIHOLE']) {
    assert.equal(autoCategorize(name, 'https://x.example.com').category, 'Network', name);
  }
  assert.equal(autoCategorize('x', 'https://pi-hole.home.arpa/admin').category, 'Network');
});

test('multi-word keywords match consecutive tokens only', () => {
  assert.equal(autoCategorize('Home Assistant', 'https://ha.example.com').category, 'Home');
  assert.equal(autoCategorize('Assistant for home', 'https://x.example.com').category, 'Other');
});

test('host is used as evidence', () => {
  assert.equal(autoCategorize('Dashboard', 'https://grafana.example.com').category, 'Monitoring');
  assert.equal(autoCategorize('Dashboard', 'grafana.home.arpa:3000').category, 'Monitoring');
});

test('name and host win over the free-text description', () => {
  // description mentions "steam" (Gaming) but the name is Jellyfin (Media)
  const r = autoCategorize('Jellyfin', 'https://media.example.com', 'streams to steam deck');
  assert.equal(r.category, 'Media');
  assert.equal(r.matched, 'jellyfin');
});

test('description is used when name and host say nothing', () => {
  assert.equal(autoCategorize('Foo', 'https://foo.example.com', 'my grafana dashboards').category, 'Monitoring');
});

test('qBittorrent WebUI is Files, not AI (generic "webui" is not a keyword)', () => {
  assert.equal(autoCategorize('qBittorrent WebUI', 'https://q.example.com').category, 'Files');
  assert.equal(autoCategorize('Open WebUI', 'https://chat.example.com').category, 'AI');
});

test('RANK decides between categories', () => {
  // vaultwarden: Security ranks before everything
  assert.equal(autoCategorize('Vaultwarden', 'https://v.example.com').category, 'Security');
});

test('unknown input falls back to Other and never throws', () => {
  assert.deepEqual(autoCategorize('', ''), { category: 'Other', matched: null });
  assert.equal(autoCategorize(undefined, undefined, undefined).category, 'Other');
  assert.equal(autoCategorize('x', 'not a url %%%').category, 'Other');
});

test('resolveCategory: null means auto, and auto follows edits', () => {
  const svc = { name: 'Grafana', url: 'https://g.example.com', description: '', category: null };
  assert.equal(resolveCategory(svc), 'Monitoring');
  assert.equal(resolveCategory({ ...svc, name: 'Gitea' }), 'Dev');
  assert.equal(resolveCategory({ ...svc, category: 'Media' }), 'Media');
  assert.equal(resolveCategory({ ...svc, category: 'NotACategory' }), 'Monitoring');
});

test('every rule category is a known category and every RANK entry has rules', () => {
  for (const c of Object.keys(KEYWORD_RULES)) assert.ok(CATEGORIES.includes(c), c);
  for (const c of RANK) assert.ok(Object.hasOwn(KEYWORD_RULES, c), c);
  assert.equal(CATEGORIES.length, 19);
  assert.ok(CATEGORIES.includes('Other'));
});

test('suggestIcon always returns a known icon id', () => {
  for (const c of CATEGORIES) assert.ok(ICON_SET.has(suggestIcon(c, 'whatever')), c);
  assert.equal(suggestIcon('Dev', 'Gitea'), 'git');
  assert.equal(suggestIcon('Other', 'Steam link'), 'gamepad');
  assert.equal(suggestIcon('Nope', 'x'), 'box');
  assert.equal(suggestIcon('Files', 'qBittorrent'), 'download');
});

test('icon list has the 59 ids of the old UI', () => {
  assert.equal(ICON_IDS.length, 59);
  assert.equal(new Set(ICON_IDS).size, 59);
});

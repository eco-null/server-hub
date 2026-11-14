import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDiscovered,
  urlKey,
  mergeServices,
  stateLabel,
  healthLabel,
  containerBadge,
  containerTitle,
  emptyDockerView,
  nextDockerView,
  unavailableNotice,
  formatPort,
  hiddenDuplicates,
  suggestionToDraft,
} from '../static/js/lib/docker.js';
import { groupServices } from '../static/js/features/services.js';
import { rankServices } from '../static/js/lib/search.js';

const container = (o = {}) => ({ name: 'grafana', image: 'grafana/grafana:11', state: 'running', status: 'Up 3 days', health: null, ...o });
const disc = (id, url, o = {}) => ({ id: 'docker:' + id, name: 'D ' + id, url, description: '', icon: 'box', category: null, check: true, container: container(), ...o });
const own = (id, url, o = {}) => ({ id, name: 'Own ' + id, url, description: '', icon: 'box', category: null, check: true, ...o });

test('isDiscovered recognises the docker: id prefix only', () => {
  assert.equal(isDiscovered({ id: 'docker:abc' }), true);
  assert.equal(isDiscovered({ id: 'abc' }), false);
  assert.equal(isDiscovered({ id: 'xdocker:abc' }), false);
  assert.equal(isDiscovered({}), false);
});

test('urlKey: case, default ports, trailing slash and fragment do not matter; scheme, port and path do', () => {
  const k = urlKey('https://Grafana.Example.com/');
  assert.equal(k, 'https://grafana.example.com');
  assert.equal(urlKey('https://grafana.example.com:443'), k);
  assert.equal(urlKey('https://grafana.example.com/#top'), k);
  assert.equal(urlKey('http://grafana.example.com:80/'), 'http://grafana.example.com');
  assert.notEqual(urlKey('http://grafana.example.com'), k);
  assert.notEqual(urlKey('https://grafana.example.com:8443'), k);
  assert.equal(urlKey('https://x.example.com/a/b/'), 'https://x.example.com/a/b');
  assert.notEqual(urlKey('https://x.example.com/a'), urlKey('https://x.example.com/b'));
  assert.notEqual(urlKey('https://x.example.com/?a=1'), urlKey('https://x.example.com/'));
});

test('urlKey: invalid or unsafe URLs have no key', () => {
  for (const bad of ['', 'nope', 'javascript:alert(1)', 'ftp://x.example.com', null, undefined, 42]) assert.equal(urlKey(bad), null, String(bad));
});

test('mergeServices: own wins on an equal address, everything else is kept', () => {
  const mine = [own('1', 'https://grafana.example.com/'), own('2', 'http://nas:8080')];
  const found = [disc('a', 'https://GRAFANA.example.com:443'), disc('b', 'http://nas:8081'), disc('c', 'http://nas:8080/')];
  const merged = mergeServices(mine, found);
  assert.deepEqual(
    merged.map((s) => s.id),
    ['1', '2', 'docker:b'],
  );
});

test('mergeServices: invalid discovered URLs are kept, two containers on one URL both stay, own list untouched when nothing found', () => {
  const mine = [own('1', 'https://a.example.com')];
  assert.equal(mergeServices(mine, []), mine);
  const merged = mergeServices(mine, [disc('x', 'not a url'), disc('y', 'http://h:1'), disc('z', 'http://h:1')]);
  assert.deepEqual(
    merged.map((s) => s.id),
    ['1', 'docker:x', 'docker:y', 'docker:z'],
  );
});

test('mergeServices: an invalid own URL never hides a discovered service', () => {
  const merged = mergeServices([own('1', 'garbage')], [disc('a', 'garbage')]);
  assert.equal(merged.length, 2);
});

test('merged services group like the user\'s own (auto-categorised) and rank in search', () => {
  const merged = mergeServices([own('1', 'https://wiki.example.com', { name: 'Wiki' })], [disc('a', 'http://h:3000', { name: 'Grafana' }), disc('b', 'http://h:3001', { name: 'Jellyfin', category: 'Files' })]);
  const groups = groupServices(merged);
  const byCat = Object.fromEntries(groups.map((g) => [g.category, g.items.map((i) => i.name)]));
  assert.deepEqual(byCat.Monitoring, ['Grafana']);
  assert.deepEqual(byCat.Files, ['Jellyfin']);
  assert.deepEqual(rankServices(merged, 'graf').map((s) => s.id), ['docker:a']);
});

test('stateLabel and healthLabel', () => {
  assert.equal(stateLabel('exited'), 'Exited');
  assert.equal(stateLabel('weird'), 'Weird');
  assert.equal(stateLabel(''), 'Unknown');
  assert.equal(healthLabel('healthy'), 'Healthy');
  assert.equal(healthLabel(null), 'No health check');
});

test('containerBadge: nothing for a running container that is fine, text and tone otherwise', () => {
  assert.equal(containerBadge({ state: 'running', health: null }), null);
  assert.equal(containerBadge({ state: 'running', health: 'healthy' }), null);
  assert.deepEqual(containerBadge({ state: 'running', health: 'unhealthy' }), { label: 'Unhealthy', tone: 'bad' });
  assert.deepEqual(containerBadge({ state: 'running', health: 'starting' }), { label: 'Starting', tone: 'warn' });
  assert.deepEqual(containerBadge({ state: 'exited', health: null }), { label: 'Exited', tone: 'bad' });
  assert.deepEqual(containerBadge({ state: 'paused', health: null }), { label: 'Paused', tone: 'bad' });
  assert.deepEqual(containerBadge({ state: 'dead', health: null }), { label: 'Dead', tone: 'bad' });
  assert.deepEqual(containerBadge({ state: 'restarting', health: null }), { label: 'Restarting', tone: 'warn' });
  assert.deepEqual(containerBadge({ state: 'created', health: null }), { label: 'Created', tone: 'warn' });
  assert.deepEqual(containerBadge({ state: 'mystery', health: null }), { label: 'Mystery', tone: 'neutral' });
  // Health only matters while running.
  assert.equal(containerBadge({ state: 'exited', health: 'healthy' }).label, 'Exited');
});

test('containerTitle lists name, container, image and status text', () => {
  const t = containerTitle(disc('a', 'http://h:1'));
  assert.deepEqual(t.split('\n'), ['D a', 'Container: grafana', 'Image: grafana/grafana:11', 'Status: Up 3 days']);
  assert.match(containerTitle(disc('a', 'http://h:1'), { stale: true }), /last known state/);
  assert.match(containerTitle(disc('a', 'http://h:1', { container: container({ status: '', state: 'exited' }) })), /Status: Exited/);
});

const fresh = (services) => ({ enabled: true, available: true, error: null, services, skipped: [] });

test('nextDockerView: a fresh list replaces the old one; an identical poll returns the same object', () => {
  const a = nextDockerView(emptyDockerView(), fresh([disc('a', 'http://h:1')]));
  assert.equal(a.enabled, true);
  assert.equal(a.services.length, 1);
  assert.equal(a.stale, false);
  const again = nextDockerView(a, fresh([disc('a', 'http://h:1')]));
  assert.equal(again, a);
  const changed = nextDockerView(a, fresh([disc('a', 'http://h:1', { container: container({ state: 'exited' }) })]));
  assert.notEqual(changed, a);
  assert.equal(changed.services[0].container.state, 'exited');
});

test('nextDockerView: unavailable keeps the last known services, marked stale, with the error', () => {
  const a = nextDockerView(emptyDockerView(), fresh([disc('a', 'http://h:1')]));
  const down = nextDockerView(a, { enabled: true, available: false, error: 'Cannot connect to the socket proxy.', services: [] });
  assert.equal(down.available, false);
  assert.equal(down.stale, true);
  assert.equal(down.services, a.services);
  assert.equal(down.error, 'Cannot connect to the socket proxy.');
  const back = nextDockerView(down, fresh([disc('a', 'http://h:1')]));
  assert.equal(back.available, true);
  assert.equal(back.stale, false);
  assert.equal(back.error, null);
});

test('nextDockerView: unavailable on the first load shows no cards and is not stale', () => {
  const down = nextDockerView(emptyDockerView(), { enabled: true, available: false, error: 'nope', services: [] });
  assert.deepEqual(down.services, []);
  assert.equal(down.stale, false);
  assert.equal(down.available, false);
});

test('nextDockerView: disabled clears everything; an unusable response changes nothing', () => {
  const a = nextDockerView(emptyDockerView(), fresh([disc('a', 'http://h:1')]));
  const off = nextDockerView(a, { enabled: false, available: false, error: null, services: [] });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.services, []);
  assert.equal(nextDockerView(a, null), a);
  assert.equal(nextDockerView(a, 'oops'), a);
});

test('nextDockerView: malformed entries are dropped', () => {
  const v = nextDockerView(emptyDockerView(), fresh([disc('ok', 'http://h:1'), { id: 'plain', name: 'x', url: 'http://x', container: {} }, null, { id: 'docker:nocontainer', name: 'n', url: 'http://x' }]));
  assert.deepEqual(
    v.services.map((s) => s.id),
    ['docker:ok'],
  );
});

test('unavailableNotice: only when enabled and unavailable', () => {
  assert.equal(unavailableNotice(emptyDockerView()), null);
  assert.equal(unavailableNotice({ ...emptyDockerView(), enabled: true }), null);
  assert.equal(unavailableNotice({ enabled: true, available: false, error: 'Socket proxy unreachable.', services: [], stale: false }), 'Docker discovery is unavailable. Socket proxy unreachable.');
  assert.equal(unavailableNotice({ enabled: true, available: false, error: 'Socket proxy unreachable', services: [disc('a', 'http://h:1')], stale: true }), 'Docker discovery is unavailable. Socket proxy unreachable. Showing the last known containers.');
  assert.equal(unavailableNotice({ enabled: true, available: false, error: null, services: [], stale: false }), 'Docker discovery is unavailable.');
});

test('formatPort', () => {
  assert.equal(formatPort({ private: 80, public: 8080, protocol: 'tcp' }), '8080 → 80/tcp');
});

test('suggestionToDraft: values pass through, a missing URL becomes empty and flagged', () => {
  const s = { container: { name: 'grafana', image: 'grafana/grafana', state: 'running' }, ports: [], suggested: { name: 'Grafana', url: 'http://192.168.1.5:3000', icon: 'chart', category: 'Monitoring' } };
  assert.deepEqual(suggestionToDraft(s), { name: 'Grafana', url: 'http://192.168.1.5:3000', description: '', icon: 'chart', category: 'Monitoring', check: true, needsUrl: false });
  const noUrl = suggestionToDraft({ ...s, suggested: { ...s.suggested, url: null, category: null, name: '' } });
  assert.equal(noUrl.url, '');
  assert.equal(noUrl.needsUrl, true);
  assert.equal(noUrl.category, null);
  assert.equal(noUrl.name, 'grafana');
  assert.equal(suggestionToDraft({ ...s, suggested: { ...s.suggested, url: 'javascript:alert(1)' } }).url, '');
});

test('hiddenDuplicates counts discovered services hidden behind an own service', () => {
  const mine = [own('1', 'https://grafana.example.com/')];
  assert.equal(hiddenDuplicates(mine, [disc('a', 'https://GRAFANA.example.com:443'), disc('b', 'http://h:1')]), 1);
  assert.equal(hiddenDuplicates(mine, []), 0);
  assert.equal(hiddenDuplicates([], [disc('a', 'http://h:1')]), 0);
});

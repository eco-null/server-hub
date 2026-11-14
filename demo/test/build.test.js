import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, rewriteText, findEscapes, normalizeBase, CSP } from '../build.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-demo-'));
const read = (out, rel) => fs.readFileSync(path.join(out, rel), 'utf8');

test('normalizeBase', () => {
  assert.equal(normalizeBase('server-hub'), '/server-hub/');
  assert.equal(normalizeBase('/'), '/');
  assert.equal(normalizeBase('/a/b/'), '/a/b/');
  for (const bad of ['/a b/', '/../', '/x"/', 'C:/Program Files/x/']) assert.throws(() => normalizeBase(bad), bad);
});

test('rewriteText keeps every app URL under the base path', () => {
  const src = [
    `<link href="/static/css/a.css"><a href="/settings">S</a><a href="/">Home</a>`,
    `src: url('/static/fonts/inter.woff2') format('woff2');`,
    `api.get('/api/bootstrap'); api.del('/api/services/' + id);`,
    `if (!location.pathname.startsWith('/login')) location.assign('/login?expired=1');`,
    `location.assign('/login'); location.assign('/'); location.replace("/settings#sec-account");`,
    `const SPRITE = '/static/img/icons.svg'; if (e.key === '/') {}`,
    `{"start_url": "/", "icons": [{"src": "/static/img/logo.png"}]}`,
  ].join('\n');
  const out = rewriteText(src, '/server-hub/');
  for (const want of [
    'href="/server-hub/static/css/a.css"',
    'href="/server-hub/settings.html"',
    'href="/server-hub/"',
    "url('/server-hub/static/fonts/inter.woff2')",
    "api.get('/server-hub/api/bootstrap')",
    "'/server-hub/api/services/'",
    "startsWith('/server-hub/login.html')",
    "location.assign('/server-hub/login.html?expired=1')",
    "location.assign('/server-hub/login.html')",
    "location.assign('/server-hub/')",
    'location.replace("/server-hub/settings.html#sec-account")',
    "'/server-hub/static/img/icons.svg'",
    "e.key === '/'",
    '"start_url": "/server-hub/"',
    '"src": "/server-hub/static/img/logo.png"',
  ]) assert.ok(out.includes(want), want);
  assert.deepEqual(findEscapes(out, '/server-hub/'), []);
  assert.ok(findEscapes(src, '/server-hub/').length >= 10, 'the guard catches the unrewritten source');
  assert.deepEqual(findEscapes(`u.pathname = '/search'; const q = '/';`, '/server-hub/'), [], 'paths of external URLs are not app routes');
});

for (const base of ['/server-hub/', '/']) {
  test(`build output for base ${base}`, () => {
    const out = tmp();
    try {
      const res = build({ base, out });
      const files = res.files;
      for (const f of ['index.html', 'settings.html', 'login.html', '404.html', 'static/demo/install.js', 'static/demo/backend.js', 'static/demo/demo.css', 'static/js/dashboard.js', 'static/img/icons.svg']) {
        assert.ok(files.includes(f), f);
      }
      // nothing that is not needed at runtime
      for (const f of files) assert.ok(!/(^|\/)(tests?|package\.json|.*\.test\.m?js|README\.md|\.gitignore)$/.test(f) && !f.startsWith('tests/') && !f.includes('/test/'), f);

      for (const page of ['index', 'settings', 'login']) {
        const html = read(out, page + '.html');
        assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`), page + ': CSP');
        assert.ok(html.indexOf('<meta http-equiv="Content-Security-Policy"') < html.indexOf('<script'), page + ': CSP before any script');
        assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), page + ': no inline scripts');
        assert.ok(!/\sstyle=/.test(html), page + ': no inline styles');
        const mock = html.indexOf(`src="${base}static/demo/install.js"`);
        const app = html.search(new RegExp(`<script type="module" src="${base}static/js/(dashboard|settings|login)\\.js"`));
        assert.ok(mock > 0 && app > mock, page + ': mock loads before the app module');
        assert.ok(html.includes('class="demo-banner"') && html.includes('id="demo-reset"') && html.includes('https://github.com/eco-null/server-hub'), page + ': banner');
        assert.equal(html.includes('serverhub-demo</code>'), page === 'login', page + ': credentials only on login');
      }
      // every text file: no URL that leaves the base or needs server routing
      for (const f of files.filter((x) => /\.(html|js|css|json|webmanifest)$/.test(x) && !x.startsWith('static/demo/'))) {
        assert.deepEqual(findEscapes(read(out, f), res.base, f), [], f);
      }
      const session = read(out, 'static/js/session.js');
      assert.ok(session.includes(`'${base}login.html?expired=1'`));
      assert.ok(read(out, 'static/js/client.js').includes('fetch(input, init)'), 'the app still calls the global fetch the mock wraps');
      assert.ok(read(out, '404.html').includes(`src="${base}static/demo/not-found.js"`));
      // rebuilding into the same directory is allowed, into anything else is not
      build({ base, out });
      const other = tmp();
      fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
      assert.throws(() => build({ base, out: other }), /refusing/);
      fs.rmSync(other, { recursive: true, force: true });
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
}

test('the mock intercepts both the base-path and the root API path, nothing else', async () => {
  const out = tmp();
  try {
    build({ base: '/server-hub/', out });
    const src = read(out, 'static/demo/install.js');
    assert.match(src, /p\.startsWith\(BASE \+ 'api\/'\)/);
    assert.match(src, /url\.origin !== location\.origin/);
    // the only network primitive the app uses is fetch, via client.js
    const js = fs.readdirSync(path.join(out, 'static', 'js'), { recursive: true }).filter((f) => f.endsWith('.js'));
    for (const f of js) {
      const text = read(out, path.join('static', 'js', f));
      assert.ok(!/XMLHttpRequest|sendBeacon|new WebSocket|new EventSource|importScripts|serviceWorker/.test(text), f);
      if (f !== 'client.js') assert.ok(!/\bfetch\(/.test(text), f + ' calls fetch directly');
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

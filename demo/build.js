#!/usr/bin/env node
// @ts-check
/**
 * Builds the static Server Hub demo from web/ (no dependencies).
 *
 *   node demo/build.js [--base /server-hub/] [--out demo/dist]
 *
 * - copies the three pages and web/static/** unchanged in behaviour, except
 *   that root-absolute URLs ("/static/…", "/api/…", "/login", "/settings",
 *   "/") are rewritten to live under --base, and "/login" / "/settings" become
 *   the real files login.html / settings.html (GitHub Pages has no routing);
 * - adds the in-browser mock API (static/demo/), the demo banner, a strict
 *   CSP <meta> and a 404.html that sends unknown paths to the demo;
 * - fails if any root-absolute URL that would leave the base path remains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WEB = path.join(REPO, 'web');
const SRC = path.join(HERE, 'src');
const PAGES = ['index', 'settings', 'login'];

/** The real app's policy (serverhub/middleware.py) minus what a <meta> cannot carry (frame-ancestors). img-src is narrowed to the site itself: the demo never loads anything from elsewhere. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export const REPO_URL = 'https://github.com/eco-null/server-hub';

/** @param {string} base */
export function normalizeBase(base) {
  let b = String(base || '/').trim();
  if (!b.startsWith('/')) b = '/' + b;
  if (!b.endsWith('/')) b += '/';
  if (!/^\/([A-Za-z0-9._~-]+\/)*$/.test(b) || b.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error(`Invalid base path ${JSON.stringify(base)}: use something like /server-hub/`);
  }
  return b;
}

/**
 * Rewrites root-absolute URLs in a JS, CSS or HTML text so they stay under `base`.
 * @param {string} text
 * @param {string} base normalized ("/x/")
 */
export function rewriteText(text, base) {
  return (
    text
      // "/static/…" and "/api/…" in string literals, attributes and CSS url(…)
      .replace(/(['"`(])\/(static|api)\//g, (_, q, dir) => `${q}${base}${dir}/`)
      // "/login" and "/settings" (optionally with ?query or #hash) become the real files
      .replace(/(['"`])\/(login|settings)(?=[?#'"`])/g, (_, q, page) => `${q}${base}${page}.html`)
      // navigations to the dashboard root
      .replace(/((?:href|action)=)(["'])\/\2/g, (_, attr, q) => `${attr}${q}${base}${q}`)
      .replace(/(location\.(?:assign|replace)\(\s*)(['"`])\/\2/g, (_, call, q) => `${call}${q}${base}${q}`)
      .replace(/(location\.href\s*=\s*)(['"`])\/\2/g, (_, lhs, q) => `${lhs}${q}${base}${q}`)
      // web app manifest start_url / scope / id
      .replace(/("(?:start_url|scope|id)"\s*:\s*")\/(?=["?#])/g, (_, key) => `${key}${base}`)
  );
}

/** Paths the real server routes (docs/API.md, "Pages and static"). */
const APP_ROUTE = /^\/(static|api|login|settings|healthz)(?=$|[/?#.])/;

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds URLs in built output that would leave the base path or hit a route
 * GitHub Pages cannot serve. Returns human-readable problems.
 * @param {string} text
 * @param {string} base
 * @param {string} [file]
 */
export function findEscapes(text, base, file = '') {
  /** @type {string[]} */
  const problems = [];
  const lineOf = (/** @type {number} */ i) => text.slice(0, i).split('\n').length;
  const page = new RegExp(`^${escapeRe(base)}(login|settings)(?![.\\w])`);
  /** @param {string} p @param {number} i */
  const check = (p, i) => {
    if (p === '/' || p.startsWith('//')) return;
    // Only the app's own routes matter; other "/…" strings are e.g. paths of external URLs.
    if (!p.startsWith(base)) {
      if (APP_ROUTE.test(p)) problems.push(`${file}:${lineOf(i)}: root-absolute URL outside the base path: ${p}`);
    }
    else if (page.test(p)) problems.push(`${file}:${lineOf(i)}: route without a file on a static host: ${p}`);
  };
  for (const m of text.matchAll(/(['"`])(\/[^'"`\s<>]*)\1/g)) check(m[2], /** @type {number} */ (m.index));
  for (const m of text.matchAll(/url\(\s*(\/[^)'"\s]*)\s*\)/g)) check(m[1], /** @type {number} */ (m.index));
  if (base !== '/') {
    const nav = /(?:location\.(?:assign|replace)\(\s*|location\.href\s*=\s*|(?:href|action)\s*=\s*|"(?:start_url|scope|id)"\s*:\s*)(['"`])\/\1/g;
    for (const m of text.matchAll(nav)) problems.push(`${file}:${lineOf(/** @type {number} */ (m.index))}: navigation to the domain root: ${m[0]}`);
  }
  return problems;
}

/** @param {string} html @param {string} base @param {string} name */
function injectDemo(html, base, name) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n  <meta name="referrer" content="no-referrer">`;
  const must = (/** @type {boolean} */ ok, /** @type {string} */ what) => {
    if (!ok) throw new Error(`web/${name}.html: cannot find ${what}; update demo/build.js`);
  };

  must(/<meta charset="utf-8">/i.test(html), '<meta charset="utf-8">');
  html = html.replace(/<meta charset="utf-8">/i, (m) => `${m}\n  ${meta}`);

  const firstModule = html.search(/<script type="module"/);
  must(firstModule >= 0, 'the page\'s <script type="module">');
  const scripts = `<script type="module" src="${base}static/demo/install.js"></script>\n  <script type="module" src="${base}static/demo/banner.js"></script>\n  `;
  html = html.slice(0, firstModule) + scripts + html.slice(firstModule);

  must(html.includes('</head>'), '</head>');
  html = html.replace('</head>', `  <link rel="stylesheet" href="${base}static/demo/demo.css">\n</head>`);

  const creds =
    name === 'login'
      ? `\n    <p class="demo-creds">Sign in as <code>demo</code> with the password <code>serverhub-demo</code>. Turned on two-factor and lost the codes? Use Reset demo.</p>`
      : '';
  const banner = `
  <div class="demo-banner" role="region" aria-label="Demo notice">
    <p><strong>Demo:</strong> data stays in your browser. Nothing is saved on a server.</p>${creds}
    <div class="demo-banner-actions">
      <button type="button" class="demo-banner-btn" id="demo-reset">Reset demo</button>
      <a class="demo-banner-link" href="${REPO_URL}" rel="noopener noreferrer">Server Hub on GitHub</a>
    </div>
  </div>`;
  const body = /<body[^>]*>/i.exec(html);
  must(!!body, '<body>');
  let at = /** @type {RegExpExecArray} */ (body).index + /** @type {RegExpExecArray} */ (body)[0].length;
  // Keep the skip link the first thing keyboard users reach.
  const skip = /^\s*<a class="skip-link"[^>]*>[^<]*<\/a>/.exec(html.slice(at));
  if (skip) at += skip[0].length;
  return html.slice(0, at) + banner + html.slice(at);
}

/** @param {string} base */
function notFoundPage(base) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Not found · Server Hub demo</title>
  <link rel="icon" type="image/png" href="${base}static/img/logo.png">
  <link rel="stylesheet" href="${base}static/css/tokens.css">
  <link rel="stylesheet" href="${base}static/css/base.css">
  <link rel="stylesheet" href="${base}static/demo/demo.css">
  <script src="${base}static/demo/not-found.js"></script>
</head>
<body>
  <main class="demo-404">
    <h1>Page not found</h1>
    <p>Taking you to the <a href="${base}">Server Hub demo</a>…</p>
  </main>
</body>
</html>
`;
}

/** @param {string} p */
const isText = (p) => /\.(js|css|html|svg|json|webmanifest|txt)$/i.test(p);

/**
 * @param {string} from
 * @param {string} to
 * @param {(rel: string, text: string) => string} [transform] for .js/.css
 */
function copyTree(from, to, transform) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(a, b, transform);
    else if (entry.isFile()) {
      if (transform && /\.(js|css|json|webmanifest)$/i.test(entry.name)) fs.writeFileSync(b, transform(entry.name, fs.readFileSync(a, 'utf8')));
      else fs.copyFileSync(a, b);
    }
  }
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Refuses to wipe anything that is not empty or an earlier demo build. @param {string} out */
function prepareOut(out) {
  const resolved = path.resolve(out);
  for (const p of [REPO, WEB, HERE, SRC, path.parse(resolved).root]) {
    if (resolved === path.resolve(p)) throw new Error(`Refusing to build into ${resolved}`);
  }
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) {
    const looksLikeBuild = fs.existsSync(path.join(resolved, 'index.html')) && fs.existsSync(path.join(resolved, 'static', 'demo', 'install.js'));
    if (!looksLikeBuild) throw new Error(`${resolved} is not empty and does not look like a demo build; refusing to overwrite it`);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * @param {{ base?: string, out?: string }} [opts]
 * @returns {{ out: string, base: string, files: string[] }}
 */
export function build(opts = {}) {
  const base = normalizeBase(opts.base || '/');
  const out = prepareOut(opts.out || path.join(HERE, 'dist'));

  copyTree(path.join(WEB, 'static'), path.join(out, 'static'), (_rel, text) => rewriteText(text, base));
  copyTree(SRC, path.join(out, 'static', 'demo'));

  for (const name of PAGES) {
    const html = fs.readFileSync(path.join(WEB, name + '.html'), 'utf8');
    fs.writeFileSync(path.join(out, name + '.html'), injectDemo(rewriteText(html, base), base, name));
  }
  fs.writeFileSync(path.join(out, '404.html'), notFoundPage(base));

  const files = walk(out);
  const rel = (/** @type {string} */ f) => path.relative(out, f).split(path.sep).join('/');
  // static/demo/ is the mock itself: its "/api/…" strings are route names, not URLs.
  const problems = files
    .filter((f) => isText(f) && !rel(f).startsWith('static/demo/'))
    .flatMap((f) => findEscapes(fs.readFileSync(f, 'utf8'), base, rel(f)));
  if (problems.length) throw new Error('URLs that would break under ' + base + ':\n  ' + problems.join('\n  '));
  return { out, base, files: files.map((f) => path.relative(out, f).split(path.sep).join('/')) };
}

// ---------- CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ name) => {
    const eq = args.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const res = build({ base: opt('--base') || process.env.DEMO_BASE || '/', out: opt('--out') });
    console.log(`Built the demo for ${res.base} into ${res.out} (${res.files.length} files).`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

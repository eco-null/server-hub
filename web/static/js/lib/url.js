// @ts-check
/** URL helpers. Every href that comes from data must go through safeUrl(). */

const MAX_URL = 2000;

/**
 * Normalises an absolute http(s) URL. Returns null for anything else
 * (javascript:, data:, relative, empty, too long, malformed).
 * @param {unknown} value
 * @param {{ httpsOnly?: boolean }} [opts]
 * @returns {string | null}
 */
export function safeUrl(value, opts = {}) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > MAX_URL) return null;
  // Browsers percent-encode a space in the host instead of failing, but the server rejects it.
  if (/[\s\x00-\x1f\x7f]/.test(s)) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && !opts.httpsOnly)) return u.href;
  return null;
}

/**
 * Host (with port) of a URL; also accepts scheme-less input.
 * @param {unknown} url
 * @returns {string}
 */
export function hostOf(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  const s = url.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s).host;
  } catch {
    return '';
  }
}

/**
 * Splits a leading http(s):// off a user-typed value.
 * @param {string} value
 * @returns {{ scheme: 'https://' | 'http://' | null, rest: string }}
 */
export function splitScheme(value) {
  const m = /^(https?:\/\/)/i.exec(value);
  if (!m) return { scheme: null, rest: value };
  return { scheme: /** @type {'https://' | 'http://'} */ (m[1].toLowerCase()), rest: value.slice(m[1].length) };
}

/**
 * Builds a service URL from the add/edit form: scheme + host, expanding a bare
 * single-label host ("grafana") with the default domain ("grafana.home.arpa").
 * @param {string} scheme
 * @param {string} hostInput
 * @param {string} [defaultDomain]
 * @returns {string}
 */
export function buildServiceUrl(scheme, hostInput, defaultDomain = '') {
  const split = splitScheme(hostInput.trim());
  let rest = split.rest.trim();
  if (!rest) return '';
  const domain = defaultDomain.trim().replace(/^\.+/, '');
  const hostPart = rest.split(/[/?#]/, 1)[0];
  const bare = hostPart && !hostPart.includes('.') && !hostPart.includes(':') && hostPart.toLowerCase() !== 'localhost';
  if (domain && bare) rest = hostPart + '.' + domain + rest.slice(hostPart.length);
  return (split.scheme || scheme) + rest;
}

/**
 * Adds https:// to a URL typed without a scheme. Other schemes are left alone
 * (the server rejects them).
 * @param {string} raw
 */
export function withScheme(raw) {
  const s = raw.trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s;
}

/**
 * CSS `url("...")` for a wallpaper image, or null when the URL is not https.
 * (The CSP only allows https images.)
 * @param {unknown} value
 * @returns {string | null}
 */
export function cssUrl(value) {
  if (typeof value === 'string' && /^\/static\/[^\s"'()\\]*$/.test(value) && !value.includes('..')) return 'url("' + value + '")';
  const href = safeUrl(value, { httpsOnly: true });
  if (!href) return null;
  const escaped = href.replace(/["\\()\n\r]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  return 'url("' + escaped + '")';
}

/** Strips trailing slashes so "https://a.example.com/" equals "https://a.example.com". @param {string} u */
export function stripTrailingSlashes(u) {
  return u.trim().replace(/\/+$/, '');
}

/**
 * Why a Beszel hub address is unacceptable, or null when fine. The server
 * rejects query strings, fragments and credentials in the address.
 * @param {string} value already has a scheme
 * @returns {string | null}
 */
export function beszelUrlProblem(value) {
  if (!safeUrl(value)) return 'Enter a valid address starting with https:// or http://.';
  const u = new URL(value);
  if (u.search || value.includes('?')) return 'Remove everything after “?” from the address; it can’t contain a query string.';
  if (u.hash || value.includes('#')) return 'Remove everything after “#” from the address; it can’t contain a fragment.';
  if (u.username || u.password) return 'Remove the username and password from the address and enter them in the fields below.';
  return null;
}

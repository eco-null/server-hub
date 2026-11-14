// @ts-check
/**
 * Browser entry of the demo backend. Loaded as a module *before* the app's
 * own entry module, so `window.fetch` is wrapped before the app makes its
 * first request. Requests for this site's `api/` paths are answered locally
 * by backend.js; nothing else is touched, and nothing is ever sent anywhere.
 */

import { createBackend, STATE_KEY } from './backend.js';

/** The site's base path ("/server-hub/"), derived from where this file is served (<base>static/demo/install.js). */
export const BASE = new URL('../../', import.meta.url).pathname;

/** @returns {import('./backend.js').KV | undefined} */
function localKv() {
  try {
    const ls = window.localStorage;
    ls.setItem(STATE_KEY + ':probe', '1');
    ls.removeItem(STATE_KEY + ':probe');
    return ls;
  } catch {
    return undefined; // private mode / blocked storage: in-memory for this page view
  }
}

const backend = createBackend({ storage: localKv() });
const realFetch = window.fetch.bind(window);

/** A realistic pause so loading states are visible (50–250 ms). */
const latency = () => 50 + Math.floor(Math.random() * 200);

/**
 * @param {RequestInfo | URL} input
 * @returns {string | null} the API path ("/api/...") when this request is for the demo API
 */
function apiPath(input) {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url;
  try {
    url = new URL(href, location.href);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  const p = url.pathname;
  if (p.startsWith(BASE + 'api/')) return '/' + p.slice(BASE.length) + url.search;
  if (p.startsWith('/api/')) return p + url.search;
  return null;
}

/** @param {AbortSignal | null | undefined} signal */
function abortError(signal) {
  return signal && signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function demoFetch(input, init = {}) {
  const path = apiPath(input);
  if (path === null) return realFetch(input, init);

  const req = input instanceof Request ? input : null;
  const method = (init.method || (req && req.method) || 'GET').toUpperCase();
  const signal = init.signal || (req && req.signal) || null;
  if (signal && signal.aborted) throw abortError(signal);
  let body = null;
  if (typeof init.body === 'string') body = init.body;
  else if (init.body == null && req && method !== 'GET' && method !== 'HEAD') body = await req.text();

  // The simulated network time comes before the "server" acts, as it would for real (a sign-out must
  // not invalidate the session while a poll is still waiting for its reply). keepalive requests (the
  // settings save on page hide) are handled at once so they are never lost.
  if (!init.keepalive) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, latency());
      if (signal) signal.addEventListener('abort', () => (clearTimeout(t), reject(abortError(signal))), { once: true });
    });
  }
  const reply = await backend.handle(method, path, body);
  if (reply.status === 204 || reply.body === undefined) return new Response(null, { status: reply.status });
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
}

window.fetch = demoFetch;

// @ts-check
/**
 * The one fetch wrapper: JSON in/out, timeout, 401 handling and error
 * normalisation. Built with createApi() so it can be unit-tested with a fake
 * fetch; the real instance lives in client.js.
 */

export class ApiError extends Error {
  /**
   * @param {{ status: number, code: string, message: string, fields?: Record<string, string>, retryAfter?: number | null }} p
   */
  constructor({ status, code, message, fields = {}, retryAfter = null }) {
    super(message);
    this.name = 'ApiError';
    /** HTTP status; 0 for network failures and timeouts. */
    this.status = status;
    /** Machine code from the server (`validation`, `conflict`, ...) or `network` / `timeout`. */
    this.code = code;
    /** Field name -> message, from validation errors. */
    this.fields = fields;
    /** Seconds from `Retry-After`, if any. */
    this.retryAfter = retryAfter;
  }
}

/**
 * Accepts the shapes a validation error might carry and returns name -> message.
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeFields(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const rec = /** @type {Record<string, any>} */ (item);
      const name = rec.field ?? (Array.isArray(rec.loc) ? rec.loc.filter((p) => p !== 'body').join('.') : rec.loc);
      const msg = rec.message ?? rec.msg;
      if (typeof name === 'string' && name && typeof msg === 'string') out[name] = out[name] ? out[name] + ' ' + msg : msg;
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[k] = v;
      else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').join(' ');
    }
  }
  return out;
}

/**
 * @param {number} status
 * @param {number | null} retryAfter
 */
function fallbackMessage(status, retryAfter) {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return 'That item no longer exists.';
  if (status === 409) return 'That conflicts with something that already exists.';
  if (status === 429) return retryAfter ? `Too many attempts. Try again in ${retryAfter} seconds.` : 'Too many attempts. Please wait a moment and try again.';
  if (status >= 500) return 'The server ran into a problem. Please try again.';
  return 'The request could not be completed.';
}

/**
 * @param {{
 *   fetchImpl: typeof fetch,
 *   onUnauthenticated?: (err: ApiError) => void,
 *   timeoutMs?: number,
 * }} opts
 */
export function createApi({ fetchImpl, onUnauthenticated, timeoutMs = 15000 }) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, timeout?: number, keepalive?: boolean, signal?: AbortSignal, silent401?: boolean }} [opts]
   * @returns {Promise<any>} parsed JSON, or null for 204
   */
  async function request(method, path, opts = {}) {
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, opts.timeout ?? timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }

    let res;
    try {
      res = await fetchImpl(path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ctrl.signal,
        keepalive: opts.keepalive || undefined,
      });
    } catch (e) {
      if (timedOut) throw new ApiError({ status: 0, code: 'timeout', message: 'The server took too long to respond.' });
      if (opts.signal && opts.signal.aborted) throw new ApiError({ status: 0, code: 'aborted', message: 'The request was cancelled.' });
      throw new ApiError({ status: 0, code: 'network', message: "Can't reach the server. Check your connection and try again." });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return null;

    /** @type {any} */
    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;

    const retryHeader = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('Retry-After')) : NaN;
    const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : null;
    const serverError = data && typeof data === 'object' && data.error && typeof data.error === 'object' ? data.error : null;
    const code = serverError && typeof serverError.code === 'string' ? serverError.code : 'http_' + res.status;
    const message = serverError && typeof serverError.message === 'string' && serverError.message ? serverError.message : fallbackMessage(res.status, retryAfter);
    const err = new ApiError({ status: res.status, code, message, fields: normalizeFields(serverError && serverError.fields), retryAfter });

    if (res.status === 401 && !opts.silent401 && (code === 'unauthenticated' || !serverError) && onUnauthenticated) {
      onUnauthenticated(err);
    }
    throw err;
  }

  return {
    request,
    /** @param {string} path @param {object} [o] */
    get: (path, o) => request('GET', path, o),
    /** @param {string} path @param {unknown} [body] @param {object} [o] */
    post: (path, body, o) => request('POST', path, { ...o, body }),
    /** @param {string} path @param {unknown} [body] @param {object} [o] */
    put: (path, body, o) => request('PUT', path, { ...o, body }),
    /** @param {string} path @param {unknown} [body] @param {object} [o] */
    patch: (path, body, o) => request('PATCH', path, { ...o, body }),
    /** @param {string} path @param {object} [o] */
    del: (path, o) => request('DELETE', path, o),
  };
}

/** @typedef {ReturnType<typeof createApi>} Api */

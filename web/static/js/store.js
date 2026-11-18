// @ts-check
/**
 * Settings store: one state object, optimistic updates, and a single debounced
 * PATCH that carries every change made since the last save.
 */

import { clone, deepMerge, isPlainObject } from './lib/merge.js';

/** @type {import('./types.js').Settings} */
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',
  accent: '#5E6AD2',
  userName: '',
  pageTitle: '',
  subtitle: '',
  defaultDomain: '',
  wallpaper: Object.freeze({ mode: 'none', gradient: 'default', url: '', showGrid: false }),
  features: Object.freeze({ clock: true, greeting: true, stats: true, search: true, statusChecks: true }),
  search: Object.freeze({ provider: 'duckduckgo', searxngUrl: '' }),
});

/**
 * Fills in anything the server left out.
 * @param {unknown} raw
 * @returns {import('./types.js').Settings}
 */
export function normalizeSettings(raw) {
  return /** @type {any} */ (deepMerge(/** @type {any} */ (DEFAULT_SETTINGS), isPlainObject(raw) ? raw : {}));
}

/**
 * @typedef {'idle' | 'saving' | 'saved' | 'error'} SaveStatus
 * @typedef {{ status: SaveStatus, error: import('./api.js').ApiError | null }} SaveInfo
 */

/**
 * @param {{
 *   api: import('./api.js').Api,
 *   initial?: unknown,
 *   debounceMs?: number,
 * }} opts
 */
export function createSettingsStore({ api, initial, debounceMs = 400 }) {
  let confirmed = normalizeSettings(initial);
  let current = clone(confirmed);
  /** @type {Record<string, any>} Fields changed locally and not yet sent. */
  let pending = {};
  const hasPending = () => Object.keys(pending).length > 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  /** @type {SaveInfo} */
  let info = { status: 'idle', error: null };
  /** @type {Set<(s: import('./types.js').Settings, source: 'local' | 'remote') => void>} */
  const listeners = new Set();
  /** @type {Set<(i: SaveInfo) => void>} */
  const saveListeners = new Set();

  const emit = (/** @type {'local' | 'remote'} */ source) => {
    for (const fn of listeners) fn(current, source);
  };
  /** @param {SaveStatus} status @param {import('./api.js').ApiError | null} [error] */
  const setInfo = (status, error = null) => {
    info = { status, error };
    for (const fn of saveListeners) fn(info);
  };

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  }

  /** Sends all pending changes as ONE patch, serialised behind any request in flight. */
  function flush(opts = {}) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    chain = chain.then(() => send(opts));
    return chain;
  }

  /** @param {{ keepalive?: boolean }} opts */
  async function send(opts) {
    if (!hasPending()) return;
    const body = pending;
    pending = {};
    setInfo('saving');
    /** @type {import('./api.js').ApiError | null} */
    let error = null;
    try {
      const res = await api.patch('/api/settings', body, { keepalive: opts.keepalive });
      confirmed = normalizeSettings(res && res.settings);
    } catch (e) {
      error = /** @type {import('./api.js').ApiError} */ (e);
    }
    // Replay only edits made while the request was in flight.
    current = /** @type {typeof current} */ (deepMerge(confirmed, pending));
    if (error) setInfo('error', error);
    else setInfo(hasPending() ? 'saving' : 'saved');
    emit('remote');
  }

  /** @type {any} */
  const store = {
    /** @returns {import('./types.js').Settings} */
    get: () => current,
    /** Current save state. */
    saveInfo: () => info,
    /**
     * Optimistically merges a partial update and schedules one debounced PATCH.
     * @param {Partial<import('./types.js').Settings> | Record<string, any>} partial
     */
    update(partial) {
      if (!isPlainObject(partial)) return;
      const patch = deepMerge({}, partial);
      if (Object.keys(patch).length === 0) return;
      pending = deepMerge(pending, patch);
      current = /** @type {typeof current} */ (deepMerge(current, patch));
      setInfo('saving');
      emit('local');
      schedule();
    },
    flush,
    /** True when nothing is waiting to be sent or in flight. */
    isClean: () => !hasPending() && info.status !== 'saving',
    /** Sends pending changes on page hide; uses keepalive so the browser finishes it. */
    flushOnHide() {
      return flush({ keepalive: true });
    },
    /**
     * Replaces the state with server data (bootstrap, backup import, reset).
     * Pending local edits are dropped.
     * @param {unknown} settings
     */
    replace(settings) {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = {};
      confirmed = normalizeSettings(settings);
      current = clone(confirmed);
      setInfo('idle');
      emit('remote');
    },
    /** DELETE /api/settings: back to server defaults. */
    async reset() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = {};
      await chain;
      const res = await api.del('/api/settings');
      store.replace(res && res.settings);
    },
    /** @param {(s: import('./types.js').Settings, source: 'local' | 'remote') => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** @param {(i: SaveInfo) => void} fn */
    onSaveState(fn) {
      saveListeners.add(fn);
      return () => saveListeners.delete(fn);
    },
  };
  return store;
}

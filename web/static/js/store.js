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
  /** Top-level keys changed locally and not yet sent. */
  const dirty = new Set();
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
    if (dirty.size === 0) return;
    const keys = [...dirty];
    dirty.clear();
    /** Whole top-level values, so nested objects are never sent half-filled. */
    /** @type {Record<string, any>} */
    const body = {};
    for (const k of keys) body[k] = clone(/** @type {any} */ (current)[k]);
    setInfo('saving');
    try {
      const res = await api.patch('/api/settings', body, { keepalive: opts.keepalive });
      confirmed = normalizeSettings(res && res.settings);
      const next = clone(confirmed);
      // Keep edits made while the request was in flight.
      for (const k of dirty) /** @type {any} */ (next)[k] = /** @type {any} */ (current)[k];
      current = next;
      setInfo(dirty.size ? 'saving' : 'saved');
      emit('remote');
    } catch (e) {
      const err = /** @type {import('./api.js').ApiError} */ (e);
      // Roll the rejected keys back to what the server holds, unless edited again since.
      for (const k of keys) if (!dirty.has(k)) /** @type {any} */ (current)[k] = clone(/** @type {any} */ (confirmed)[k]);
      setInfo('error', err);
      emit('remote');
    }
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
      let changed = false;
      for (const key of Object.keys(partial)) {
        const value = /** @type {any} */ (partial)[key];
        if (value === undefined || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const cur = /** @type {any} */ (current)[key];
        /** @type {any} */ (current)[key] = isPlainObject(value) && isPlainObject(cur) ? deepMerge(cur, value) : clone(value);
        dirty.add(key);
        changed = true;
      }
      if (!changed) return;
      setInfo('saving');
      emit('local');
      schedule();
    },
    flush,
    /** True when nothing is waiting to be sent or in flight. */
    isClean: () => dirty.size === 0 && info.status !== 'saving',
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
      dirty.clear();
      confirmed = normalizeSettings(settings);
      current = clone(confirmed);
      setInfo('idle');
      emit('remote');
    },
    /** DELETE /api/settings: back to server defaults. */
    async reset() {
      if (timer) clearTimeout(timer);
      timer = null;
      dirty.clear();
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

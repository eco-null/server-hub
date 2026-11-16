// @ts-check
/**
 * Shared page bootstrap for the dashboard and settings: settings store, theme,
 * wallpaper and the cached-then-fresh bootstrap flow.
 */

import { api } from './client.js';
import { bootCache } from './cache.js';
import { createSettingsStore } from './store.js';
import { applyTheme, watchSystemTheme } from './theme.js';
import { createWallpaper } from './wallpaper.js';
import { byId } from './dom.js';
import { toastError } from './toast.js';

/**
 * @typedef {import('./types.js').Bootstrap} Bootstrap
 */

export function createPageContext() {
  const cached = bootCache.read();
  const store = createSettingsStore({ api, initial: cached ? cached.settings : undefined });
  const wallpaper = createWallpaper(byId('wallpaper'), {
    onImageError: () => toastError("The wallpaper image couldn't be loaded, so it isn't shown."),
  });

  // Settings that came from the server (cache or bootstrap) or from the user are the
  // device's real theme; the built-in defaults before the first answer are not.
  let authoritative = !!cached;

  function paintVisuals() {
    const s = store.get();
    const dark = applyTheme(s.theme, s.accent, {
      persist: authoritative,
      grid: s.wallpaper.mode === 'none' && s.wallpaper.showGrid,
    });
    wallpaper.apply(s.wallpaper, dark);
  }
  store.subscribe((_s, source) => {
    if (source === 'local') authoritative = true;
    paintVisuals();
  });
  watchSystemTheme(() => {
    if (store.get().theme === 'auto') paintVisuals();
  });
  paintVisuals();

  // Never lose a pending settings change when the page goes away.
  window.addEventListener('pagehide', () => void store.flushOnHide());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void store.flushOnHide();
  });

  return {
    /** Last bootstrap payload for the previous user, for an instant first paint. */
    cached,
    store,
    /**
     * Fetches the authoritative bootstrap and updates the cache. Pending local
     * settings edits are kept (the store is only replaced when it is clean).
     * @returns {Promise<Bootstrap>}
     */
    async fetchFresh() {
      /** @type {Bootstrap} */
      const data = await api.get('/api/bootstrap');
      authoritative = true;
      if (store.isClean()) store.replace(data.settings);
      bootCache.write({ ...data, settings: store.get() });
      return data;
    },
    /** Persists the current in-memory data for the next first paint. @param {Bootstrap} data */
    cache(data) {
      bootCache.write({ ...data, settings: store.get() });
    },
  };
}

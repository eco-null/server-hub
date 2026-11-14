// @ts-check
/** Entry module of the settings page (/settings). */

import { api } from './client.js';
import { createPageContext } from './page.js';
import { byId } from './dom.js';
import { createSettingsState } from './settings/env.js';
import { mountAppearance } from './settings/appearance.js';
import { mountPersonalization, mountFeatures, mountSearch } from './settings/simple.js';
import { mountBeszel } from './settings/beszel.js';
import { mountLinks } from './settings/links.js';
import { mountBookmarks } from './settings/bookmarks.js';
import { mountAccount } from './settings/account.js';
import { mountAdmin } from './settings/admin.js';
import { mountBackup, mountReset } from './settings/backup.js';
import { toastError } from './toast.js';

const ctx = createPageContext();
const { store } = ctx;
const state = createSettingsState();

/** @type {Map<string, import('./ui.js').Field>} settings key path -> form field, for server validation errors */
const registry = new Map();

/** @type {import('./settings/env.js').Env} */
const env = {
  api,
  store,
  state,
  register(path, field) {
    registry.set(path, field);
    return field;
  },
  applyBootstrap(data) {
    store.replace(data.settings);
    state.set({ user: data.user, services: data.services, bookmarks: data.bookmarks, loaded: true });
  },
};

const section = (/** @type {string} */ id) => byId('sec-' + id + '-body');

mountAppearance(section('appearance'), env);
mountPersonalization(section('personalization'), env);
mountFeatures(section('features'), env);
mountSearch(section('search'), env);
mountBeszel(section('beszel'), env);
mountLinks(section('links'), env);
mountBookmarks(section('bookmarks'), env);
mountAccount(section('account'), env);
const admin = mountAdmin(section('admin'), env);
mountBackup(section('backup'), env);
mountReset(section('reset'), env);

// ---------- save status ----------
const statusEl = byId('save-status');
let savedTimer = 0;
store.onSaveState((info) => {
  clearTimeout(savedTimer);
  if (info.status === 'saving') statusEl.textContent = 'Saving…';
  else if (info.status === 'saved') {
    statusEl.textContent = 'All changes saved.';
    for (const f of registry.values()) f.setError(null);
    savedTimer = window.setTimeout(() => (statusEl.textContent = ''), 3000);
  } else if (info.status === 'error' && info.error) {
    statusEl.textContent = '';
    let shown = false;
    for (const [path, field] of registry) {
      const msg = info.error.fields[path] || info.error.fields[path.split('.').pop() || ''];
      field.setError(msg || null);
      shown = shown || !!msg;
    }
    toastError(`Couldn't save: ${info.error.message}`);
    if (shown) statusEl.textContent = 'Some changes weren’t saved. Check the highlighted fields.';
  } else statusEl.textContent = '';
});

// ---------- data ----------
const adminSection = byId('sec-admin');
const adminNav = byId('nav-admin');

state.subscribe((s, prev) => {
  if (s.user !== prev.user) {
    const isAdmin = s.user?.role === 'admin';
    adminSection.hidden = !isAdmin;
    adminNav.hidden = !isAdmin;
    if (isAdmin) admin.start();
  }
  if (s.user && (s.services !== prev.services || s.bookmarks !== prev.bookmarks || s.user !== prev.user)) {
    ctx.cache({ user: s.user, settings: store.get(), services: s.services, bookmarks: s.bookmarks });
  }
});

if (ctx.cached) env.applyBootstrap(ctx.cached);
try {
  const data = await ctx.fetchFresh();
  state.set({ user: data.user, services: data.services, bookmarks: data.bookmarks, loaded: true });
  byId('load-error').hidden = true;
} catch (err) {
  if (!state.get().loaded) {
    byId('load-error-text').textContent = err instanceof Error ? err.message : "Couldn't load your settings.";
    byId('load-error').hidden = false;
  } else toastError('Can’t reach the server. Showing the last data that loaded.');
}
byId('retry-load').addEventListener('click', () => location.reload());

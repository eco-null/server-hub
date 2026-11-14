// @ts-check
/** Entry module of the dashboard page (/). */

import { api } from './client.js';
import { createPageContext } from './page.js';
import { createState } from './state.js';
import { byId } from './dom.js';
import { canUseShortcut } from './lib/hotkeys.js';
import { isModalOpen } from './dialog.js';
import { toastError } from './toast.js';
import { createHeader } from './features/header.js';
import { createClock } from './features/clock.js';
import { createServicesView } from './features/services.js';
import { createBookmarksWidget } from './features/bookmarks.js';
import { createStatsWidget } from './features/stats.js';
import { createStatusPoller } from './features/status.js';
import { openSearchPalette } from './features/search.js';
import { openAddService, openEditService, removeService } from './features/service-dialogs.js';

/** @typedef {import('./types.js').Bootstrap} Bootstrap */

const ctx = createPageContext();
const { store } = ctx;

const state = createState({
  /** @type {import('./types.js').User | null} */
  user: null,
  /** @type {import('./types.js').Service[]} */
  services: [],
  /** @type {import('./types.js').Bookmark[]} */
  bookmarks: [],
  /** @type {Record<string, import('./types.js').ServiceStatus>} */
  statuses: {},
  loaded: false,
});

const $ = (/** @type {string} */ id) => byId(id);
const skeletons = $('skeletons');
const emptyState = $('empty-state');
const loadError = $('load-error');
const offline = $('offline-banner');
const groupsEl = $('groups');

// ---------- feature modules ----------
const header = createHeader({ store, api });

const clock = createClock({
  clock: $('clock'),
  date: $('date'),
  greeting: $('greeting'),
  getUserName: () => store.get().userName.trim(),
  isEnabled: () => store.get().features.clock || store.get().features.greeting,
});

const services = createServicesView({
  root: groupsEl,
  onEdit: (s) =>
    openEditService({
      api,
      service: s,
      defaultDomain: store.get().defaultDomain,
      onSaved: (saved) => {
        state.set({ services: state.get().services.map((x) => (x.id === saved.id ? saved : x)) });
        services.focusCard(saved.id);
      },
      onDeleted: (id) => {
        state.set({ services: state.get().services.filter((x) => x.id !== id) });
        $('fab-add').focus();
      },
    }),
  onDelete: async (s) => {
    if (await removeService(api, s)) {
      state.set({ services: state.get().services.filter((x) => x.id !== s.id) });
      $('fab-add').focus();
    }
  },
});

const bookmarks = createBookmarksWidget({
  list: $('bookmarks'),
  addBtn: /** @type {HTMLButtonElement} */ ($('bookmarks-add')),
  formHost: $('bookmarks-form-host'),
  api,
  getBookmarks: () => state.get().bookmarks,
  onAdded: (b) => state.set({ bookmarks: [...state.get().bookmarks, b] }),
});

const stats = createStatsWidget({
  card: $('stats-card'),
  body: $('stats-body'),
  api,
  isAdmin: () => state.get().user?.role === 'admin',
  isEnabled: () => store.get().features.stats,
});

const status = createStatusPoller({
  api,
  isEnabled: () => store.get().features.statusChecks && state.get().services.some((s) => s.check),
  onStatuses: (statuses) => {
    state.set({ statuses });
    services.applyStatuses(statuses);
  },
});

// ---------- rendering ----------
let lastStatusFeature = store.get().features.statusChecks;
let lastStatsFeature = store.get().features.stats;

function renderServices() {
  const s = state.get();
  const showStatus = store.get().features.statusChecks;
  services.render(s.services, { showStatus });
  services.applyStatuses(s.statuses);
  skeletons.hidden = true;
  groupsEl.hidden = s.services.length === 0;
  emptyState.hidden = !(s.loaded && s.services.length === 0);
  void status.refresh();
}

/** @param {import('./types.js').Settings} s */
function renderFeatures(s) {
  for (const el of document.querySelectorAll('[data-feature]')) {
    const key = /** @type {HTMLElement} */ (el).dataset.feature || '';
    if (Object.hasOwn(s.features, key)) /** @type {HTMLElement} */ (el).hidden = !(/** @type {any} */ (s.features)[key]);
  }
}

state.subscribe((s, prev) => {
  if (s.user !== prev.user) header.renderUser(s.user);
  if (s.services !== prev.services) renderServices();
  if (s.bookmarks !== prev.bookmarks) bookmarks.render();
  if (s.user !== prev.user || s.services !== prev.services || s.bookmarks !== prev.bookmarks) {
    if (s.user) ctx.cache({ user: s.user, settings: store.get(), services: s.services, bookmarks: s.bookmarks });
  }
});

store.subscribe((s) => {
  header.renderSettings(s);
  renderFeatures(s);
  clock.refresh();
  if (s.features.stats !== lastStatsFeature) {
    lastStatsFeature = s.features.stats;
    if (s.features.stats) void stats.refresh();
    else $('stats-card').hidden = true;
  }
  if (s.features.statusChecks !== lastStatusFeature) {
    lastStatusFeature = s.features.statusChecks;
    renderServices();
  }
});

// ---------- data ----------
/** @param {Bootstrap} data */
function apply(data) {
  state.set({ user: data.user, services: data.services, bookmarks: data.bookmarks, loaded: true });
}

async function load() {
  loadError.hidden = true;
  try {
    const data = await ctx.fetchFresh();
    offline.hidden = true;
    apply(data);
  } catch (err) {
    if (state.get().loaded) {
      offline.hidden = false;
    } else {
      skeletons.hidden = true;
      loadError.hidden = false;
      byId('load-error-text').textContent = err instanceof Error ? err.message : "Couldn't load your dashboard.";
    }
  }
}

header.renderSettings(store.get());
renderFeatures(store.get());
bookmarks.render();
clock.start();
if (ctx.cached) apply(ctx.cached);
await load();
stats.start();
status.start();

// ---------- interactions ----------
byId('retry-load').addEventListener('click', () => {
  skeletons.hidden = false;
  void load();
});
byId('offline-retry').addEventListener('click', () => void load());

function openSearch() {
  if (!store.get().features.search) return;
  openSearchPalette({ getServices: () => state.get().services, getSearch: () => store.get().search });
}
byId('search-btn').addEventListener('click', openSearch);
byId('fab-add').addEventListener('click', () =>
  openAddService({
    api,
    defaultDomain: store.get().defaultDomain,
    onSaved: (svc) => state.set({ services: [...state.get().services, svc] }),
  }),
);
byId('empty-add').addEventListener('click', () => byId('fab-add').click());

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && canUseShortcut(e, { modalOpen: isModalOpen() })) {
    e.preventDefault();
    openSearch();
  }
});

// Refresh when coming back to a tab that has been in the background for a while.
let lastLoad = Date.now();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastLoad > 60000) {
    lastLoad = Date.now();
    void load();
  }
});

window.addEventListener('unhandledrejection', (e) => {
  // API errors are reported where they happen; this only keeps stray ones visible to the user.
  if (e.reason && e.reason.name === 'ApiError' && e.reason.code !== 'unauthenticated') toastError(e.reason.message);
});

/* settings.js — shared settings layer for Server Hub.
 *
 * Persists user personalization in localStorage under 'server-hub:settings'.
 * Consumed by both index.html (applies settings on load) and settings.html
 * (renders the editor UI). Keeping logic here avoids drift between the two.
 *
 * Keys:
 *   theme        'auto' | 'light' | 'dark'
 *   accent       hex string like '#5E6AD2'
 *   userName     string shown in greeting (empty = generic "Hello")
 *   pageTitle    string used as <h1> + document.title
 *   features     { clock, greeting, stats, statusPings, blobs, search }  (booleans)
 *   services     array of user-defined service entries (merged over defaults)
 *
 * Exposes:
 *   window.HubSettings.get()              -> current settings object
 *   window.HubSettings.set(partial)        -> merge + save + emit 'hub:settings'
 *   window.HubSettings.apply(settings)     -> apply to current document (tokens, features)
 *   window.HubSettings.defaults            -> pristine defaults
 *   window.HubSettings.subscribe(fn)       -> listener; returns unsubscribe
 */

const SETTINGS_KEY = 'server-hub:settings';

/* Storage shim — survives SecurityError on opaque origins (file://, sandbox,
 * private mode). Always returns a working storage; if localStorage throws,
 * we fall back to an in-memory Map so the rest of the app still functions.
 * Writes persist for the session; reloading the page resets to defaults.
 * Real persistence requires serving via http(s) — see SETUP.md. */
const safeStorage = (() => {
  try {
    const probe = '__hub_probe__';
    localStorage.setItem(probe, '1'); localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const mem = new Map();
    return {
      getItem: k => mem.has(String(k)) ? mem.get(String(k)) : null,
      setItem: (k, v) => { mem.set(String(k), String(v)); },
      removeItem: k => { mem.delete(String(k)); },
      _ephemeral: true,
    };
  }
})();

const DEFAULTS = Object.freeze({
  theme: 'auto',
  accent: '#5E6AD2',
  userName: '',
  pageTitle: 'Server Hub',
  subtitle: 'Your self-hosted apps and services, reachable from one place.',
  features: {
    clock: true,
    greeting: true,
    stats: true,
    statusPings: true,
    blobs: true,
    search: true,
  },
  services: [],
});

function read() {
  try {
    const raw = JSON.parse(safeStorage.getItem(SETTINGS_KEY) || '{}');
    return deepMerge(structuredCloneSafe(DEFAULTS), raw);
  } catch {
    return structuredCloneSafe(DEFAULTS);
  }
}

// structuredClone exists in modern browsers; fall back if available only via JSON.
function structuredCloneSafe(o) {
  try { return structuredClone(o); }
  catch { return JSON.parse(JSON.stringify(o)); }
}

function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
      base[k] = deepMerge(base[k] || {}, over[k]);
    } else if (over[k] !== undefined) {
      base[k] = over[k];
    }
  }
  return base;
}

const listeners = new Set();

function emit(s) { listeners.forEach(fn => { try { fn(s); } catch {} }); }

function set(partial) {
  const cur = read();
  const next = deepMerge(cur, partial);
  try { safeStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  emit(next);
  return next;
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function preferredDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function isDark(s) { return s.theme === 'dark' || (s.theme === 'auto' && preferredDark()); }

/* apply(settings)
 * Apply visual settings to the current document. Does NOT touch services
 * (index.html's renderGroups handles that separately so it can re-render).
 */
function apply(s) {
  const dark = isDark(s);
  document.documentElement.classList.toggle('dark',  dark);
  document.documentElement.classList.toggle('light', !dark);

  // Accent color
  document.documentElement.style.setProperty('--accent', s.accent);
  document.documentElement.style.setProperty('--accent-glow', hexToRgba(s.accent, 0.20));

  // Page title + subtitle
  document.title = s.pageTitle + ' — Self-Hosted Services';
  const h1 = document.querySelector('h1');
  if (h1 && h1.dataset.dynamic === 'true') h1.textContent = s.pageTitle;
  const sub = document.querySelector('[data-dynamic-subtitle]');
  if (sub) sub.textContent = s.subtitle;

  // Toggle feature visibility
  const f = s.features;
  const toggle = (sel, on) => { const el = document.querySelector(sel); if (el) el.style.display = on ? '' : 'none'; };
  toggle('[data-feature="clock"]',     f.clock);
  toggle('[data-feature="greeting"]',  f.greeting);
  toggle('[data-feature="stats"]',     f.stats);
  toggle('[data-feature="search"]',    f.search);
  toggle('[data-feature="blobs"]',     f.blobs); // container with all blobs (set in index)
  toggle('[data-feature="status"]',     f.statusPings); // dotted control handled in render

  // userName into greeting (marker element)
  const gEl = document.querySelector('[data-greeting-name]');
  if (gEl && f.greeting) gEl.dataset.userName = s.userName || '';
}

function hexToRgba(hex, a) {
  if (!hex || hex[0] !== '#') return 'rgba(94,106,210,' + a + ')';
  const h = hex.length === 4
    ? hex.slice(1).split('').map(c => c + c).join('')
    : hex.slice(1);
  const n = parseInt(h, 16);
  if (isNaN(n)) return 'rgba(94,106,210,' + a + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

if (typeof window !== 'undefined') {
  window.HubSettings = {
    KEY: SETTINGS_KEY,
    defaults: DEFAULTS,
    get: read,
    set,
    apply,
    subscribe,
    isDark,
    hexToRgba,
  };
}
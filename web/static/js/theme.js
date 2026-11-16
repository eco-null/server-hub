// @ts-check
/**
 * Theme (auto / light / dark) and accent colour. The first paint is handled
 * by theme-boot.js from the same stored values; this module keeps them in sync.
 */

import { UI_KEY, storage, readJson, writeJson } from './storage.js';
import { ensureContrast, isHex, readableOn, rgba } from './lib/color.js';

export const THEME_MODES = /** @type {const} */ (['auto', 'light', 'dark']);

/** Surfaces text sits on; accent-coloured text must reach AA against these. */
const BG = { dark: '#0f0f10', light: '#f3f6fb' };
/** Page background colours reported to the browser (theme-color). */
const BROWSER_UI = { dark: '#000000', light: '#f3f6fb' };
const DEFAULT_ACCENT = '#5E6AD2';

/** @param {string} mode */
export function isDark(mode) {
  return mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}

/** @param {string} mode */
export function nextThemeMode(mode) {
  return mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
}

/**
 * CSS variables derived from an accent colour. `--accent-text-dark/-light` are
 * the accent shifted until it reaches AA contrast on dark/light surfaces; the
 * stylesheet picks one per theme (tokens.css).
 * @param {string} accent
 */
export function accentVars(accent) {
  const a = isHex(accent) ? accent : DEFAULT_ACCENT;
  return {
    '--accent': a,
    '--accent-fg': readableOn(a),
    '--accent-glow': rgba(a, 0.2),
    '--accent-text-dark': ensureContrast(a, BG.dark, 4.8),
    '--accent-text-light': ensureContrast(a, BG.light, 4.8),
  };
}

/**
 * Makes the browser UI colour follow the chosen theme instead of the OS one.
 * @param {boolean} dark
 */
export function setThemeColor(dark) {
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.removeAttribute('media');
    m.setAttribute('content', BROWSER_UI[dark ? 'dark' : 'light']);
  }
}

/**
 * Applies theme + accent to the document and remembers them for the next
 * first paint (device-level, survives logout).
 * Only values that came from the server (or an explicit user choice) may be
 * remembered: the store starts from DEFAULT_SETTINGS before the first bootstrap
 * answer, and persisting that would pass the default off as the device's theme.
 * @param {string} mode
 * @param {string} accent
 * @param {{ persist?: boolean, grid?: boolean }} [opts] `grid`: the opt-in page grid is on and no wallpaper covers it (theme-boot repeats it before first paint)
 */
export function applyTheme(mode, accent, opts = {}) {
  const dark = isDark(mode);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  setThemeColor(dark);
  const vars = accentVars(accent);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  if (opts.persist !== false) {
    const prev = readJson(storage, UI_KEY) || {};
    writeJson(storage, UI_KEY, { ...prev, theme: mode, accent, vars, grid: !!opts.grid });
  }
  return dark;
}

/**
 * Calls `onChange` when the OS colour scheme changes.
 * @param {() => void} onChange
 */
export function watchSystemTheme(onChange) {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** Label for the theme toggle. @param {string} mode */
export function themeLabel(mode) {
  return mode === 'auto' ? 'Automatic' : mode === 'light' ? 'Light' : 'Dark';
}

// @ts-check
/**
 * Wallpaper: 8 gradient presets (dark and light palettes) or a user-supplied
 * https image, an optional 32px grid overlay, cross-fading between wallpapers
 * and readability classes on <html> so glass cards stay legible on any image.
 */

import { h } from './dom.js';
import { cssUrl } from './lib/url.js';

const GRID_DARK = 'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)';
const GRID_LIGHT = 'linear-gradient(rgba(15,23,42,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.06) 1px, transparent 1px)';

/** @type {Readonly<Record<string, string>>} */
const DARK = Object.freeze({
  aurora: 'linear-gradient(160deg, #0a1f1a 0%, #0f2e1f 100%)',
  dusk: 'linear-gradient(160deg, #1a0a1a 0%, #2a0f2e 100%)',
  ocean: 'linear-gradient(160deg, #070f1a 0%, #0a1f33 100%)',
  forest: 'linear-gradient(160deg, #052e16 0%, #0a3321 100%)',
  mono: 'linear-gradient(160deg, #0a0a0a 0%, #141414 100%)',
  grid: 'linear-gradient(160deg, #0a0a0a 0%, #111111 100%)',
  slate: 'linear-gradient(160deg, #0f0f0f 0%, #1a1a1a 100%)',
  sage: 'linear-gradient(160deg, #0a1a12 0%, #143322 100%)',
});

/** @type {Readonly<Record<string, string>>} */
const LIGHT = Object.freeze({
  aurora: 'linear-gradient(160deg, #e7e5e4 0%, #d6d3d1 100%)',
  dusk: 'linear-gradient(160deg, #ede9fe 0%, #ddd6fe 100%)',
  ocean: 'linear-gradient(160deg, #dbeafe 0%, #bfdbfe 100%)',
  forest: 'linear-gradient(160deg, #dcfce7 0%, #bbf7d0 100%)',
  mono: 'linear-gradient(160deg, #f5f5f4 0%, #e7e5e4 100%)',
  grid: 'linear-gradient(160deg, #fafaf9 0%, #f5f5f4 100%)',
  slate: 'linear-gradient(160deg, #f1f5f9 0%, #e2e8f0 100%)',
  sage: 'linear-gradient(160deg, #ecfdf5 0%, #d1fae5 100%)',
});

export const GRADIENT_IDS = Object.freeze(Object.keys(DARK));

/** Flat colours used for the preset swatches in settings. */
export const GRADIENT_SWATCH = Object.freeze({
  dark: { aurora: '#0f2e1f', dusk: '#2a0f2e', ocean: '#0a1f33', forest: '#0a3321', mono: '#141414', grid: '#111111', slate: '#1a1a1a', sage: '#143322' },
  light: { aurora: '#d6d3d1', dusk: '#ddd6fe', ocean: '#bfdbfe', forest: '#bbf7d0', mono: '#e7e5e4', grid: '#f5f5f4', slate: '#e2e8f0', sage: '#d1fae5' },
});

/**
 * @typedef {{
 *   kind: 'none' | 'gradient' | 'image',
 *   image: string | null,
 *   size: string,
 *   repeat: string,
 *   key: string,
 *   showGrid: boolean,
 * }} WallpaperSpec
 */

/**
 * Pure: what the wallpaper layer should paint for these settings.
 * @param {Partial<import('./types.js').WallpaperSettings> | undefined} w
 * @param {boolean} dark whether the active colour scheme is dark
 * @returns {WallpaperSpec}
 */
export function wallpaperSpec(w, dark) {
  const mode = (w && w.mode) || 'none';
  const showGrid = !w || w.showGrid !== false;
  const grid = dark ? GRID_DARK : GRID_LIGHT;
  const gridSize = w && w.gradient === 'grid' && mode === 'gradient' ? '44px 44px' : '32px 32px';
  /** @param {string} base */
  const build = (base) => ({
    image: showGrid ? `${grid}, ${base}` : base,
    size: showGrid ? `${gridSize}, ${gridSize}, cover` : 'cover',
    repeat: showGrid ? 'repeat, repeat, no-repeat' : 'no-repeat',
  });

  if (mode === 'gradient') {
    const palette = dark ? DARK : LIGHT;
    const id = w && w.gradient && Object.hasOwn(palette, w.gradient) ? w.gradient : 'mono';
    const b = build(palette[id]);
    return { kind: 'gradient', ...b, key: `g|${id}|${dark}|${showGrid}`, showGrid };
  }
  if (mode === 'image') {
    const url = cssUrl(w && w.url);
    if (url) {
      const b = build(url);
      return { kind: 'image', ...b, key: `i|${w && w.url}|${dark}|${showGrid}`, showGrid };
    }
  }
  return { kind: 'none', image: null, size: '', repeat: '', key: 'none', showGrid };
}

/**
 * Average luminance of an image: true when it is dark. Cross-origin images
 * without CORS cannot be read; those default to dark.
 * @param {HTMLImageElement} img
 */
function imageIsDark(img) {
  try {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d');
    if (!ctx) return true;
    ctx.drawImage(img, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4) < 128;
  } catch {
    return true;
  }
}

/**
 * @param {HTMLElement} container the #wallpaper element
 * @param {{ onImageError?: () => void }} [hooks]
 */
export function createWallpaper(container, hooks = {}) {
  const root = document.documentElement;
  let currentKey = '';
  let seq = 0;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** @param {'dark' | 'light' | null} readability */
  function setReadability(readability) {
    root.classList.toggle('has-wallpaper', readability !== null);
    root.classList.toggle('wallpaper-dark', readability === 'dark');
    root.classList.toggle('wallpaper-light', readability === 'light');
  }

  /** @param {HTMLElement[]} layers */
  function retire(layers) {
    for (const l of layers) l.classList.remove('is-on');
    setTimeout(() => layers.forEach((l) => l.remove()), reduced() ? 0 : 800);
  }

  /** @param {WallpaperSpec} spec */
  function addLayer(spec) {
    const old = /** @type {HTMLElement[]} */ ([...container.children]);
    const layer = h('div', {
      class: 'wp-layer',
      style: { '--wp-image': spec.image || 'none', '--wp-size': spec.size, '--wp-repeat': spec.repeat },
    });
    container.appendChild(layer);
    // two frames so the opacity transition starts from 0
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('is-on')));
    retire(old);
  }

  return {
    /**
     * @param {Partial<import('./types.js').WallpaperSettings> | undefined} w
     * @param {boolean} dark
     */
    apply(w, dark) {
      const spec = wallpaperSpec(w, dark);
      root.classList.toggle('no-grid', spec.kind === 'none' && !spec.showGrid);
      if (spec.key === currentKey) return;
      currentKey = spec.key;
      const mine = ++seq;

      if (spec.kind === 'none') {
        retire(/** @type {HTMLElement[]} */ ([...container.children]));
        setReadability(null);
        return;
      }
      if (spec.kind === 'gradient') {
        addLayer(spec);
        // the dark palette is dark, the light palette is bright
        setReadability(dark ? 'dark' : 'light');
        return;
      }
      // image: show it only once it has loaded
      const img = new Image();
      img.onload = () => {
        if (mine !== seq) return;
        addLayer(spec);
        setReadability(imageIsDark(img) ? 'dark' : 'light');
      };
      img.onerror = () => {
        if (mine !== seq) return;
        currentKey = '';
        retire(/** @type {HTMLElement[]} */ ([...container.children]));
        setReadability(null);
        if (hooks.onImageError) hooks.onImageError();
      };
      img.src = /** @type {string} */ ((w && w.url) || '');
    },
  };
}

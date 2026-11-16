import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { wallpaperSpec, createWallpaper } from '../static/js/wallpaper.js';
import { applyTheme, accentVars } from '../static/js/theme.js';
import { storage, readJson, UI_KEY } from '../static/js/storage.js';
import { contrast } from '../static/js/lib/color.js';

/** Minimal <html> stand-in: a class set and a style map. */
function fakeRoot() {
  const classes = new Set();
  const style = new Map();
  return {
    classes,
    style: { setProperty: (k, v) => style.set(k, v) },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle(c, on) {
        if (on === undefined ? !classes.has(c) : on) classes.add(c);
        else classes.delete(c);
        return classes.has(c);
      },
    },
  };
}

function withDom(fn) {
  const saved = { document: globalThis.document, matchMedia: globalThis.matchMedia, Image: globalThis.Image };
  const root = fakeRoot();
  const images = [];
  globalThis.document = { documentElement: root, querySelectorAll: () => [] };
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.Image = class {
    constructor() {
      images.push(this);
    }
  };
  try {
    return fn({ root, images });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

test('the grid preset always draws its 44px grid, even with the overlay switch off', () => {
  const spec = wallpaperSpec({ mode: 'gradient', gradient: 'grid', showGrid: false }, true);
  assert.match(spec.image, /linear-gradient\(rgba\(255,255,255,0\.025\)/);
  assert.match(spec.size, /^44px 44px, 44px 44px, cover$/);
  const mono = wallpaperSpec({ mode: 'gradient', gradient: 'mono', showGrid: false }, true);
  assert.doesNotMatch(mono.image, /rgba\(255,255,255,0\.025\)/);
  assert.notEqual(spec.key, mono.key);
  // the overlay switch on a normal preset keeps the 32px grid
  assert.match(wallpaperSpec({ mode: 'gradient', gradient: 'mono', showGrid: true }, true).size, /^32px 32px/);
});

test('the page grid stays on while an image loads and after it fails', () => {
  withDom(({ root, images }) => {
    let errors = 0;
    const wp = createWallpaper({ children: [] }, { onImageError: () => errors++ });
    wp.apply({ mode: 'image', url: 'https://img.example/x.jpg', showGrid: true }, true);
    assert.equal(images.length, 1);
    assert.equal(root.classes.has('show-grid'), true, 'visible while the image is still loading');
    images[0].onerror();
    assert.equal(errors, 1);
    assert.equal(root.classes.has('show-grid'), true, 'visible after the image failed');
    assert.equal(root.classes.has('has-wallpaper'), false);
    wp.apply({ mode: 'image', url: 'https://img.example/x.jpg', showGrid: false }, true);
    assert.equal(root.classes.has('show-grid'), false, 'off when the user turns it off');
  });
});

test('applyTheme remembers theme and grid only when asked to persist', () => {
  withDom(() => {
    storage.removeItem(UI_KEY);
    applyTheme('dark', '#5E6AD2', { persist: false, grid: true });
    assert.equal(readJson(storage, UI_KEY), null, 'a theme that came from defaults is not stored');
    applyTheme('light', '#EAB308', { persist: true, grid: true });
    const ui = readJson(storage, UI_KEY);
    assert.equal(ui.theme, 'light');
    assert.equal(ui.grid, true);
    applyTheme('light', '#EAB308', { persist: false });
    assert.equal(readJson(storage, UI_KEY).theme, 'light', 'a later unpersisted paint leaves the stored value alone');
    storage.removeItem(UI_KEY);
  });
});

test('accent text meets AA on the new dark surfaces', () => {
  for (const accent of ['#5E6AD2', '#EAB308', '#22C55E', '#EC4899', '#64748B']) {
    const text = accentVars(accent)['--accent-text-dark'];
    for (const bg of ['#000000', '#0f0f10']) assert.ok(contrast(text, bg) >= 4.5, `${accent} on ${bg}`);
  }
});

function runBoot(ui) {
  const classes = new Set();
  const ctx = {
    localStorage: { getItem: () => (ui === undefined ? null : JSON.stringify(ui)) },
    window: { matchMedia: () => ({ matches: false }) },
    document: {
      documentElement: { classList: { add: (c) => classes.add(c) }, style: { setProperty() {} } },
      querySelectorAll: () => [],
    },
  };
  vm.runInNewContext(readFileSync(new URL('../static/js/theme-boot.js', import.meta.url), 'utf8'), ctx);
  return classes;
}

test('theme-boot paints dark by default and adds the remembered grid before first paint', () => {
  assert.deepEqual([...runBoot(undefined)], ['dark']);
  assert.deepEqual([...runBoot({ theme: 'light', grid: true })].sort(), ['light', 'show-grid']);
  assert.deepEqual([...runBoot({ theme: 'dark', grid: false })], ['dark']);
});

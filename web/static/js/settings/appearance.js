// @ts-check
/** Settings: theme, accent color, wallpaper, grid overlay. */

import { h } from '../dom.js';
import { createField, createRadioGroup, createSwitch } from '../ui.js';
import { GRADIENT_IDS, GRADIENT_SWATCH } from '../wallpaper.js';
import { safeUrl } from '../lib/url.js';
import { isHex } from '../lib/color.js';
import { isDark } from '../theme.js';

const ACCENTS = [
  ['#5E6AD2', 'Indigo'],
  ['#22C55E', 'Green'],
  ['#EAB308', 'Amber'],
  ['#F97316', 'Orange'],
  ['#EF4444', 'Red'],
  ['#EC4899', 'Pink'],
  ['#8B5CF6', 'Violet'],
  ['#14B8A6', 'Teal'],
  ['#0EA5E9', 'Sky'],
  ['#64748B', 'Slate'],
];

const THEMES = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountAppearance(root, env) {
  const { store } = env;
  const s0 = store.get();

  // Theme
  const theme = createRadioGroup({
    legend: 'Theme',
    value: s0.theme,
    options: THEMES,
    hint: 'Auto follows your system setting.',
    className: 'choice-segmented',
    onChange: (v) => store.update({ theme: v }),
  });

  // Accent
  const accent = createRadioGroup({
    legend: 'Accent color',
    value: ACCENTS.some(([c]) => c.toLowerCase() === s0.accent.toLowerCase()) ? ACCENTS.find(([c]) => c.toLowerCase() === s0.accent.toLowerCase())?.[0] ?? null : null,
    className: 'choice-swatches',
    options: ACCENTS.map(([c, name]) => ({ value: c, label: name, title: `${name} (${c})`, content: h('span', { class: 'swatch', style: { '--swatch': c } }) })),
    onChange: (v) => store.update({ accent: v }),
  });
  const custom = createField({ label: 'Custom color', control: h('input', { type: 'color', value: isHex(s0.accent) ? s0.accent : '#5e6ad2' }), className: 'field-inline' });
  custom.input.addEventListener('input', () => store.update({ accent: custom.input.value }));
  env.register('accent', custom);

  // Wallpaper presets
  const wp0 = s0.wallpaper;
  const swatchSet = () => (isDark(store.get().theme) ? GRADIENT_SWATCH.dark : GRADIENT_SWATCH.light);
  const wpValue = () => {
    const w = store.get().wallpaper;
    return w.mode === 'none' ? 'none' : w.mode === 'gradient' ? w.gradient : null;
  };
  const wallpaper = createRadioGroup({
    legend: 'Wallpaper',
    value: wpValue(),
    className: 'choice-swatches',
    options: [
      { value: 'none', label: 'None', content: h('span', { class: 'swatch swatch-none' }, 'None') },
      ...GRADIENT_IDS.map((id) => ({ value: id, label: id[0].toUpperCase() + id.slice(1), content: h('span', { class: 'swatch', dataset: { gradient: id }, style: { '--swatch': swatchSet()[/** @type {keyof typeof GRADIENT_SWATCH.dark} */ (id)] } }) })),
    ],
    onChange: (v) => store.update({ wallpaper: v === 'none' ? { mode: 'none' } : { mode: 'gradient', gradient: v } }),
  });
  const swatches = () => root.querySelectorAll('.swatch[data-gradient]');

  // Custom image
  const image = createField({
    label: 'Custom wallpaper image',
    name: 'wallpaper.url',
    value: wp0.url,
    placeholder: 'https://example.com/wallpaper.jpg',
    inputMode: 'url',
    spellcheck: false,
    hint: 'Use a direct link to an image. It must start with https://.',
  });
  env.register('wallpaper.url', image);
  const apply = h('button', { type: 'button', class: 'btn', onclick: () => applyImage() }, 'Apply image');
  function applyImage() {
    image.setError(null);
    const raw = image.input.value.trim();
    if (!raw) {
      image.setError('Enter an image address, or pick a preset above.');
      return image.input.focus();
    }
    const url = safeUrl(raw, { httpsOnly: true });
    if (!url) {
      image.setError('The address must be a valid https:// link.');
      return image.input.focus();
    }
    store.update({ wallpaper: { mode: 'image', url } });
  }
  image.input.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyImage();
    }
  });

  const grid = createSwitch({
    label: 'Grid overlay',
    description: 'Show a faint grid behind everything, also on top of wallpapers.',
    checked: wp0.showGrid,
    onChange: (checked) => store.update({ wallpaper: { showGrid: checked } }),
  });

  root.append(
    h('div', { class: 'stack' }, theme.root, accent.root, custom.root, wallpaper.root, h('div', { class: 'field-with-action' }, image.root, apply), grid.root),
  );

  function sync(/** @type {import('../types.js').Settings} */ s) {
    theme.setValue(s.theme);
    const preset = ACCENTS.find(([c]) => c.toLowerCase() === s.accent.toLowerCase());
    accent.setValue(preset ? preset[0] : null);
    if (isHex(s.accent) && document.activeElement !== custom.input) custom.input.value = s.accent.toLowerCase();
    wallpaper.setValue(wpValue());
    for (const el of swatches()) {
      const id = /** @type {HTMLElement} */ (el).dataset.gradient;
      if (id) /** @type {HTMLElement} */ (el).style.setProperty('--swatch', swatchSet()[/** @type {keyof typeof GRADIENT_SWATCH.dark} */ (id)]);
    }
    if (document.activeElement !== image.input) image.input.value = s.wallpaper.url;
    grid.input.checked = s.wallpaper.showGrid;
  }
  store.subscribe(sync);
}

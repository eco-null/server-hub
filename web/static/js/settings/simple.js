// @ts-check
/** Settings: personalization, features and search. Each control writes to the store (one debounced PATCH). */

import { h } from '../dom.js';
import { createField, createSelect, createSwitch } from '../ui.js';
import { SEARCH_PROVIDERS } from '../lib/search.js';
import { safeUrl } from '../lib/url.js';

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountPersonalization(root, env) {
  const { store } = env;
  const s = store.get();
  /** @type {Array<[keyof import('../types.js').Settings, import('../ui.js').Field]>} */
  const fields = [
    ['userName', createField({ label: 'Your name', value: s.userName, hint: 'Shown in the greeting. Optional.', maxLength: 60, autocomplete: 'off' })],
    ['pageTitle', createField({ label: 'Page title', value: s.pageTitle, placeholder: 'Server Hub', hint: 'The main heading and browser tab title.', maxLength: 60 })],
    ['subtitle', createField({ label: 'Subtitle', value: s.subtitle, placeholder: 'Your apps and services, reachable from one place.', maxLength: 120 })],
    ['defaultDomain', createField({ label: 'Default domain', value: s.defaultDomain, placeholder: 'home.arpa', hint: 'When you add a service with just a name such as “grafana”, this domain is appended: grafana.home.arpa.', spellcheck: false })],
  ];
  for (const [key, field] of fields) {
    env.register(key, field);
    field.input.addEventListener('input', () => {
      field.setError(null);
      store.update({ [key]: key === 'defaultDomain' ? field.input.value.trim() : field.input.value });
    });
  }
  root.append(h('div', { class: 'field-grid' }, fields.map(([, f]) => f.root)));

  store.subscribe((next) => {
    for (const [key, field] of fields) if (document.activeElement !== field.input) field.input.value = String(next[key] ?? '');
  });
}

const FEATURES = [
  ['clock', 'Clock and date', 'Show the live time and date in the header.'],
  ['greeting', 'Greeting', 'Show “Good morning” with your name above the title.'],
  ['stats', 'System widget', 'Show CPU, memory and disk usage from your Beszel hubs (and this server, for administrators).'],
  ['search', 'Search', 'Show the search bar and enable the “/” shortcut.'],
  ['statusChecks', 'Status indicators', 'Show whether each service is online. The server checks them, not your browser.'],
];

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountFeatures(root, env) {
  const { store } = env;
  const switches = FEATURES.map(([key, label, description]) =>
    createSwitch({
      label,
      description,
      checked: /** @type {any} */ (store.get().features)[key] !== false,
      onChange: (checked) => store.update({ features: { [key]: checked } }),
    }),
  );
  root.append(h('div', { class: 'stack' }, switches.map((sw) => sw.root)));
  store.subscribe((next) => {
    FEATURES.forEach(([key], i) => {
      switches[i].input.checked = /** @type {any} */ (next.features)[key] !== false;
    });
  });
}

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountSearch(root, env) {
  const { store } = env;
  const s = store.get().search;
  const provider = createSelect({
    label: 'Web search provider',
    value: s.provider,
    options: Object.entries(SEARCH_PROVIDERS).map(([value, p]) => ({ value, label: p.label })),
    hint: 'Used when you press Enter in the search popup without choosing a service.',
  });
  const url = createField({ label: 'SearXNG address', value: s.searxngUrl, placeholder: 'https://searx.example.com', inputMode: 'url', spellcheck: false, hint: 'Your own SearXNG instance. Must start with https:// or http://.' });
  env.register('search.provider', provider);
  env.register('search.searxngUrl', url);
  const urlWrap = url.root;
  urlWrap.hidden = s.provider !== 'searxng';

  provider.input.addEventListener('change', () => {
    urlWrap.hidden = provider.input.value !== 'searxng';
    store.update({ search: { provider: provider.input.value } });
  });
  url.input.addEventListener('input', () => {
    const v = url.input.value.trim();
    if (v && !safeUrl(v)) {
      url.setError('Enter a full address starting with https:// or http://.');
      return;
    }
    url.setError(null);
    store.update({ search: { searxngUrl: v } });
  });
  root.append(h('div', { class: 'field-grid' }, provider.root, urlWrap));

  store.subscribe((next) => {
    if (document.activeElement !== provider.input) provider.input.value = next.search.provider;
    urlWrap.hidden = next.search.provider !== 'searxng';
    if (document.activeElement !== url.input) url.input.value = next.search.searxngUrl;
  });
}

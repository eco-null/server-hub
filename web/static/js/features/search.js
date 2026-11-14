// @ts-check
/**
 * Search palette: services first, then a web search with the configured
 * provider. Implemented as a combobox with a listbox popup.
 */

import { h, nextId } from '../dom.js';
import { openDialog } from '../dialog.js';
import { icon, serviceIcon } from '../icons.js';
import { rankServices, buildSearchUrl, SEARCH_PROVIDERS } from '../lib/search.js';
import { resolveCategory } from '../categorize.js';
import { hostOf, safeUrl } from '../lib/url.js';

/**
 * @param {{
 *   getServices: () => import('../types.js').Service[],
 *   getSearch: () => import('../types.js').SearchSettings,
 * }} o
 */
export function openSearchPalette({ getServices, getSearch }) {
  openDialog({
    title: 'Search',
    bare: true,
    ariaLabel: 'Search services or the web',
    className: 'dlg-palette',
    build(ctrl) {
      const listId = nextId('results');
      const input = h('input', {
        class: 'palette-input',
        type: 'text',
        role: 'combobox',
        placeholder: 'Search services or the web…',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        enterkeyhint: 'search',
        'aria-label': 'Search services or the web',
        'aria-expanded': 'true',
        'aria-controls': listId,
        'aria-autocomplete': 'list',
        'aria-activedescendant': '',
        'data-autofocus': '',
      });
      const list = h('ul', { class: 'palette-list', id: listId, role: 'listbox', 'aria-label': 'Results' });
      const live = h('p', { class: 'sr-only', role: 'status' });

      /** @type {Array<{ el: HTMLElement, run: () => void }>} */
      let options = [];
      let active = -1;

      /** @param {number} i */
      function setActive(i) {
        active = i;
        options.forEach((o, idx) => {
          const on = idx === i;
          o.el.setAttribute('aria-selected', String(on));
          o.el.classList.toggle('is-active', on);
        });
        if (options[i]) {
          input.setAttribute('aria-activedescendant', options[i].el.id);
          options[i].el.scrollIntoView({ block: 'nearest' });
        } else input.setAttribute('aria-activedescendant', '');
      }

      /** @param {string} url */
      function openUrl(url) {
        ctrl.close();
        window.open(url, '_blank', 'noopener,noreferrer');
      }

      function renderResults() {
        const q = input.value.trim();
        const matches = rankServices(getServices(), q, 8);
        options = [];
        const items = [];
        for (const s of matches) {
          const href = safeUrl(s.url);
          if (!href) continue;
          const el = h(
            'li',
            { class: 'palette-option', role: 'option', id: nextId('opt'), 'aria-selected': 'false', onclick: () => openUrl(href), onmousemove: () => setActive(options.findIndex((o) => o.el === el)) },
            serviceIcon(s.icon),
            h('span', { class: 'palette-name' }, s.name),
            h('span', { class: 'palette-meta mono' }, hostOf(s.url)),
            h('span', { class: 'pill' }, resolveCategory(s)),
          );
          options.push({ el, run: () => openUrl(href) });
          items.push(el);
        }
        if (q) {
          const provider = getSearch().provider;
          const label = Object.hasOwn(SEARCH_PROVIDERS, provider) ? SEARCH_PROVIDERS[/** @type {keyof typeof SEARCH_PROVIDERS} */ (provider)].label.replace(/ \(.*\)$/, '') : 'Google';
          const run = () => openUrl(buildSearchUrl(getSearch(), q));
          const el = h(
            'li',
            { class: 'palette-option palette-web', role: 'option', id: nextId('opt'), 'aria-selected': 'false', onclick: run, onmousemove: () => setActive(options.findIndex((o) => o.el === el)) },
            icon('ui-globe-search'),
            h('span', { class: 'palette-name' }, `Search ${label} for “${q}”`),
            h('kbd', null, 'Enter'),
          );
          options.push({ el, run });
          items.push(el);
        }
        list.replaceChildren(...items);
        if (!items.length) list.appendChild(h('li', { class: 'palette-empty', role: 'presentation' }, 'Type to search your services or the web.'));
        active = -1;
        input.setAttribute('aria-activedescendant', '');
        live.textContent = q ? `${matches.length} matching service${matches.length === 1 ? '' : 's'}. Press Enter to search the web.` : '';
      }

      input.addEventListener('input', renderResults);
      input.addEventListener('keydown', (e) => {
        const n = options.length;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (n) setActive(active + 1 >= n ? 0 : active + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (n) setActive(active <= 0 ? n - 1 : active - 1);
        } else if (e.key === 'Home' && active >= 0) {
          e.preventDefault();
          setActive(0);
        } else if (e.key === 'End' && active >= 0) {
          e.preventDefault();
          setActive(n - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (active >= 0 && options[active]) options[active].run();
          else if (input.value.trim()) openUrl(buildSearchUrl(getSearch(), input.value.trim()));
        }
      });

      renderResults();
      return h(
        'div',
        { class: 'palette' },
        h('div', { class: 'palette-field' }, icon('ui-search'), input),
        list,
        live,
        h('p', { class: 'palette-hint' }, h('kbd', null, '↑'), h('kbd', null, '↓'), ' to move, ', h('kbd', null, 'Enter'), ' to open, ', h('kbd', null, 'Esc'), ' to close'),
      );
    },
  });
}

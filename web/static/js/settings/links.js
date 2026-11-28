// @ts-check
/** Settings: "Your links" (services) list with add / edit / delete. */

import { h } from '../dom.js';
import { icon, serviceIcon } from '../icons.js';
import { resolveCategory } from '../categorize.js';
import { hostOf } from '../lib/url.js';
import { openMonitoring } from '../features/monitoring.js';
import { openAddService, openEditService, removeService } from '../features/service-dialogs.js';

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountLinks(root, env) {
  const { api, store, state } = env;
  const list = h('ul', { class: 'list', 'aria-label': 'Services' });
  const empty = h('p', { class: 'muted' }, 'No services yet. Add the apps you run and they show up on your dashboard.');
  const addBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary',
      onclick: () =>
        openAddService({
          api,
          defaultDomain: store.get().defaultDomain,
          onSaved: (s) => state.set({ services: [...state.get().services, s] }),
        }),
    },
    icon('ui-plus'),
    h('span', null, 'Add service'),
  );
  root.append(h('p', { class: 'muted panel-intro' }, 'Services are stored on the server and shared across your devices. The category is detected automatically unless you choose one.'), list, empty, h('div', null, addBtn));

  /** @param {import('../types.js').Service} s */
  function row(s) {
    const auto = !s.category;
    return h(
      'li',
      { class: 'list-row' },
      h('span', { class: 'list-icon' }, serviceIcon(s.icon)),
      h(
        'div',
        { class: 'list-main' },
        h('p', { class: 'list-title', title: s.name }, s.name),
        h('p', { class: 'list-sub mono', title: s.url }, hostOf(s.url) || s.url),
      ),
      h('div', { class: 'list-meta' }, h('span', { class: 'pill' }, resolveCategory(s) + (auto ? ' · auto' : '')), h('span', { class: 'pill' + (s.check ? ' pill-ok' : '') }, s.check ? 'Status check on' : 'Status check off')),
      h(
        'div',
        { class: 'list-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm',
            'aria-label': `Edit ${s.name}`,
            onclick: () =>
              openEditService({
                api,
                service: s,
                defaultDomain: store.get().defaultDomain,
                onSaved: (saved) => state.set({ services: state.get().services.map((x) => (x.id === saved.id ? saved : x)) }),
                onDeleted: (id) => state.set({ services: state.get().services.filter((x) => x.id !== id) }),
              }),
          },
          'Edit',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm',
            'aria-label': 'Monitoring for ' + s.name,
            onclick: () => openMonitoring({ api, service: s }),
          },
          'Monitoring',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-danger',
            'aria-label': `Delete ${s.name}`,
            onclick: async () => {
              if (await removeService(api, s)) {
                state.set({ services: state.get().services.filter((x) => x.id !== s.id) });
                addBtn.focus();
              }
            },
          },
          'Delete',
        ),
      ),
    );
  }

  function render() {
    const services = [...state.get().services].sort((a, b) => a.name.localeCompare(b.name));
    list.replaceChildren(...services.map(row));
    empty.hidden = services.length > 0 || !state.get().loaded;
    list.hidden = services.length === 0;
  }
  state.subscribe((s, prev) => {
    if (s.services !== prev.services || s.loaded !== prev.loaded) render();
  });
  render();
}

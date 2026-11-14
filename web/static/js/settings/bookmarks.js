// @ts-check
/** Settings: bookmarks list with add / edit / delete. */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { openDialog, confirmDialog } from '../dialog.js';
import { createField, createNotice, showFormError, whileBusy } from '../ui.js';
import { safeUrl, withScheme, hostOf } from '../lib/url.js';
import { isHex } from '../lib/color.js';
import { colorFor } from '../features/bookmarks.js';
import { toastSuccess, toastError } from '../toast.js';

/**
 * @param {{ api: import('../api.js').Api, bookmark?: import('../types.js').Bookmark, onSaved: (b: import('../types.js').Bookmark) => void }} o
 */
function openBookmarkDialog(o) {
  const b = o.bookmark;
  openDialog({
    title: b ? `Edit ${b.name}` : 'Add a bookmark',
    build(ctrl) {
      const name = createField({ label: 'Name', value: b ? b.name : '', required: true, maxLength: 100, autofocus: true });
      const url = createField({ label: 'Address', value: b ? b.url : '', placeholder: 'https://example.com', required: true, inputMode: 'url', spellcheck: false });
      const color = createField({ label: 'Dot colour', control: h('input', { type: 'color', value: b && isHex(b.color) ? b.color : '#5e6ad2' }), className: 'field-inline' });
      const notice = createNotice();
      const save = h('button', { type: 'submit', class: 'btn btn-primary' }, b ? 'Save changes' : 'Add bookmark');
      const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctrl.close() }, 'Cancel');
      const map = { name, url, color };
      return h(
        'form',
        {
          class: 'dlg-content',
          novalidate: true,
          onsubmit: async (/** @type {Event} */ e) => {
            e.preventDefault();
            notice.clear();
            for (const f of Object.values(map)) f.setError(null);
            const n = name.input.value.trim();
            const u = withScheme(url.input.value);
            if (!n) return name.setError('Enter a name.'), name.input.focus();
            if (!safeUrl(u)) return url.setError('Enter a valid web address.'), url.input.focus();
            const body = { name: n, url: u, color: color.input.value || colorFor(n) };
            await whileBusy([save, cancel], async () => {
              try {
                const res = b ? await o.api.patch('/api/bookmarks/' + encodeURIComponent(b.id), body) : await o.api.post('/api/bookmarks', body);
                ctrl.close(true);
                o.onSaved(res.bookmark);
                toastSuccess(b ? 'Saved.' : 'Bookmark added.');
              } catch (err) {
                showFormError(err, map, notice);
              }
            });
          },
        },
        notice.el,
        name.root,
        url.root,
        color.root,
        h('div', { class: 'dlg-footer' }, cancel, save),
      );
    },
  });
}

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountBookmarks(root, env) {
  const { api, state } = env;
  const list = h('ul', { class: 'list', 'aria-label': 'Bookmarks' });
  const empty = h('p', { class: 'muted' }, 'No bookmarks yet. Bookmarks show up as quick links next to your services.');
  const addBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary',
      onclick: () => openBookmarkDialog({ api, onSaved: (nb) => state.set({ bookmarks: [...state.get().bookmarks, nb] }) }),
    },
    icon('ui-plus'),
    h('span', null, 'Add bookmark'),
  );
  root.append(list, empty, h('div', null, addBtn));

  /** @param {import('../types.js').Bookmark} b */
  function row(b) {
    return h(
      'li',
      { class: 'list-row' },
      h('span', { class: 'bookmark-dot', 'aria-hidden': 'true', style: isHex(b.color) ? { '--dot': b.color } : {} }),
      h('div', { class: 'list-main' }, h('p', { class: 'list-title', title: b.name }, b.name), h('p', { class: 'list-sub mono', title: b.url }, hostOf(b.url) || b.url)),
      h(
        'div',
        { class: 'list-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm',
            'aria-label': `Edit ${b.name}`,
            onclick: () => openBookmarkDialog({ api, bookmark: b, onSaved: (nb) => state.set({ bookmarks: state.get().bookmarks.map((x) => (x.id === nb.id ? nb : x)) }) }),
          },
          'Edit',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-danger',
            'aria-label': `Delete ${b.name}`,
            onclick: async () => {
              const yes = await confirmDialog({ title: 'Delete bookmark?', message: `“${b.name}” will be removed.`, confirmLabel: 'Delete', danger: true });
              if (!yes) return;
              try {
                await api.del('/api/bookmarks/' + encodeURIComponent(b.id));
                state.set({ bookmarks: state.get().bookmarks.filter((x) => x.id !== b.id) });
                toastSuccess('Bookmark deleted.');
                addBtn.focus();
              } catch (err) {
                toastError(err instanceof Error ? err.message : "Couldn't delete the bookmark.");
              }
            },
          },
          'Delete',
        ),
      ),
    );
  }

  function render() {
    const items = state.get().bookmarks;
    list.replaceChildren(...items.map(row));
    list.hidden = items.length === 0;
    empty.hidden = items.length > 0 || !state.get().loaded;
  }
  state.subscribe((s, prev) => {
    if (s.bookmarks !== prev.bookmarks || s.loaded !== prev.loaded) render();
  });
  render();
}

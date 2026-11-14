// @ts-check
/** Dashboard bookmark chips with an inline "add" form. */

import { h } from '../dom.js';
import { createField, createNotice, showFormError, whileBusy } from '../ui.js';
import { safeUrl, withScheme } from '../lib/url.js';
import { isHex } from '../lib/color.js';
import { toastSuccess } from '../toast.js';

const PALETTE = ['#5E6AD2', '#22C55E', '#EAB308', '#F97316', '#EF4444', '#EC4899', '#8B5CF6', '#14B8A6', '#0EA5E9', '#64748B'];

/**
 * A stable colour for a new bookmark, derived from its name.
 * @param {string} name
 */
export function colorFor(name) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length];
}

/**
 * Chips for bookmarks. Shared by the dashboard widget.
 * @param {import('../types.js').Bookmark[]} bookmarks
 */
export function renderBookmarkChips(bookmarks) {
  if (!bookmarks.length) return [h('p', { class: 'muted small' }, 'No bookmarks yet.')];
  return bookmarks.map((b) => {
    const href = safeUrl(b.url);
    const dot = h('span', { class: 'bookmark-dot', 'aria-hidden': 'true', style: isHex(b.color) ? { '--dot': b.color } : {} });
    const label = h('span', { class: 'bookmark-name' }, b.name);
    return href
      ? h('a', { class: 'bookmark glass', href, title: b.name, target: '_blank', rel: 'noopener noreferrer' }, dot, label, h('span', { class: 'sr-only' }, ' (opens in a new tab)'))
      : h('span', { class: 'bookmark glass bookmark-invalid', title: 'Not a valid web address' }, dot, label);
  });
}

/**
 * @param {{
 *   list: HTMLElement, addBtn: HTMLButtonElement, formHost: HTMLElement,
 *   api: import('../api.js').Api,
 *   getBookmarks: () => import('../types.js').Bookmark[],
 *   onAdded: (b: import('../types.js').Bookmark) => void,
 * }} o
 */
export function createBookmarksWidget(o) {
  /** @type {HTMLFormElement | null} */
  let form = null;

  function closeForm() {
    if (form) form.remove();
    form = null;
    o.addBtn.setAttribute('aria-expanded', 'false');
    o.addBtn.focus();
  }

  function openForm() {
    if (form) {
      /** @type {HTMLInputElement | null} */ (form.querySelector('input'))?.focus();
      return;
    }
    const name = createField({ label: 'Name', name: 'name', placeholder: 'e.g. Wiki', required: true, maxLength: 100, autofocus: true });
    const url = createField({ label: 'Address', name: 'url', placeholder: 'https://example.com', required: true, inputMode: 'url', spellcheck: false });
    const notice = createNotice();
    const save = h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Save');
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: closeForm }, 'Cancel');
    form = /** @type {HTMLFormElement} */ (
      h(
        'form',
        {
          class: 'bookmark-form',
          novalidate: true,
          onkeydown: (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              closeForm();
            }
          },
          onsubmit: async (/** @type {Event} */ e) => {
            e.preventDefault();
            name.setError(null);
            url.setError(null);
            const n = name.input.value.trim();
            const u = withScheme(url.input.value);
            if (!n) return name.setError('Enter a name.'), name.input.focus();
            if (!safeUrl(u)) return url.setError('Enter a valid web address.'), url.input.focus();
            await whileBusy([save, cancel], async () => {
              try {
                const res = await o.api.post('/api/bookmarks', { name: n, url: u, color: colorFor(n) });
                o.onAdded(res.bookmark);
                closeForm();
                toastSuccess('Bookmark added.');
              } catch (err) {
                showFormError(err, { name, url }, notice);
              }
            });
          },
        },
        notice.el,
        name.root,
        url.root,
        h('div', { class: 'form-actions' }, save, cancel),
      )
    );
    o.formHost.appendChild(form);
    o.addBtn.setAttribute('aria-expanded', 'true');
    name.input.focus();
  }

  o.addBtn.addEventListener('click', () => (form ? closeForm() : openForm()));

  return {
    render() {
      o.list.replaceChildren(...renderBookmarkChips(o.getBookmarks()));
    },
  };
}

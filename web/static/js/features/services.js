// @ts-check
/**
 * The services grid: groups by category (largest first), cards with status.
 * Cards are rendered once per data change; status dots are updated in place.
 */

import { h } from '../dom.js';
import { icon, serviceIcon } from '../icons.js';
import { resolveCategory } from '../categorize.js';
import { hostOf, safeUrl } from '../lib/url.js';

/** Groups with at least this many services span the full row. */
export const BIG_GROUP = 4;

const STATUS_TEXT = {
  up: 'Online',
  down: 'Offline',
  unknown: 'Status unknown',
  checking: 'Checking status',
};

/**
 * Groups services by their displayed category, largest group first.
 * @template {{ name: string, url: string, description?: string, category?: string | null }} S
 * @param {S[]} services
 * @returns {Array<{ category: string, items: S[] }>}
 */
export function groupServices(services) {
  /** @type {Map<string, S[]>} */
  const map = new Map();
  for (const s of services) {
    const c = resolveCategory(s);
    const list = map.get(c);
    if (list) list.push(s);
    else map.set(c, [s]);
  }
  return [...map.entries()]
    .map(([category, items]) => ({ category, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.items.length - a.items.length || a.category.localeCompare(b.category));
}

/**
 * @param {{
 *   root: HTMLElement,
 *   onEdit: (s: import('../types.js').Service) => void,
 *   onDelete: (s: import('../types.js').Service) => void,
 * }} o
 */
export function createServicesView({ root, onEdit, onDelete }) {
  /** @type {Map<string, { el: HTMLElement, text: HTMLElement }>} service id -> status elements */
  let statusEls = new Map();
  /** @type {Map<string, HTMLElement>} */
  let cardLinks = new Map();

  /**
   * @param {import('../types.js').Service} s
   * @param {boolean} showStatus
   */
  function card(s, showStatus) {
    const href = safeUrl(s.url);
    const label = h('span', null, s.name);
    const link = href
      ? h('a', { class: 'card-link', href, target: '_blank', rel: 'noopener noreferrer' }, label, h('span', { class: 'sr-only' }, ' (opens in a new tab)'))
      : h('span', { class: 'card-link card-link-invalid', title: 'This address is not a valid web URL.' }, label);
    if (href) cardLinks.set(s.id, link);

    /** @type {HTMLElement | null} */
    let status = null;
    if (showStatus && s.check) {
      const text = h('span', { class: 'sr-only' }, STATUS_TEXT.checking);
      status = h('span', { class: 'status status-checking', title: STATUS_TEXT.checking }, h('span', { class: 'status-dot', 'aria-hidden': 'true' }), text);
      statusEls.set(s.id, { el: status, text });
    }

    return h(
      'article',
      { class: 'card glass', dataset: { id: s.id } },
      h('span', { class: 'accent-bar', 'aria-hidden': 'true' }),
      h('span', { class: 'card-icon' }, serviceIcon(s.icon)),
      h(
        'div',
        { class: 'card-body' },
        h('div', { class: 'card-title' }, link, status),
        s.description ? h('p', { class: 'card-desc' }, s.description) : null,
        h('p', { class: 'card-host mono' }, hostOf(s.url)),
      ),
      h(
        'div',
        { class: 'card-actions' },
        h('button', { type: 'button', class: 'card-action', 'aria-label': `Edit ${s.name}`, title: 'Edit', onclick: () => onEdit(s) }, icon('ui-edit')),
        h('button', { type: 'button', class: 'card-action card-action-danger', 'aria-label': `Delete ${s.name}`, title: 'Delete', onclick: () => onDelete(s) }, icon('ui-trash')),
      ),
    );
  }

  return {
    /**
     * @param {import('../types.js').Service[]} services
     * @param {{ showStatus: boolean }} opts
     */
    render(services, opts) {
      statusEls = new Map();
      cardLinks = new Map();
      const groups = groupServices(services);
      root.replaceChildren(
        ...groups.map(({ category, items }, i) => {
          const big = items.length >= BIG_GROUP;
          const headingId = 'group-' + i;
          return h(
            'section',
            { class: 'group ' + (big ? 'group-big' : 'group-small'), 'aria-labelledby': headingId, dataset: { category } },
            h('h3', { class: 'eyebrow', id: headingId }, category, h('span', { class: 'group-count' }, ` · ${items.length}`)),
            h('div', { class: 'group-grid' }, items.map((s) => card(s, opts.showStatus))),
          );
        }),
      );
    },
    /**
     * Updates the dots in place from `/api/status` data.
     * @param {Record<string, { state: string }>} statuses
     */
    applyStatuses(statuses) {
      for (const [id, { el, text }] of statusEls) {
        const known = Object.hasOwn(statuses, id) ? statuses[id].state : null;
        const state = known === 'up' || known === 'down' ? known : known === 'unknown' ? 'unknown' : 'checking';
        el.className = 'status status-' + (state === 'unknown' ? 'unknown' : state);
        const msg = STATUS_TEXT[/** @type {keyof typeof STATUS_TEXT} */ (state)];
        text.textContent = msg;
        el.title = msg;
      }
    },
    /** Moves focus to a card's link (after an edit re-rendered the grid). @param {string} id */
    focusCard(id) {
      const el = cardLinks.get(id) || root.querySelector(`[data-id="${CSS.escape(id)}"] .card-action`);
      if (el instanceof HTMLElement) el.focus();
    },
  };
}

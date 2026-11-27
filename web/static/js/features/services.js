// @ts-check
/**
 * The services grid: groups by category (largest first), cards with status.
 * Cards are rendered once per data change; status dots are updated in place.
 */

import { h } from '../dom.js';
import { icon, serviceIcon } from '../icons.js';
import { resolveCategory } from '../categorize.js';
import { hostOf, safeUrl } from '../lib/url.js';
import { balancedColumns, columnsFor } from '../lib/layout.js';
import { isDiscovered, containerBadge, containerTitle } from '../lib/docker.js';

/** Groups with at least this many services span the full row. */
export const BIG_GROUP = 4;

/** Minimum widths in rem (match the CSS): one group column, one card in a big group. */
const GROUP_MIN_REM = 17;
const CARD_MIN_REM = 15;
const MAX_GROUP_COLUMNS = 3;
/** From this many services on, off-screen groups are not painted (see .groups-long). */
const LONG_LIST = 150;

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
 *   onMonitoring: (s: import('../types.js').Service) => void,
 *   onDetails: (s: import('../types.js').DiscoveredService) => void,
 * }} o
 */
export function createServicesView({ root, onEdit, onDelete, onMonitoring, onDetails }) {
  /** @type {Map<string, { el: HTMLElement, text: HTMLElement, forceDown: boolean }>} service id -> status elements */
  let statusEls = new Map();
  /** @type {Map<string, HTMLElement>} */
  let cardLinks = new Map();

  /**
   * Sets the column counts from the available width, so rows stay balanced:
   * the small groups share rows evenly and a big group never ends with a lone card.
   * Cards keep their minimum width; only the number of columns changes.
   */
  function layout() {
    const width = root.clientWidth;
    if (!width) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const gap = 0.75 * rem;
    const small = root.querySelectorAll('.group-small').length;
    const groupCols = Math.min(MAX_GROUP_COLUMNS, columnsFor(width, GROUP_MIN_REM * rem, 1.5 * rem));
    root.style.setProperty('--group-cols', String(balancedColumns(small, groupCols)));
    for (const grid of root.querySelectorAll('.group-big .group-grid')) {
      const cols = balancedColumns(grid.childElementCount, columnsFor(width, CARD_MIN_REM * rem, gap));
      /** @type {HTMLElement} */ (grid).style.setProperty('--cols', String(cols));
    }
  }

  if (typeof ResizeObserver === 'function') new ResizeObserver(layout).observe(root);

  /**
   * @param {import('../types.js').Service | import('../types.js').DiscoveredService} s
   * @param {{ showStatus: boolean, stale: boolean }} o
   */
  function card(s, { showStatus, stale }) {
    const found = isDiscovered(s) && 'container' in s ? s : null;
    const href = safeUrl(s.url);
    const label = h('span', null, s.name);
    const link = href
      ? h('a', { class: 'card-link', href, title: found ? containerTitle(found, { stale }) : s.name, target: '_blank', rel: 'noopener noreferrer' }, label, h('span', { class: 'sr-only' }, ' (opens in a new tab)'))
      : h('span', { class: 'card-link card-link-invalid', title: 'This address is not a valid web URL.' }, label);
    if (href) cardLinks.set(s.id, link);

    /** @type {HTMLElement | null} */
    let status = null;
    // A container that is not running reads as down whatever the server's check says; the dot follows
    // the server's status otherwise (including while the discovered list is stale).
    const forceDown = !!found && found.container.state !== 'running';
    if (showStatus && (s.check || forceDown)) {
      const text = h('span', { class: 'sr-only' }, STATUS_TEXT.checking);
      status = h('span', { class: 'status status-checking', title: STATUS_TEXT.checking }, h('span', { class: 'status-dot', 'aria-hidden': 'true' }), text);
      statusEls.set(s.id, { el: status, text, forceDown });
    }

    // Discovered cards say what state the container is in (text and tone, never colour alone).
    const badge = found ? (stale ? { label: 'Last known', tone: 'neutral' } : containerBadge(found.container)) : null;
    const host = hostOf(s.url);
    const actions = found
      ? h('button', { type: 'button', class: 'card-action', 'aria-label': `Details for ${s.name}`, title: 'Details', onclick: () => onDetails(found) }, icon('ui-info'))
      : [
          h('button', { type: 'button', class: 'card-action', 'aria-label': `Monitoring for ${s.name}`, 'aria-haspopup': 'dialog', title: 'Monitoring', onclick: () => onMonitoring(/** @type {import('../types.js').Service} */ (s)) }, icon('pulse')),
          h('button', { type: 'button', class: 'card-action', 'aria-label': `Edit ${s.name}`, title: 'Edit', onclick: () => onEdit(/** @type {import('../types.js').Service} */ (s)) }, icon('ui-edit')),
          h('button', { type: 'button', class: 'card-action card-action-danger', 'aria-label': `Delete ${s.name}`, title: 'Delete', onclick: () => onDelete(/** @type {import('../types.js').Service} */ (s)) }, icon('ui-trash')),
        ];

    return h(
      'article',
      { class: 'card glass' + (found ? ' card-docker' + (badge ? ' card-' + badge.tone : '') : ''), dataset: { id: s.id } },
      h('span', { class: 'accent-bar', 'aria-hidden': 'true' }),
      h('span', { class: 'card-icon' }, serviceIcon(s.icon)),
      h(
        'div',
        { class: 'card-body' },
        h('div', { class: 'card-title' }, link, badge ? h('span', { class: 'tag tag-' + badge.tone }, badge.label) : null, status),
        s.description ? h('p', { class: 'card-desc', title: s.description }, s.description) : null,
        h(
          'p',
          { class: 'card-host mono', title: host },
          found ? h('span', { class: 'docker-mark', title: 'Discovered from Docker' }, icon('ui-docker'), h('span', { class: 'sr-only' }, 'Discovered from Docker: ')) : null,
          host,
        ),
      ),
      h('div', { class: 'card-actions' }, actions),
    );
  }

  return {
    /**
     * @param {Array<import('../types.js').Service | import('../types.js').DiscoveredService>} services
     * @param {{ showStatus: boolean, stale?: boolean }} opts `stale`: discovered cards show the last known state
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
            h('div', { class: 'group-grid' }, items.map((s) => card(s, { showStatus: opts.showStatus, stale: !!opts.stale }))),
          );
        }),
      );
      root.classList.toggle('groups-long', services.length > LONG_LIST);
      layout();
    },
    layout,
    /**
     * Updates the dots in place from `/api/status` data.
     * @param {Record<string, { state: string }>} statuses
     */
    applyStatuses(statuses) {
      for (const [id, { el, text, forceDown }] of statusEls) {
        // A discovered id can be missing from a loaded map (no listing yet, or too old): that is unknown, not "checking".
        const missing = id.startsWith('docker:') && Object.keys(statuses).length > 0 ? 'unknown' : null;
        const known = forceDown ? 'down' : Object.hasOwn(statuses, id) ? statuses[id].state : missing;
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

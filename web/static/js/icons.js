// @ts-check
/**
 * Icons come from one SVG sprite (/static/img/icons.svg). Service icons use
 * their plain ids (the same ids the backend validates); interface icons use a
 * `ui-` prefix.
 */

import { h } from './dom.js';
import { knownIcon } from './lib/icon-ids.js';

export { ICON_IDS, ICON_SET, knownIcon } from './lib/icon-ids.js';

const SPRITE = '/static/img/icons.svg';

/**
 * An inline `<svg><use></svg>` for a sprite symbol.
 * @param {string} id sprite symbol id, e.g. `ui-plus` or `server`
 * @param {{ className?: string }} [opts]
 */
export function icon(id, opts = {}) {
  const svg = h('svg', { class: 'icon' + (opts.className ? ' ' + opts.className : ''), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  svg.appendChild(h('use', { href: `${SPRITE}#${id}` }));
  return svg;
}

/**
 * Icon for a service; unknown ids fall back to "box".
 * @param {unknown} id
 * @param {{ className?: string }} [opts]
 */
export function serviceIcon(id, opts) {
  return icon(knownIcon(id), opts);
}

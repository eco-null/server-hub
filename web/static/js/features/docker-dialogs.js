// @ts-check
/** Read-only details of a service discovered from Docker. */

import { h, nextId } from '../dom.js';
import { openDialog } from '../dialog.js';
import { resolveCategory } from '../categorize.js';
import { safeUrl } from '../lib/url.js';
import { stateLabel, healthLabel, containerBadge } from '../lib/docker.js';

/**
 * @param {import('../types.js').DiscoveredService} s
 * @param {{ stale?: boolean }} [opts]
 */
export function openDiscoveredDetails(s, opts = {}) {
  openDialog({
    title: s.name,
    size: 'sm',
    build(ctrl) {
      const hintId = nextId('dlg-msg');
      ctrl.el.setAttribute('aria-describedby', hintId);
      const c = s.container;
      const badge = containerBadge(c);
      const href = safeUrl(s.url);

      /** @param {string} term @param {import('../dom.js').Child} value @param {boolean} [mono] */
      const row = (term, value, mono = false) => h('div', { class: 'detail-row' }, h('dt', null, term), h('dd', { class: mono ? 'mono' : undefined }, value));

      const rows = [
        row('Address', href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'detail-link' }, s.url, h('span', { class: 'sr-only' }, ' (opens in a new tab)')) : s.url || 'None', true),
        s.description ? row('Description', s.description) : null,
        row('Category', s.category ? s.category : `${resolveCategory(s)} (automatic)`),
        row('Status check', s.check ? 'On' : 'Off'),
        row('Container', c.name, true),
        row('Image', c.image, true),
        row('State', h('span', { class: 'tag tag-' + (badge ? badge.tone : 'ok') }, stateLabel(c.state))),
        row('Health', c.health ? h('span', { class: 'tag tag-' + (c.health === 'healthy' ? 'ok' : c.health === 'unhealthy' ? 'bad' : 'warn') }, healthLabel(c.health)) : healthLabel(null)),
        row('Docker status', c.status || stateLabel(c.state)),
      ];

      return h(
        'div',
        { class: 'dlg-content' },
        opts.stale ? h('p', { class: 'banner banner-info', role: 'status' }, 'Docker is unavailable right now, so this is the last known state.') : null,
        h('dl', { class: 'detail-list' }, rows),
        h('p', { id: hintId, class: 'field-hint' }, 'This service is managed by its container labels (serverhub.*). Change the labels and recreate the container to edit it here.'),
        h('div', { class: 'dlg-footer' }, h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': '', onclick: () => ctrl.close() }, 'Close')),
      );
    },
  });
}

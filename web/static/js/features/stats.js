// @ts-check
/**
 * System widget: Beszel hubs (any number) and, for admins, this server's own
 * CPU/memory/disk. Hidden entirely when there is nothing to show.
 */

import { h } from '../dom.js';
import { clampPct, formatUptime, loadLevel } from '../lib/format.js';
import { createPoller } from '../poller.js';

const POLL_MS = 15000;

/**
 * One usage bar with a text value, exposed as a meter.
 * @param {string} label
 * @param {unknown} value
 */
export function usageBar(label, value) {
  const pct = clampPct(value);
  const level = loadLevel(pct);
  const fill = h('div', { class: 'bar-fill' });
  if (pct !== null) fill.style.width = pct.toFixed(0) + '%';
  return h(
    'div',
    { class: 'bar bar-' + level, role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct === null ? undefined : String(Math.round(pct)), 'aria-valuetext': pct === null ? 'No data' : `${Math.round(pct)} percent` + (level === 'ok' ? '' : level === 'warn' ? ', high' : ', critical') },
    h('span', { class: 'bar-label', 'aria-hidden': 'true' }, label),
    h('div', { class: 'bar-track', 'aria-hidden': 'true' }, fill),
    h('span', { class: 'bar-value', 'aria-hidden': 'true' }, pct === null ? '—' : pct.toFixed(0) + '%'),
  );
}

/** Bars for the metrics that have data (non-Linux hosts report null). @param {{ cpu?: unknown, memory?: unknown, disk?: unknown }} s */
function bars(s) {
  return [['CPU', s.cpu], ['Memory', s.memory], ['Disk', s.disk]].filter(([, v]) => clampPct(v) !== null).map(([l, v]) => usageBar(String(l), v));
}

/**
 * @param {{
 *   card: HTMLElement, body: HTMLElement,
 *   api: import('../api.js').Api,
 *   isAdmin: () => boolean,
 *   isEnabled: () => boolean,
 * }} o
 */
export function createStatsWidget(o) {
  async function load() {
    const [beszel, host] = await Promise.allSettled([o.api.get('/api/beszel/systems'), o.isAdmin() ? o.api.get('/api/stats') : Promise.resolve(null)]);
    /** @type {HTMLElement[]} */
    const blocks = [];
    let hostName = '';

    if (host.status === 'fulfilled' && host.value) {
      const s = host.value;
      hostName = typeof s.hostname === 'string' ? s.hostname : '';
      blocks.push(
        h('div', { class: 'sys' }, h('div', { class: 'sys-head' }, h('span', { class: 'sys-name' }, 'This server'), h('span', { class: 'sys-meta mono' }, hostName)), ...bars(s)),
      );
    }

    if (beszel.status === 'fulfilled' && beszel.value && Array.isArray(beszel.value.instances)) {
      const instances = beszel.value.instances;
      for (const inst of instances) {
        const prefix = instances.length > 1 ? `${inst.name} · ` : '';
        if (!inst.ok) {
          blocks.push(h('div', { class: 'sys' }, h('div', { class: 'sys-head' }, h('span', { class: 'sys-name' }, inst.name || 'Beszel'), h('span', { class: 'sys-meta' }, 'Unreachable'))));
          continue;
        }
        for (const sys of inst.systems || []) {
          const up = formatUptime(sys.uptime_seconds);
          blocks.push(
            h(
              'div',
              { class: 'sys' },
              h('div', { class: 'sys-head' }, h('span', { class: 'sys-name', title: sys.host || '' }, prefix + sys.name), h('span', { class: 'sys-meta mono' }, [sys.status, up].filter(Boolean).join(' · '))),
              ...bars(sys),
            ),
          );
        }
      }
    }

    o.card.hidden = blocks.length === 0 || !o.isEnabled();
    o.body.replaceChildren(...blocks);
  }

  const poller = createPoller(load, POLL_MS, { isEnabled: o.isEnabled });
  return {
    start: () => poller.start(),
    stop: () => {
      poller.stop();
      o.card.hidden = true;
    },
    refresh: () => poller.refresh(),
  };
}

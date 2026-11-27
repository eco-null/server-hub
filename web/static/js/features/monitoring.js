// @ts-check
/** The owner's monitoring controls and incident history. */

import { openDialog } from '../dialog.js';
import { h, nextId } from '../dom.js';
import { formatUptime } from '../lib/format.js';
import { createNotice, showFormError } from '../ui.js';

/** @typedef {{ started_at: number, ended_at: number | null, end_reason: 'recovered' | 'paused' | null }} Incident */
/** @typedef {{
 *   available: boolean,
 *   enabled: boolean,
 *   check_enabled: boolean,
 *   last_check: import('../types.js').ServiceStatus | null,
 *   summary: { uptime_pct: number | null, checked: number, expected: number, unknown: number, missing: number },
 *   incidents: Incident[],
 *   next_before: number | null,
 * }} Monitoring */

const counts = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** @param {string} term @param {import('../dom.js').Child} value */
function detail(term, value) {
  return h('div', { class: 'detail-row' }, h('dt', null, term), h('dd', null, value));
}

/** @param {number | string} when Seconds since the epoch or an ISO timestamp. */
function dateText(when) {
  const date = new Date(typeof when === 'number' ? when * 1000 : when);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return h('time', { class: 'mono', datetime: iso, title: iso }, dates.format(date));
}

/** @param {Incident} entry */
function incidentRow(entry) {
  const open = entry.ended_at === null;
  const label = open ? 'Ongoing' : entry.end_reason === 'paused' ? 'Monitoring paused' : 'Recovered';
  const tone = open ? 'bad' : entry.end_reason === 'recovered' ? 'ok' : 'warn';
  const elapsed = entry.ended_at === null ? '' : formatUptime(entry.ended_at - entry.started_at);
  return h(
    'li',
    { tabindex: '-1' },
    h('div', { class: 'monitor-incident-title' }, h('span', { class: 'tag tag-' + tone }, label), elapsed ? h('span', { class: 'mono muted' }, elapsed) : null),
    h('span', { class: 'field-hint' }, 'Started ', dateText(entry.started_at)),
    entry.ended_at === null ? null : h('span', { class: 'field-hint' }, 'Ended ', dateText(entry.ended_at)),
  );
}

/** @param {Monitoring} data */
function summaryDetails(data) {
  const { summary, last_check: latest } = data;
  const checked = counts.format(summary.checked);
  const expected = counts.format(summary.expected);
  const status = latest ? { up: 'Online', down: 'Offline', unknown: 'Unknown' }[latest.state] : 'No results yet';
  const last = latest?.checked_at ? [status, ' · ', dateText(latest.checked_at)] : status;
  const coverage = summary.expected
    ? [h('span', { class: 'mono' }, `${checked} / ${expected}`), ' conclusive checks']
    : data.available && data.enabled ? 'Waiting for the first check' : 'No checks scheduled';
  return [
    detail('Last check', last),
    detail('Uptime', summary.uptime_pct === null ? 'No conclusive checks' : h('span', { class: 'mono' }, counts.format(summary.uptime_pct) + '%')),
    detail('Coverage', coverage),
    summary.unknown || summary.missing ? detail('Gaps', h('span', { class: 'mono' }, `${counts.format(summary.unknown)} inconclusive · ${counts.format(summary.missing)} missed`)) : null,
  ];
}

/**
 * @param {{ api: import('../api.js').Api, service: import('../types.js').Service, onChanged?: () => void }} o
 */
export function openMonitoring({ api, service, onChanged }) {
  const path = '/api/services/' + encodeURIComponent(service.id) + '/monitoring';
  /** @type {Monitoring | null} */
  let data = null;
  /** @type {AbortController | null} */
  let pending = null;
  const notice = createNotice();
  const progress = h('p', { class: 'field-hint', role: 'status' });
  const state = h('p', { class: 'field-hint', role: 'status' });
  const metrics = h('dl', { class: 'detail-list' });
  const empty = h('p', { class: 'field-hint' }, 'No incidents in the last seven days.');
  const incidents = h('ol', { class: 'monitor-incidents', role: 'list' });
  const historyId = nextId('monitor-history');
  const retry = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => void load('initial') }, 'Try again');
  const older = h('button', { class: 'btn btn-sm', type: 'button', hidden: true, onclick: () => void load('older') }, 'Show older incidents');
  const toggle = h('button', { class: 'btn btn-primary', type: 'button', hidden: true, onclick: () => void load('change') });
  const history = h(
    'section',
    { class: 'monitor-history', 'aria-labelledby': historyId, hidden: true },
    h('h3', { id: historyId }, 'Incidents'),
    empty,
    incidents,
    h('div', null, older),
  );
  const view = h('div', { class: 'monitor-history', hidden: true }, state, h('h3', null, 'Seven-day summary'), metrics);
  const close = h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => ctrl.close() }, 'Close');
  const ctrl = openDialog({
    title: 'Monitoring for ' + service.name,
    className: 'monitor-dialog',
    build: () => h('div', { class: 'dlg-content' }, view, history, progress, notice.el, h('div', { class: 'dlg-footer' }, retry, toggle, close)),
  });
  void ctrl.closed.then(() => pending?.abort());

  /** @param {Monitoring} snapshot */
  function render(snapshot) {
    view.hidden = false;
    history.hidden = false;
    if (!snapshot.available) state.textContent = 'Monitoring is off for this installation.';
    else if (!snapshot.check_enabled) state.textContent = 'Turn on status checks for this service to use monitoring.';
    else state.textContent = snapshot.enabled ? 'Monitoring is on. Checks run once a minute.' : 'Monitoring is off for this service.';
    metrics.replaceChildren(...summaryDetails(snapshot).filter((item) => item !== null));
    empty.hidden = snapshot.incidents.length > 0;
    incidents.replaceChildren(...snapshot.incidents.map(incidentRow));
    toggle.hidden = !snapshot.enabled && !(snapshot.available && snapshot.check_enabled);
    toggle.textContent = snapshot.enabled ? 'Pause monitoring' : 'Enable monitoring';
  }

  /** @param {'initial' | 'older' | 'change'} action */
  async function load(action) {
    if (pending) return;
    if (action !== 'initial' && data === null) return;
    const before = data?.next_before;
    if (action === 'older' && before == null) return;
    const request = new AbortController();
    pending = request;
    const controls = [retry, older, toggle];
    for (const button of controls) button.setAttribute('aria-disabled', 'true');
    notice.clear();
    progress.hidden = false;
    progress.textContent = action === 'change' ? 'Saving…' : action === 'older' ? 'Loading older incidents…' : 'Loading monitoring…';
    const options = { signal: request.signal };
    try {
      /** @type {Monitoring} */
      const response = action === 'change'
        ? await api.put(path, { enabled: !data?.enabled }, options)
        : await api.get(action === 'older' ? path + '?before=' + encodeURIComponent(String(before)) : path, options);
      if (request.signal.aborted) return;
      const active = document.activeElement;
      if (action === 'older' && data) {
        data = { ...data, next_before: response.next_before };
        const rows = response.incidents.map(incidentRow);
        incidents.append(...rows);
        if (active === older) (rows[0] || close).focus();
      } else {
        data = response;
        render(response);
        if (active === retry) (toggle.hidden ? close : toggle).focus();
        if (active === toggle && toggle.hidden) close.focus();
        if (action === 'change') onChanged?.();
      }
      retry.hidden = true;
      older.hidden = data.next_before == null;
    } catch (err) {
      if (!request.signal.aborted) {
        retry.hidden = data !== null;
        showFormError(err, {}, notice);
      }
    } finally {
      pending = null;
      progress.hidden = true;
      for (const button of controls) button.removeAttribute('aria-disabled');
    }
  }

  void load('initial');
}

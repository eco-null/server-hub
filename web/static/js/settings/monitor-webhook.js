// @ts-check
/** Administration settings for the write-only monitoring webhook destination. */

import { ApiError } from '../api.js';
import { confirmDialog } from '../dialog.js';
import { h } from '../dom.js';
import { safeUrl } from '../lib/url.js';
import { createField, createNotice } from '../ui.js';

const endpoint = '/api/admin/monitoring/webhook';
const dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const failures = {
  invalid_url: 'Invalid destination',
  invalid_destination: 'Stored destination could not be read',
  blocked: 'Destination blocked',
  dns: 'Destination name could not be resolved',
  timeout: 'Request timed out',
  connect: 'Connection failed',
  tls: 'TLS verification failed',
  too_large: 'Response too large',
  protocol: 'Invalid response',
  busy: 'Sender busy',
  expired: 'Delivery expired',
  internal: 'Sender error',
};

/**
 * @typedef {{
 *   status: 'pending' | 'delivered' | 'failed',
 *   kind: 'down' | 'recovered',
 *   occurred_at: number,
 *   attempts: number,
 *   last_error: string | null,
 * }} Delivery
 */

/** @param {Delivery} delivery */
function deliveryText(delivery) {
  const status = { pending: 'Pending', delivered: 'Delivered', failed: 'Failed' }[delivery.status];
  const event = { down: 'Outage', recovered: 'Recovery' }[delivery.kind];
  const date = new Date(delivery.occurred_at * 1000);
  const timestamp = Number.isFinite(date.getTime())
    ? h('time', { datetime: date.toISOString(), class: 'mono' }, dates.format(date))
    : null;
  const error = delivery.last_error;
  const failure = error && /^http_[1-5]\d{2}$/.test(error)
    ? 'HTTP ' + error.slice(5)
    : error && Object.hasOwn(failures, error) ? failures[/** @type {keyof typeof failures} */ (error)] : null;
  return [
    event, ' · ', status,
    timestamp && [' · ', timestamp],
    ' · ', h('span', { class: 'mono' }, delivery.attempts), delivery.attempts === 1 ? ' attempt' : ' attempts',
    failure && [' · ', failure],
  ];
}

/** @param {import('../api.js').Api} api */
export function mountMonitorWebhook(api) {
  let configured = false;
  let busy = false;
  const status = h('p', { class: 'field-hint', role: 'status' }, 'Loading webhook settings…');
  const notice = createNotice();
  const url = createField({ label: 'Webhook URL', type: 'password', inputMode: 'url', spellcheck: false, required: true });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save webhook');
  const remove = h('button', { type: 'button', class: 'btn btn-danger', hidden: true, onclick: removeWebhook }, 'Remove webhook');
  const refresh = h('button', { type: 'button', class: 'btn', onclick: () => void update('load') }, 'Refresh status');
  const form = h(
    'form',
    { class: 'stack', hidden: true, novalidate: true, onsubmit: submit },
    url.root,
    h('div', { class: 'form-actions' }, save, remove),
  );
  const root = h(
    'div',
    { class: 'monitor-webhook stack' },
    h('h4', { class: 'card-title-sm' }, 'Webhook notifications'),
    status,
    notice.el,
    form,
    h('div', null, refresh),
  );

  /** @param {Event} event */
  function submit(event) {
    event.preventDefault();
    if (busy) return;
    const value = url.input.value.trim();
    notice.clear();
    url.setError(null);
    if (!/^https:\/\//i.test(value) || !safeUrl(value, { httpsOnly: true })) {
      url.setError('Enter a valid HTTPS URL.');
      url.input.focus();
      return;
    }
    void update('save', value);
  }

  async function removeWebhook() {
    if (busy || !configured) return;
    const confirmed = await confirmDialog({
      title: 'Remove webhook?',
      message: 'Pending deliveries are discarded. Monitoring and incident history stay available.',
      confirmLabel: 'Remove webhook',
      danger: true,
    });
    if (confirmed) void update('remove');
  }

  /** @param {'load' | 'save' | 'remove'} action @param {string} [value] */
  async function update(action, value) {
    if (busy) return;
    busy = true;
    url.input.readOnly = true;
    for (const button of [save, remove, refresh]) {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-busy', 'true');
    }
    if (action !== 'load' || !form.hidden) {
      notice.show('info', { load: 'Refreshing delivery status…', save: 'Saving webhook…', remove: 'Removing webhook…' }[action]);
    }
    let focusUrl = false;
    try {
      /** @type {{configured: boolean, last_delivery: Delivery | null}} */
      const result = action === 'load' ? await api.get(endpoint)
        : action === 'save' ? await api.put(endpoint, { url: value })
          : await api.del(endpoint);
      configured = result.configured;
      form.hidden = false;
      if (action !== 'load') {
        url.input.value = '';
        url.setError(null);
      }
      focusUrl = !configured && document.activeElement === remove;
      remove.hidden = !configured;
      save.textContent = configured ? 'Replace webhook' : 'Save webhook';
      url.setHint(configured
        ? 'Replacing the URL discards pending deliveries.'
        : 'Use HTTPS to receive outage and recovery events.');
      status.replaceChildren(configured ? 'Webhook configured.' : 'No webhook configured.');
      if (configured) status.append(h('span', { class: 'field-hint' }, ' ', result.last_delivery
        ? deliveryText(result.last_delivery)
        : 'No webhook deliveries yet.'));
      if (action === 'load') notice.clear();
      else notice.show('success', action === 'save' ? 'Webhook saved.' : 'Webhook removed.');
    } catch (err) {
      if (form.hidden) status.textContent = 'Webhook status unavailable.';
      notice.show('error', {
        load: 'Could not load webhook status. Refresh to try again.',
        save: 'Could not save the webhook. Refresh status before retrying.',
        remove: 'Could not remove the webhook. Refresh status before retrying.',
      }[action]);
      if (action === 'save' && err instanceof ApiError && Object.hasOwn(err.fields, 'url')) {
        url.setError('Enter an HTTPS URL without credentials or a fragment.');
        focusUrl = true;
      }
    } finally {
      busy = false;
      url.input.readOnly = false;
      for (const button of [save, remove, refresh]) {
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy');
      }
      if (focusUrl) url.input.focus();
    }
  }

  return { root, start: () => void update('load') };
}

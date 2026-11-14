// @ts-check
/**
 * Add / edit / delete a service. Shared by the dashboard and the settings page.
 */

import { h, nextId } from '../dom.js';
import { openDialog, confirmDialog } from '../dialog.js';
import { createField, createSelect, createNotice, createSwitch, showFormError, whileBusy } from '../ui.js';
import { icon, ICON_IDS, ICON_SET, knownIcon } from '../icons.js';
import { CATEGORIES, autoCategorize, resolveCategory, suggestIcon } from '../categorize.js';
import { buildServiceUrl, safeUrl, splitScheme } from '../lib/url.js';
import { toastSuccess, toastError } from '../toast.js';

/** @typedef {import('../types.js').Service} Service */

/**
 * `full` adds the icon picker and the category select (edit). `withCategory`
 * adds just the category select (add with prefilled values). `focusUrl` puts
 * the first focus on the address; `urlHint` replaces that field's hint.
 * @param {{ service?: Service, defaultDomain: string, full: boolean, withCategory?: boolean, focusUrl?: boolean, urlHint?: string }} o
 */
function buildForm(o) {
  const svc = o.service;
  const initial = svc ? splitScheme(svc.url) : { scheme: null, rest: '' };

  const name = createField({ label: 'Name', name: 'name', value: svc ? svc.name : '', placeholder: 'e.g. Grafana', required: true, maxLength: 200, autofocus: !o.focusUrl });
  const scheme = createSelect({
    label: 'Scheme',
    value: initial.scheme || 'https://',
    options: [
      { value: 'https://', label: 'https://' },
      { value: 'http://', label: 'http://' },
    ],
    labelHidden: true,
  });
  const host = createField({
    label: 'Host or address',
    labelHidden: true,
    name: 'url',
    value: svc ? initial.rest : '',
    placeholder: o.defaultDomain ? `grafana  or  grafana.${o.defaultDomain}` : 'e.g. grafana.example.com:3000',
    required: true,
    autocomplete: 'off',
    inputMode: 'url',
    spellcheck: false,
    autofocus: !!o.focusUrl,
    hint: o.urlHint || (o.defaultDomain ? `A name without a dot gets “.${o.defaultDomain}” added.` : undefined),
  });
  // Typing or pasting a full URL moves its scheme into the select.
  host.input.addEventListener('input', () => {
    const s = splitScheme(host.input.value);
    if (s.scheme) {
      scheme.input.value = s.scheme;
      host.input.value = s.rest;
    }
  });
  const desc = createField({ label: 'Description', name: 'description', value: svc ? svc.description : '', placeholder: 'Optional', maxLength: 500 });

  const check = createSwitch({
    label: 'Check status',
    description: 'The server pings this address and shows whether it is online.',
    checked: svc ? svc.check : true,
    onChange: () => {},
  });

  // Category preview / select
  const catSelect = createSelect({
    label: 'Category',
    value: svc && svc.category ? svc.category : 'auto',
    options: [{ value: 'auto', label: 'Auto (detect from name and address)' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))],
  });
  const preview = h('p', { class: 'field-hint category-preview', 'aria-live': 'polite' });
  const currentUrl = () => buildServiceUrl(scheme.input.value, host.input.value, o.defaultDomain);
  const updatePreview = () => {
    const url = currentUrl();
    const chosen = o.full || o.withCategory ? catSelect.input.value : 'auto';
    if (chosen !== 'auto') {
      preview.textContent = '';
      return;
    }
    const auto = autoCategorize(name.input.value, url, desc.input.value);
    preview.textContent = name.input.value.trim() || host.input.value.trim() ? `Will be filed under ${auto.category} (automatic).` : '';
  };
  for (const f of [name, host, desc]) f.input.addEventListener('input', updatePreview);
  scheme.input.addEventListener('change', updatePreview);
  catSelect.input.addEventListener('change', updatePreview);
  updatePreview();

  // Icon picker (edit only): a real radio group.
  let selectedIcon = knownIcon(svc && svc.icon);
  /** @type {HTMLElement | null} */
  let iconPicker = null;
  if (o.full) {
    const groupName = nextId('icon');
    iconPicker = h(
      'fieldset',
      { class: 'icon-picker' },
      h('legend', { class: 'field-label' }, 'Icon'),
      h(
        'div',
        { class: 'icon-grid' },
        ICON_IDS.map((id) => {
          const input = h('input', { type: 'radio', name: groupName, value: id, checked: id === selectedIcon, class: 'sr-only' });
          input.addEventListener('change', () => {
            selectedIcon = id;
          });
          return h('label', { class: 'icon-opt', title: id }, input, icon(id), h('span', { class: 'sr-only' }, id.replace(/-/g, ' ')));
        }),
      ),
    );
  }

  const notice = createNotice();
  const fieldMap = { name, url: host, description: desc, category: catSelect };

  /** @returns {{ values: Record<string, any> | null }} */
  function read() {
    name.setError(null);
    host.setError(null);
    const n = name.input.value.trim();
    const url = currentUrl();
    let ok = true;
    if (!n) {
      name.setError('Enter a name.');
      ok = false;
    }
    if (!host.input.value.trim()) {
      host.setError('Enter the address of the service.');
      ok = false;
    } else if (!safeUrl(url)) {
      host.setError('Enter a valid address, for example grafana.example.com:3000.');
      ok = false;
    }
    if (!ok) {
      (n ? host : name).input.focus();
      return { values: null };
    }
    const category = o.full || o.withCategory ? (catSelect.input.value === 'auto' ? null : catSelect.input.value) : null;
    return {
      values: {
        name: n,
        url,
        description: desc.input.value.trim(),
        category,
        check: check.input.checked,
        ...(o.full ? { icon: selectedIcon } : {}),
      },
    };
  }

  const el = h(
    'div',
    { class: 'dlg-content' },
    notice.el,
    name.root,
    h('fieldset', { class: 'field-wrap field-set' }, h('legend', { class: 'field-label' }, 'Address', h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')), h('div', { class: 'field-row' }, scheme.root, host.root)),
    desc.root,
    o.full || o.withCategory ? catSelect.root : null,
    preview,
    iconPicker,
    check.root,
  );
  return { el, notice, fieldMap, read, name };
}

/**
 * Opens the "add service" dialog. With `prefill` (a Docker suggestion) the
 * fields start with its values, the category can be chosen, and the address is
 * focused when it is empty.
 * @param {{
 *   api: import('../api.js').Api, defaultDomain: string, onSaved: (s: Service) => void,
 *   prefill?: { name: string, url: string, description: string, icon: string, category: string | null, check: boolean, urlHint?: string },
 * }} o
 * @returns {Promise<boolean>} resolves to true when a service was added
 */
export function openAddService(o) {
  const pre = o.prefill;
  const ctrl = openDialog({
    title: 'Add a service',
    build(ctrl) {
      const form = buildForm({
        service: pre ? { id: '', created_at: '', ...pre } : undefined,
        defaultDomain: o.defaultDomain,
        full: false,
        withCategory: !!pre,
        focusUrl: !!pre && !pre.url,
        urlHint: pre && !pre.url ? pre.urlHint : undefined,
      });
      const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add service');
      const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctrl.close() }, 'Cancel');
      return h(
        'form',
        {
          novalidate: true,
          class: 'dlg-form',
          onsubmit: async (/** @type {Event} */ e) => {
            e.preventDefault();
            const { values } = form.read();
            if (!values) return;
            form.notice.clear();
            await whileBusy([submit, cancel], async () => {
              try {
                const auto = autoCategorize(values.name, values.url, values.description);
                const icon = pre && ICON_SET.has(pre.icon) ? pre.icon : suggestIcon(auto.category, values.name);
                const res = await o.api.post('/api/services', { ...values, icon });
                ctrl.close(true);
                o.onSaved(res.service);
                toastSuccess(`Added ${res.service.name}.`);
              } catch (err) {
                showFormError(err, form.fieldMap, form.notice);
              }
            });
          },
        },
        form.el,
        h('div', { class: 'dlg-footer' }, cancel, submit),
      );
    },
  });
  return ctrl.closed.then((v) => v === true);
}

/**
 * Opens the "edit service" dialog.
 * @param {{ api: import('../api.js').Api, service: Service, defaultDomain: string, onSaved: (s: Service) => void, onDeleted?: (id: string) => void }} o
 */
export function openEditService(o) {
  openDialog({
    title: `Edit ${o.service.name}`,
    build(ctrl) {
      const form = buildForm({ service: o.service, defaultDomain: o.defaultDomain, full: true });
      const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes');
      const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctrl.close() }, 'Cancel');
      const del = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-danger dlg-delete',
          onclick: async () => {
            if (await removeService(o.api, o.service)) {
              ctrl.close(true);
              if (o.onDeleted) o.onDeleted(o.service.id);
            }
          },
        },
        'Delete',
      );
      return h(
        'form',
        {
          novalidate: true,
          class: 'dlg-form',
          onsubmit: async (/** @type {Event} */ e) => {
            e.preventDefault();
            const { values } = form.read();
            if (!values) return;
            form.notice.clear();
            await whileBusy([submit, cancel, del], async () => {
              try {
                const res = await o.api.patch('/api/services/' + encodeURIComponent(o.service.id), values);
                ctrl.close(true);
                o.onSaved(res.service);
                toastSuccess('Saved.');
              } catch (err) {
                showFormError(err, form.fieldMap, form.notice);
              }
            });
          },
        },
        form.el,
        h('div', { class: 'dlg-footer dlg-footer-split' }, del, h('div', { class: 'dlg-footer-end' }, cancel, submit)),
      );
    },
  });
}

/**
 * Asks for confirmation, then deletes. Resolves to true when deleted.
 * @param {import('../api.js').Api} api
 * @param {Service} service
 */
export async function removeService(api, service) {
  const yes = await confirmDialog({
    title: 'Delete service?',
    message: `“${service.name}” will be removed from your dashboard. This can't be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!yes) return false;
  try {
    await api.del('/api/services/' + encodeURIComponent(service.id));
    toastSuccess(`Deleted ${service.name}.`);
    return true;
  } catch (err) {
    toastError(err instanceof Error ? err.message : "Couldn't delete the service.");
    return false;
  }
}

export { resolveCategory };

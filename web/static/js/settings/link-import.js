// @ts-check

import { ApiError } from '../api.js';
import { openDialog } from '../dialog.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { toastSuccess } from '../toast.js';
import { whileBusy } from '../ui.js';

const MAX_BYTES = 1024 * 1024;
const labels = { add: 'Add', update: 'Update', unchanged: 'Unchanged', conflict: 'Conflict' };

/** @typedef {{ name: string, url: string, action: keyof typeof labels, reason?: string, fields?: string[], previous_name?: string }} ImportRow */
/** @typedef {{ revision: string, services: ImportRow[], bookmarks: ImportRow[] }} Preview */

/** @param {Preview} preview @param {string} filename */
function showPreview(preview, filename) {
  const counts = { add: 0, update: 0, unchanged: 0, conflict: 0 };
  for (const row of [...preview.services, ...preview.bookmarks]) counts[row.action]++;
  const canApply = !counts.conflict && Boolean(counts.add || counts.update);

  /** @param {string} title @param {ImportRow[]} rows */
  const section = (title, rows) => rows.length ? h('div', { class: 'stack' },
    h('h3', { class: 'field-label' }, title),
    h('ul', { class: 'import-rows' }, ...rows.map((row) => {
      const name = row.previous_name && row.previous_name !== row.name
        ? `${row.previous_name} → ${row.name}`
        : row.name;
      const detail = row.reason || row.fields?.join(', ');
      return h('li', null, h('strong', null, `${labels[row.action]} · ${name}`),
        h('div', { class: 'muted' }, row.url), detail ? h('div', { class: 'muted' }, detail) : null);
    })),
  ) : null;

  return openDialog({
    title: 'Preview link import',
    size: 'lg',
    build: (ctrl) => h('div', { class: 'dlg-content' },
      h('p', { class: 'dlg-message' }, filename),
      h('p', { class: 'dlg-message' }, `${counts.add} to add · ${counts.update} to update · ${counts.unchanged} unchanged · ${counts.conflict} conflicts`),
      counts.conflict ? h('p', { class: 'dlg-message' }, 'Resolve the conflicts in the file or your existing links, then preview again.') : null,
      section('Services', preview.services),
      section('Bookmarks', preview.bookmarks),
      h('div', { class: 'dlg-footer' },
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-autofocus': '', onclick: () => ctrl.close(false) }, canApply ? 'Cancel' : 'Close'),
        canApply ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => ctrl.close(true) }, 'Apply import') : null,
      ),
    ),
  }).closed;
}

/** @param {import('./env.js').Env} env @param {ReturnType<typeof import('../ui.js').createNotice>} notice */
export function linkImportControls(env, notice) {
  const input = /** @type {HTMLInputElement} */ (h('input', {
    type: 'file', accept: '.json,.yaml,.yml', class: 'sr-only', tabindex: '-1',
  }));
  const button = h('button', { type: 'button', class: 'btn', onclick: () => input.click() },
    icon('upload'), h('span', null, 'Import links…'));

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    notice.clear();
    if (file.size > MAX_BYTES) return notice.show('error', 'Import files must be at most 1 MiB.');
    try {
      const format = /\.ya?ml$/i.test(file.name) ? 'yaml' : 'json';
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const body = { format, content };
      const preview = /** @type {Preview} */ (await whileBusy([button], () =>
        env.api.post('/api/import-links', body, { notifyWrite: false })));
      if (!await showPreview(preview, file.name)) return;
      const { services, bookmarks } = await whileBusy([button], () =>
        env.api.post('/api/import-links', { ...body, revision: preview.revision }));
      env.state.set({ services, bookmarks });
      toastSuccess('Links imported.');
    } catch (err) {
      const detail = err instanceof ApiError
        ? Object.entries(err.fields).slice(0, 3).map(([path, message]) => `${path}: ${message}`).join(' · ')
        : '';
      const message = err instanceof ApiError ? err.message : 'Could not read the file. Use UTF-8 text.';
      notice.show('error', detail ? `${message} ${detail}` : message);
    }
  });
  return [button, input];
}

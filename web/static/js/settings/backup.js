// @ts-check
/** Settings: backup export / import (one POST /api/backup) and reset. */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { confirmDialog } from '../dialog.js';
import { createNotice, whileBusy } from '../ui.js';
import { downloadText } from '../lib/clipboard.js';
import { isPlainObject } from '../lib/merge.js';
import { toastSuccess, toastError } from '../toast.js';
import { ApiError } from '../api.js';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Checks that a parsed file looks like a Server Hub backup.
 * @param {unknown} doc
 * @returns {{ ok: true, doc: Record<string, any> } | { ok: false, message: string }}
 */
export function checkBackup(doc) {
  if (!isPlainObject(doc)) return { ok: false, message: 'This file is not a Server Hub backup.' };
  if (!isPlainObject(doc.settings) || !Array.isArray(doc.services) || !Array.isArray(doc.bookmarks)) {
    return { ok: false, message: 'This file is not a Server Hub backup: it needs settings, services and bookmarks.' };
  }
  if (doc.version !== undefined && doc.version !== 1) return { ok: false, message: `This backup uses version ${String(doc.version)}, which this app can't read.` };
  return { ok: true, doc };
}

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountBackup(root, env) {
  const { api } = env;
  const notice = createNotice();
  const exportBtn = h('button', { type: 'button', class: 'btn' }, icon('download'), h('span', null, 'Export backup'));
  const fileInput = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file', tabindex: '-1' }));
  const importBtn = h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, icon('upload'), h('span', null, 'Import backup…'));

  exportBtn.addEventListener('click', async () => {
    notice.clear();
    await whileBusy([exportBtn], async () => {
      try {
        const doc = await api.get('/api/backup');
        const day = new Date().toISOString().slice(0, 10);
        downloadText(`server-hub-backup-${day}.json`, JSON.stringify(doc, null, 2) + '\n', 'application/json');
        toastSuccess('Backup exported.');
      } catch (err) {
        notice.show('error', err instanceof Error ? err.message : "Couldn't export the backup.");
      }
    });
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    notice.clear();
    if (file.size > MAX_BYTES) return notice.show('error', 'That file is too large to be a backup.');
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return notice.show('error', 'This file is not valid JSON.');
    }
    const checked = checkBackup(parsed);
    if (!checked.ok) return notice.show('error', checked.message);
    const { doc } = checked;
    const yes = await confirmDialog({
      title: 'Replace your data with this backup?',
      message: `This replaces your current settings, services and bookmarks with the ${doc.services.length} service${doc.services.length === 1 ? '' : 's'} and ${doc.bookmarks.length} bookmark${doc.bookmarks.length === 1 ? '' : 's'} in “${file.name}”. This can't be undone.`,
      confirmLabel: 'Replace everything',
      danger: true,
    });
    if (!yes) return;
    await whileBusy([importBtn], async () => {
      try {
        const data = await api.post('/api/backup', doc);
        env.applyBootstrap(data);
        toastSuccess('Backup restored.');
      } catch (err) {
        const detail = err instanceof ApiError ? Object.values(err.fields).slice(0, 3).join(' ') : '';
        notice.show('error', (err instanceof Error ? err.message : "Couldn't restore the backup.") + (detail ? ' ' + detail : ''));
      }
    });
  });

  root.append(
    h('p', { class: 'muted panel-intro' }, 'Export your settings, services and bookmarks to a JSON file, or restore them from one. Beszel hubs, passwords and two-factor secrets are never included.'),
    notice.el,
    h('div', { class: 'form-actions' }, exportBtn, importBtn, fileInput),
  );
}

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountReset(root, env) {
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-danger',
      onclick: async () => {
        const yes = await confirmDialog({
          title: 'Reset all settings?',
          message: 'Theme, accent, wallpaper, name, title, features and search go back to their defaults. Your services, bookmarks and hubs are not touched.',
          confirmLabel: 'Reset settings',
          danger: true,
        });
        if (!yes) return;
        await whileBusy([btn], async () => {
          try {
            await env.store.reset();
            toastSuccess('Settings reset to defaults.');
          } catch (err) {
            toastError(err instanceof Error ? err.message : "Couldn't reset the settings.");
          }
        });
      },
    },
    'Reset all settings',
  );
  root.append(h('p', { class: 'muted panel-intro' }, 'Return appearance, personalization, features and search to their defaults. Your services, bookmarks and hubs stay as they are.'), h('div', null, btn));
}

// @ts-check
/** Settings: administration (admin role only): users, registration, and monitoring. */

import { h } from '../dom.js';
import { createField, createSelect, createNotice, createSwitch, showFormError, whileBusy } from '../ui.js';
import { openDialog, confirmDialog } from '../dialog.js';
import { openInputDialog } from '../features/input-dialog.js';
import { icon } from '../icons.js';
import { toastSuccess, toastError } from '../toast.js';
import { mountMonitorWebhook } from './monitor-webhook.js';

/** @typedef {import('../types.js').User & { created_at?: string }} AdminUser */

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountAdmin(root, env) {
  const { api, state } = env;
  /** @type {AdminUser[]} */
  let users = [];
  let started = false;

  const regNote = h('p', { class: 'field-hint', role: 'status' });
  const reg = createSwitch({
    label: 'Allow self-registration',
    description: 'When on, anyone who can reach this server can create an account from the sign-in page.',
    checked: false,
    onChange: async (checked) => {
      reg.input.disabled = true;
      try {
        const res = await api.put('/api/admin/config', { registration_open: checked });
        reg.input.checked = !!res.registration_open;
        regNote.textContent = res.registration_open ? 'Registration is open.' : 'Registration is closed.';
      } catch (err) {
        reg.input.checked = !checked;
        toastError(err instanceof Error ? err.message : "Couldn't change the setting.");
      } finally {
        reg.input.disabled = false;
      }
    },
  });

  const monitorNote = h('p', { class: 'field-hint', role: 'status' }, 'Loading monitoring settings…');
  const monitorRetry = h('button', { type: 'button', class: 'btn btn-sm', hidden: true, onclick: () => void loadMonitoring() }, 'Retry');
  const monitor = createSwitch({
    label: 'Allow background checks',
    description: 'Lets users monitor selected services while the dashboard is closed.',
    checked: false,
    onChange: async (checked) => {
      monitor.input.disabled = true;
      monitorNote.textContent = 'Saving…';
      try {
        const res = await api.put('/api/admin/monitoring', { enabled: checked });
        monitor.input.checked = res.enabled;
        monitorNote.textContent = 'Monitoring settings saved.';
      } catch {
        monitor.input.checked = !checked;
        monitorNote.textContent = "Couldn't save monitoring settings. Try again.";
      } finally {
        monitor.input.disabled = false;
      }
    },
  });
  monitor.root.hidden = true;
  monitor.input.disabled = true;
  const webhook = mountMonitorWebhook(api);

  const list = h('ul', { class: 'list', 'aria-label': 'Users' });
  const loadNote = h('p', { class: 'muted', role: 'status' }, 'Loading users…');
  const addBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openCreate() }, icon('ui-plus'), h('span', null, 'Create user'));
  root.append(
    reg.root,
    regNote,
    h('div', { class: 'stack' },
      h('h3', { class: 'card-title-sm' }, 'Service monitoring'),
      h('div', null, monitor.root, monitorNote, monitorRetry),
      webhook.root,
    ),
    h('h3', { class: 'card-title-sm' }, 'Users'),
    loadNote,
    list,
    h('div', null, addBtn),
  );

  const me = () => state.get().user;

  function replaceUser(/** @type {AdminUser} */ u) {
    users = users.map((x) => (x.id === u.id ? { ...x, ...u } : x));
    render();
  }

  /** @param {AdminUser} u */
  function row(u) {
    const self = me() && me()?.id === u.id;
    const role = createSelect({
      label: `Role of ${u.username}`,
      labelHidden: true,
      value: u.role,
      options: [
        { value: 'user', label: 'User' },
        { value: 'admin', label: 'Admin' },
      ],
    });
    role.input.disabled = !!self;
    if (self) role.input.title = 'You can’t change your own role.';
    role.input.addEventListener('change', async () => {
      const wanted = role.input.value;
      role.input.disabled = true;
      try {
        const res = await api.patch('/api/admin/users/' + encodeURIComponent(u.id), { role: wanted });
        replaceUser(res.user);
        toastSuccess(`${u.username} is now ${wanted === 'admin' ? 'an administrator' : 'a regular user'}.`);
      } catch (err) {
        role.input.value = u.role;
        role.input.disabled = false;
        toastError(err instanceof Error ? err.message : "Couldn't change the role.");
      }
    });

    return h(
      'li',
      { class: 'list-row list-row-user' },
      h('span', { class: 'list-icon' }, icon('user')),
      h('div', { class: 'list-main' }, h('p', { class: 'list-title' }, u.username, self ? h('span', { class: 'pill' }, 'you') : null), h('p', { class: 'list-sub', title: u.email }, u.email)),
      h('div', { class: 'list-meta' }, role.root, h('span', { class: 'pill' + (u.twofa_enabled ? ' pill-ok' : '') }, u.twofa_enabled ? '2FA on' : '2FA off')),
      h(
        'div',
        { class: 'list-actions' },
        u.twofa_enabled
          ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => disableTwofa(u) }, 'Disable 2FA')
          : null,
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => resetPassword(u) }, 'Reset password'),
        h('button', { type: 'button', class: 'btn btn-sm btn-danger', disabled: !!self, title: self ? 'You can’t delete your own account here.' : undefined, 'aria-label': `Delete ${u.username}`, onclick: () => remove(u) }, 'Delete'),
      ),
    );
  }

  function render() {
    list.replaceChildren(...users.map(row));
  }

  /** @param {AdminUser} u */
  async function disableTwofa(u) {
    const yes = await confirmDialog({ title: `Disable 2FA for ${u.username}?`, message: 'They will be able to sign in with just their password until they set it up again.', confirmLabel: 'Disable 2FA', danger: true });
    if (!yes) return;
    try {
      const res = await api.patch('/api/admin/users/' + encodeURIComponent(u.id), { disable_twofa: true });
      replaceUser(res.user);
      toastSuccess('Two-factor authentication disabled.');
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Couldn't disable 2FA.");
    }
  }

  /** @param {AdminUser} u */
  async function resetPassword(u) {
    const ok = await openInputDialog({
      title: `Reset password for ${u.username}`,
      message: 'Choose a new password and share it with them. Their other sessions are signed out.',
      label: 'New password',
      type: 'password',
      autocomplete: 'new-password',
      hint: '10 to 128 characters.',
      maxLength: 128,
      submitLabel: 'Reset password',
      fieldNames: ['password', 'value'],
      validate: (v) => (v.length >= 10 && v.length <= 128 ? null : 'Use 10 to 128 characters.'),
      run: async (password) => {
        await api.patch('/api/admin/users/' + encodeURIComponent(u.id), { password });
      },
    });
    if (ok) toastSuccess(`Password for ${u.username} was reset.`);
  }

  /** @param {AdminUser} u */
  async function remove(u) {
    const yes = await confirmDialog({ title: `Delete ${u.username}?`, message: `Their account, services, bookmarks and settings are removed permanently. This can't be undone.`, confirmLabel: 'Delete user', danger: true });
    if (!yes) return;
    try {
      await api.del('/api/admin/users/' + encodeURIComponent(u.id));
      users = users.filter((x) => x.id !== u.id);
      render();
      toastSuccess(`Deleted ${u.username}.`);
      addBtn.focus();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Couldn't delete the user.");
    }
  }

  function openCreate() {
    openDialog({
      title: 'Create a user',
      build(ctrl) {
        const email = createField({ label: 'Email', name: 'email', type: 'email', required: true, autofocus: true, autocomplete: 'off', spellcheck: false });
        const username = createField({ label: 'Username', name: 'username', required: true, hint: '3–20 characters: letters, numbers or underscore.', maxLength: 20, spellcheck: false });
        const password = createField({ label: 'Password', name: 'password', type: 'password', required: true, autocomplete: 'new-password', hint: '10 to 128 characters.', maxLength: 128 });
        const role = createSelect({ label: 'Role', value: 'user', options: [{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }] });
        const notice = createNotice();
        const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create user');
        const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctrl.close() }, 'Cancel');
        const map = { email, username, password, role };
        return h(
          'form',
          {
            class: 'dlg-content',
            novalidate: true,
            onsubmit: async (/** @type {Event} */ e) => {
              e.preventDefault();
              notice.clear();
              for (const f of Object.values(map)) f.setError(null);
              /** @type {Array<[import('../ui.js').Field, string | null]>} */
              const checks = [
                [email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.input.value.trim()) ? null : 'Enter a valid email address.'],
                [username, /^[a-zA-Z0-9_]{3,20}$/.test(username.input.value.trim()) ? null : 'Use 3–20 letters, numbers or underscores.'],
                [password, password.input.value.length >= 10 && password.input.value.length <= 128 ? null : 'Use 10 to 128 characters.'],
              ];
              const bad = checks.filter(([, m]) => m);
              for (const [f, m] of bad) f.setError(m);
              if (bad.length) return bad[0][0].input.focus();
              await whileBusy([save, cancel], async () => {
                try {
                  const res = await api.post('/api/admin/users', { email: email.input.value.trim(), username: username.input.value.trim(), password: password.input.value, role: role.input.value });
                  users = [...users, res.user];
                  render();
                  ctrl.close(true);
                  toastSuccess(`Created ${res.user.username}.`);
                } catch (err) {
                  showFormError(err, map, notice);
                }
              });
            },
          },
          notice.el,
          email.root,
          username.root,
          password.root,
          role.root,
          h('div', { class: 'dlg-footer' }, cancel, save),
        );
      },
    });
  }

  async function loadMonitoring() {
    if (monitorRetry.getAttribute('aria-disabled') === 'true') return;
    monitorRetry.setAttribute('aria-disabled', 'true');
    monitorNote.textContent = 'Loading monitoring settings…';
    try {
      const res = await api.get('/api/admin/monitoring');
      monitor.input.checked = res.enabled;
      monitor.input.disabled = false;
      monitor.root.hidden = false;
      monitorNote.textContent = '';
      if (document.activeElement === monitorRetry) monitor.input.focus();
      monitorRetry.hidden = true;
    } catch {
      monitorNote.textContent = "Couldn't load monitoring settings.";
      monitorRetry.hidden = false;
    } finally {
      monitorRetry.removeAttribute('aria-disabled');
    }
  }

  async function load() {
    try {
      const [cfg, res] = await Promise.all([api.get('/api/admin/config'), api.get('/api/admin/users')]);
      reg.input.checked = !!cfg.registration_open;
      regNote.textContent = cfg.registration_open ? 'Registration is open.' : 'Registration is closed.';
      users = res.users;
      loadNote.remove();
      render();
    } catch (err) {
      loadNote.textContent = err instanceof Error ? err.message : "Couldn't load users.";
      loadNote.setAttribute('role', 'alert');
    }
  }

  return {
    /** Loads data the first time the section becomes visible. */
    start() {
      if (started) return;
      started = true;
      void load();
      void loadMonitoring();
      webhook.start();
    },
  };
}

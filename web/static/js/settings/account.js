// @ts-check
/** Settings: account (password) and two-factor authentication. */

import { h } from '../dom.js';
import { createField, createNotice, showFormError, whileBusy } from '../ui.js';
import { openDialog } from '../dialog.js';
import { openInputDialog } from '../features/input-dialog.js';
import { svgDataUrl } from '../lib/qr.js';
import { copyText, downloadText } from '../lib/clipboard.js';
import { icon } from '../icons.js';
import { toastSuccess, toastError } from '../toast.js';

/**
 * Shows the 10 recovery codes once. The dialog can only be closed after the
 * user confirms they saved them.
 * @param {string[]} codes
 */
function showRecoveryCodes(codes) {
  const text = codes.join('\n') + '\n';
  return openDialog({
    title: 'Save your recovery codes',
    dismissable: false,
    build(ctrl) {
      const confirm = h('input', { type: 'checkbox', id: 'rc-saved', class: 'check' });
      const done = h('button', { type: 'button', class: 'btn btn-primary', disabled: true, onclick: () => ctrl.close(true) }, 'Done');
      confirm.addEventListener('change', () => {
        /** @type {HTMLButtonElement} */ (done).disabled = !(/** @type {HTMLInputElement} */ (confirm).checked);
      });
      const status = h('p', { class: 'field-hint', role: 'status' });
      return h(
        'div',
        { class: 'dlg-content' },
        h('p', { class: 'dlg-message' }, 'Each code works once if you lose access to your authenticator app. They are shown only now, so store them somewhere safe such as a password manager.'),
        h('ul', { class: 'codes mono', 'aria-label': 'Recovery codes' }, codes.map((c) => h('li', null, c))),
        h(
          'div',
          { class: 'form-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm',
              'data-autofocus': '',
              onclick: async () => {
                status.textContent = (await copyText(text)) ? 'Copied to the clipboard.' : 'Couldn’t copy automatically. Select the codes and copy them by hand.';
              },
            },
            'Copy codes',
          ),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => downloadText('server-hub-recovery-codes.txt', text) }, icon('download'), h('span', null, 'Download .txt')),
        ),
        status,
        h('label', { class: 'check-row', for: 'rc-saved' }, confirm, h('span', null, 'I have saved these codes')),
        h('div', { class: 'dlg-footer' }, done),
      );
    },
  }).closed;
}

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountAccount(root, env) {
  const { api, state } = env;

  // ---- profile line ----
  const who = h('p', { class: 'muted' });

  // ---- password ----
  const current = createField({ label: 'Current password', name: 'current_password', type: 'password', autocomplete: 'current-password', required: true });
  const next = createField({ label: 'New password', name: 'new_password', type: 'password', autocomplete: 'new-password', required: true, hint: '10 to 128 characters.', maxLength: 128 });
  const again = createField({ label: 'Repeat new password', type: 'password', autocomplete: 'new-password', required: true, maxLength: 128 });
  const pwNotice = createNotice();
  const pwSubmit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change password');
  const pwForm = h(
    'form',
    {
      class: 'sub-card glass',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        pwNotice.clear();
        for (const f of [current, next, again]) f.setError(null);
        let ok = true;
        if (!current.input.value) (current.setError('Enter your current password.'), (ok = false));
        if (next.input.value.length < 10 || next.input.value.length > 128) (next.setError('Use 10 to 128 characters.'), (ok = false));
        else if (again.input.value !== next.input.value) (again.setError('The passwords don’t match.'), (ok = false));
        if (!ok) return;
        await whileBusy([pwSubmit], async () => {
          try {
            await api.put('/api/me/password', { current_password: current.input.value, new_password: next.input.value });
            for (const f of [current, next, again]) f.input.value = '';
            pwNotice.show('success', 'Password changed. You were signed out of your other sessions.');
          } catch (err) {
            showFormError(err, { current_password: current, new_password: next }, pwNotice);
          }
        });
      },
    },
    h('h3', { class: 'card-title-sm' }, 'Change password'),
    pwNotice.el,
    h('div', { class: 'field-grid' }, current.root, next.root, again.root),
    h('div', { class: 'form-actions' }, pwSubmit),
  );

  // ---- two-factor ----
  const twofaStatus = h('p', { class: 'muted' });
  const twofaAction = h('div', { class: 'form-actions' });
  const setupHost = h('div');

  function renderTwofa() {
    const user = state.get().user;
    if (!user) return;
    who.textContent = `Signed in as ${user.username} (${user.email}), ${user.role === 'admin' ? 'administrator' : 'user'}.`;
    twofaStatus.textContent = user.twofa_enabled
      ? 'Two-factor authentication is on. Signing in needs a code from your authenticator app.'
      : 'Two-factor authentication is off. Turning it on adds a one-time code from an authenticator app to every sign-in.';
    twofaAction.replaceChildren(
      user.twofa_enabled
        ? h('button', { type: 'button', class: 'btn btn-danger', onclick: disable }, 'Turn off two-factor authentication')
        : h('button', { type: 'button', class: 'btn btn-primary', onclick: startSetup }, 'Set up two-factor authentication'),
    );
  }

  /** @param {boolean} enabled */
  function setTwofa(enabled) {
    const user = state.get().user;
    if (user) state.set({ user: { ...user, twofa_enabled: enabled } });
  }

  async function startSetup() {
    setupHost.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'Preparing…'));
    twofaAction.hidden = true;
    try {
      const res = await api.post('/api/me/2fa/setup');
      const qr = svgDataUrl(res.qr_svg);
      const code = createField({ label: 'Verification code', name: 'code', autocomplete: 'one-time-code', inputMode: 'numeric', required: true, maxLength: 6, hint: 'The 6-digit code your app shows.', autofocus: true, spellcheck: false });
      const notice = createNotice();
      const confirmBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Confirm and turn on');
      const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', onclick: cancelSetup }, 'Cancel');
      const copyStatus = h('span', { class: 'field-hint', role: 'status' });
      const secret = h('code', { class: 'secret mono' }, res.secret);
      setupHost.replaceChildren(
        h(
          'form',
          {
            class: 'sub-card glass',
            novalidate: true,
            onsubmit: async (/** @type {Event} */ e) => {
              e.preventDefault();
              notice.clear();
              code.setError(null);
              const v = code.input.value.replace(/\s+/g, '');
              if (!/^\d{6}$/.test(v)) return code.setError('Enter the 6-digit code.'), code.input.focus();
              await whileBusy([confirmBtn, cancelBtn], async () => {
                try {
                  const out = await api.post('/api/me/2fa/enable', { code: v });
                  setupHost.replaceChildren();
                  twofaAction.hidden = false;
                  setTwofa(true);
                  toastSuccess('Two-factor authentication is on.');
                  await showRecoveryCodes(out.recovery_codes);
                } catch (err) {
                  showFormError(err, { code }, notice);
                }
              });
            },
          },
          h('h3', { class: 'card-title-sm' }, 'Set up two-factor authentication'),
          h('p', { class: 'muted' }, 'Scan the QR code with an authenticator app (such as Aegis, Google Authenticator or 1Password), then enter the code it shows.'),
          h(
            'div',
            { class: 'twofa-grid' },
            qr ? h('img', { class: 'qr', src: qr, alt: 'QR code for your authenticator app', width: 176, height: 176 }) : h('p', { class: 'banner banner-error', role: 'alert' }, 'The QR code could not be shown. Use the key instead.'),
            h(
              'div',
              { class: 'stack' },
              h('div', null, h('p', { class: 'field-label' }, 'Or enter this key by hand'), secret, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-sm', onclick: async () => (copyStatus.textContent = (await copyText(res.secret)) ? 'Key copied.' : 'Couldn’t copy; select the key and copy it by hand.') }, 'Copy key'), copyStatus)),
              notice.el,
              code.root,
            ),
          ),
          h('div', { class: 'form-actions' }, confirmBtn, cancelBtn),
        ),
      );
      code.input.focus();
    } catch (err) {
      setupHost.replaceChildren();
      twofaAction.hidden = false;
      toastError(err instanceof Error ? err.message : "Couldn't start the setup.");
    }
  }

  function cancelSetup() {
    setupHost.replaceChildren();
    twofaAction.hidden = false;
    /** @type {HTMLElement | null} */ (twofaAction.querySelector('button'))?.focus();
  }

  async function disable() {
    const ok = await openInputDialog({
      title: 'Turn off two-factor authentication?',
      message: 'Enter a code from your authenticator app, or one of your recovery codes, to confirm.',
      label: 'Code',
      autocomplete: 'one-time-code',
      inputMode: 'text',
      submitLabel: 'Turn off',
      danger: true,
      fieldNames: ['code', 'value'],
      run: async (code) => {
        await api.post('/api/me/2fa/disable', { code: code.replace(/\s+/g, '') });
      },
    });
    if (ok) {
      setTwofa(false);
      toastSuccess('Two-factor authentication is off.');
    }
  }

  root.append(
    who,
    pwForm,
    h('div', { class: 'stack' }, h('h3', { class: 'card-title-sm' }, 'Two-factor authentication'), twofaStatus, twofaAction, setupHost),
  );
  state.subscribe((s, prev) => {
    if (s.user !== prev.user) renderTwofa();
  });
  renderTwofa();
}

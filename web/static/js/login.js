// @ts-check
/**
 * Entry module of the login page (/login): sign in, two-factor step (code or
 * recovery code), first-run setup of the admin account, and sign up when the
 * administrator allows it.
 */

import { api } from './client.js';
import { ApiError } from './api.js';
import { h, byId } from './dom.js';
import { createField, createNotice, showFormError, whileBusy } from './ui.js';
import { applyTheme, watchSystemTheme } from './theme.js';
import { storage, readJson, UI_KEY } from './storage.js';

const root = byId('auth-root');

// Same look as the app: use the theme saved on this device.
{
  const paint = () => {
    const ui = readJson(storage, UI_KEY) || {};
    applyTheme(ui.theme || 'auto', ui.accent || '#5E6AD2');
  };
  paint();
  watchSystemTheme(paint);
}

const params = new URLSearchParams(location.search);
let pendingMessage = '';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

/**
 * @typedef {{ setup_required: boolean, registration_open: boolean, authenticated: boolean }} AuthState
 */

/** Leaves the login page. */
function done() {
  location.assign('/');
}

/**
 * @param {string} title
 * @param {string} [sub]
 */
function heading(title, sub) {
  return [h('h2', { class: 'auth-title', id: 'auth-title', tabindex: '-1' }, title), sub ? h('p', { class: 'auth-sub' }, sub) : null];
}

/** @param {Node[]} nodes */
function show(...nodes) {
  root.replaceChildren(...nodes);
  const title = root.querySelector('#auth-title');
  if (title instanceof HTMLElement) document.title = title.textContent + ' · Server Hub';
  const first = root.querySelector('[data-autofocus]');
  if (first instanceof HTMLElement) first.focus();
}

/**
 * Builds a form with a busy submit button.
 * @param {{ submitLabel: string, busyLabel: string, fields: import('./ui.js').Field[], extra?: Node[], map: Record<string, import('./ui.js').Field>, notice: ReturnType<typeof createNotice>, run: () => Promise<void>, validate?: () => boolean }} o
 */
function form(o) {
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, o.submitLabel);
  const el = h(
    'form',
    {
      class: 'auth-form',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        o.notice.clear();
        for (const f of o.fields) f.setError(null);
        if (o.validate && !o.validate()) return;
        submit.textContent = o.busyLabel;
        await whileBusy([submit], async () => {
          try {
            await o.run();
          } catch (err) {
            showFormError(err, o.map, o.notice);
          }
        });
        submit.textContent = o.submitLabel;
      },
    },
    o.notice.el,
    ...o.fields.map((f) => f.root),
    submit,
    ...(o.extra || []),
  );
  return el;
}

// ---------- views ----------

/** @param {AuthState} state */
function viewSignIn(state) {
  const notice = createNotice();
  if (pendingMessage) notice.show('info', pendingMessage);
  else if (params.get('expired') === '1') notice.show('info', 'Your session has expired. Please sign in again.');
  const identifier = createField({ label: 'Username or email', name: 'identifier', autocomplete: 'username', required: true, autofocus: true, spellcheck: false, enterKeyHint: 'next' });
  const password = createField({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, enterKeyHint: 'go' });
  const f = form({
    submitLabel: 'Sign in',
    busyLabel: 'Signing in…',
    fields: [identifier, password],
    map: { identifier, password },
    notice,
    validate: () => {
      let ok = true;
      if (!identifier.input.value.trim()) (identifier.setError('Enter your username or email.'), (ok = false));
      if (!password.input.value) (password.setError('Enter your password.'), (ok = false));
      if (!ok) (identifier.input.value.trim() ? password : identifier).input.focus();
      return ok;
    },
    run: async () => {
      const res = await api.post('/api/auth/login', { identifier: identifier.input.value.trim(), password: password.input.value }, { silent401: true });
      if (res && res.twofa_required) showTwoFactor(state);
      else done();
    },
  });
  return f;
}

function viewSignUp() {
  const notice = createNotice();
  const email = createField({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true, autofocus: true, spellcheck: false });
  const username = createField({ label: 'Username', name: 'username', autocomplete: 'username', required: true, hint: '3–20 characters: letters, numbers or underscore.', maxLength: 20, spellcheck: false });
  const password = createField({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 10 characters.', maxLength: 128 });
  return accountForm({ endpoint: '/api/auth/register', label: 'Create account', busy: 'Creating account…', email, username, password, notice });
}

/**
 * Shared by first-run setup and sign up.
 * @param {{ token?: import('./ui.js').Field, endpoint: string, label: string, busy: string, email: import('./ui.js').Field, username: import('./ui.js').Field, password: import('./ui.js').Field, notice: ReturnType<typeof createNotice> }} o
 */
function accountForm(o) {
  const token = o.token || null;
  const confirm = createField({ label: 'Confirm password', name: 'confirm', type: 'password', autocomplete: 'new-password', required: true, maxLength: 128 });
  return form({
    submitLabel: o.label,
    busyLabel: o.busy,
    fields: [...(token ? [token] : []), o.email, o.username, o.password, confirm],
    map: { email: o.email, username: o.username, password: o.password, ...(token ? { setup_token: token } : {}) },
    notice: o.notice,
    validate: () => {
      /** @type {Array<[import('./ui.js').Field, string | null]>} */
      const checks = [
        [o.email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email.input.value.trim()) ? null : 'Enter a valid email address.'],
        [o.username, USERNAME_RE.test(o.username.input.value.trim()) ? null : 'Use 3–20 letters, numbers or underscores.'],
        [o.password, o.password.input.value.length >= 10 && o.password.input.value.length <= 128 ? null : 'Use 10 to 128 characters.'],
        [confirm, confirm.input.value === o.password.input.value ? null : 'The passwords don’t match.'],
      ];
      if (token) checks.unshift([token, token.input.value.trim() ? null : 'Enter the setup token.']);
      const bad = checks.filter(([, msg]) => msg);
      for (const [field, msg] of bad) field.setError(msg);
      if (bad.length) bad[0][0].input.focus();
      return bad.length === 0;
    },
    run: async () => {
      /** @type {Record<string, string>} */
      const body = { email: o.email.input.value.trim(), username: o.username.input.value.trim(), password: o.password.input.value };
      if (token) body.setup_token = token.input.value.trim();
      try {
        await api.post(o.endpoint, body, { silent401: true });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'invalid_setup_token') {
          throw new ApiError({ status: err.status, code: err.code, message: 'The setup token is not correct.', fields: { setup_token: 'This token is not correct. Check the server log.' } });
        }
        throw err;
      }
      done();
    },
  });
}

/** @param {AuthState} state */
function showTwoFactor(state) {
  let recovery = false;
  const notice = createNotice();
  const code = createField({ label: 'Authenticator code', name: 'code', autocomplete: 'one-time-code', inputMode: 'numeric', required: true, autofocus: true, maxLength: 7, spellcheck: false, hint: 'Enter the 6-digit code from your authenticator app.' });
  const toggle = h('button', { type: 'button', class: 'link-btn' }, 'Use a recovery code instead');
  const back = h('button', { type: 'button', class: 'link-btn', onclick: () => showSignIn(state) }, 'Back to sign in');

  const label = code.root.querySelector('label');
  toggle.addEventListener('click', () => {
    recovery = !recovery;
    if (label) label.textContent = recovery ? 'Recovery code' : 'Authenticator code';
    code.setHint(recovery ? 'Enter one of your saved recovery codes. Each code works once.' : 'Enter the 6-digit code from your authenticator app.');
    code.input.setAttribute('inputmode', recovery ? 'text' : 'numeric');
    code.input.setAttribute('maxlength', recovery ? '32' : '7');
    code.input.setAttribute('autocomplete', recovery ? 'off' : 'one-time-code');
    toggle.textContent = recovery ? 'Use an authenticator code instead' : 'Use a recovery code instead';
    code.input.value = '';
    code.setError(null);
    code.input.focus();
  });

  const f = form({
    submitLabel: 'Verify',
    busyLabel: 'Verifying…',
    fields: [code],
    map: { code },
    notice,
    validate: () => {
      if (!code.input.value.trim()) {
        code.setError(recovery ? 'Enter a recovery code.' : 'Enter the 6-digit code.');
        code.input.focus();
        return false;
      }
      return true;
    },
    run: async () => {
      try {
        await api.post('/api/auth/2fa', { code: code.input.value.replace(/\s+/g, '') }, { silent401: true });
      } catch (err) {
        if (err && err.code === 'login_expired') {
          showSignIn(state, 'Your sign-in timed out. Please enter your password again.');
          return;
        }
        throw err;
      }
      done();
    },
    extra: [h('div', { class: 'auth-links' }, toggle, back)],
  });
  show(...heading('Two-factor authentication', 'Confirm it’s you to finish signing in.'), f);
}

/**
 * @param {AuthState} state
 * @param {string} [message] shown above the form
 */
function showSignIn(state, message) {
  pendingMessage = message || '';
  if (!state.registration_open) {
    show(...heading('Welcome back', 'Sign in to your Server Hub.'), viewSignIn(state));
    return;
  }
  showTabs(state, 'signin');
}

/**
 * Sign in / create account tabs (only when registration is open).
 * @param {AuthState} state
 * @param {'signin' | 'signup'} active
 */
function showTabs(state, active) {
  const tabs = /** @type {const} */ ([
    { id: 'signin', label: 'Sign in', title: 'Welcome back', sub: 'Sign in to your Server Hub.' },
    { id: 'signup', label: 'Create account', title: 'Create your account', sub: 'Registration is open on this server.' },
  ]);
  const buttons = tabs.map((t) =>
    h('button', {
      type: 'button',
      class: 'tab',
      role: 'tab',
      id: 'tab-' + t.id,
      'aria-selected': String(t.id === active),
      'aria-controls': 'tabpanel',
      tabindex: t.id === active ? '0' : '-1',
      onclick: () => showTabs(state, t.id),
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const i = tabs.findIndex((x) => x.id === active);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        showTabs(state, tabs[next].id);
        byId('tab-' + tabs[next].id).focus();
      },
    }, t.label),
  );
  const cur = tabs.find((t) => t.id === active) || tabs[0];
  const panel = h('div', { class: 'tabpanel', role: 'tabpanel', id: 'tabpanel', 'aria-labelledby': 'tab-' + active }, active === 'signin' ? viewSignIn(state) : viewSignUp());
  show(...heading(cur.title, cur.sub), h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Sign in or create an account' }, ...buttons), panel);
}

function showSetup() {
  const notice = createNotice();
  const email = createField({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true, spellcheck: false });
  const username = createField({ label: 'Username', name: 'username', autocomplete: 'username', required: true, hint: '3–20 characters: letters, numbers or underscore.', maxLength: 20, spellcheck: false });
  const password = createField({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 10 characters.', maxLength: 128 });
  const token = createField({ label: 'Setup token', name: 'setup_token', autocomplete: 'off', required: true, autofocus: true, spellcheck: false, hint: 'Printed in the server log on first start (docker compose logs server-hub), or set with SERVERHUB_SETUP_TOKEN.' });
  show(
    ...heading('Welcome to Server Hub', 'Create the administrator account to get started. You can add more people later.'),
    accountForm({ token, endpoint: '/api/auth/setup', label: 'Create admin account', busy: 'Creating account…', email, username, password, notice }),
  );
}

/** @param {string} message */
function showError(message) {
  show(
    h('div', { class: 'banner banner-error', role: 'alert' }, message),
    h('button', { type: 'button', class: 'btn', onclick: () => void start() }, 'Try again'),
  );
}

async function start() {
  show(h('p', { class: 'muted auth-loading', role: 'status' }, 'Loading…'));
  /** @type {AuthState} */
  let state;
  try {
    state = await api.get('/api/auth/state', { silent401: true });
  } catch (err) {
    showError(err instanceof Error ? err.message : "Can't reach the server.");
    return;
  }
  if (state.authenticated && params.get('expired') !== '1') {
    done();
    return;
  }
  if (state.setup_required) showSetup();
  else showSignIn(state);
}

await start();

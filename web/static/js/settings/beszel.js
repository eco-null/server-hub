// @ts-check
/** Settings: Beszel hubs (any number), each saved explicitly and testable. */

import { h } from '../dom.js';
import { createField, createNotice, showFormError, whileBusy } from '../ui.js';
import { confirmDialog } from '../dialog.js';
import { icon } from '../icons.js';
import { withScheme, stripTrailingSlashes, beszelUrlProblem } from '../lib/url.js';
import { toastSuccess, toastError } from '../toast.js';

/** @typedef {import('../types.js').BeszelInstance} Instance */

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountBeszel(root, env) {
  const { api } = env;
  const list = h('div', { class: 'stack' });
  const empty = h('p', { class: 'muted' }, 'No hubs yet. Add a Beszel hub to see CPU, memory and disk usage of your servers on the dashboard.');
  const loadNote = h('p', { class: 'muted', role: 'status' }, 'Loading…');
  const addBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => addDraft() }, icon('ui-plus'), h('span', null, 'Add Beszel hub'));
  root.append(h('p', { class: 'muted panel-intro' }, 'Connect one or more Beszel hubs. Passwords are stored on the server and never shown again.'), loadNote, list, empty, h('div', null, addBtn));
  empty.hidden = true;

  function refreshEmpty() {
    empty.hidden = list.children.length > 0;
  }

  /**
   * One hub as an editable card. `instance` is null for a not-yet-saved draft.
   * @param {Instance | null} instance
   */
  function card(instance) {
    /** @type {Instance | null} */
    let saved = instance;
    const title = h('h3', { class: 'card-title-sm' }, saved ? saved.name || saved.url : 'New hub');
    const name = createField({ label: 'Name', value: saved ? saved.name : '', placeholder: 'Optional, e.g. Home lab', maxLength: 100 });
    const url = createField({ label: 'Hub address', value: saved ? saved.url : '', placeholder: 'https://beszel.example.com', required: true, inputMode: 'url', spellcheck: false });
    const user = createField({ label: 'Username', value: saved ? saved.username : '', required: true, autocomplete: 'off', spellcheck: false });
    const pass = createField({ label: 'Password', type: 'password', autocomplete: 'new-password', required: !saved, hint: saved && saved.has_password ? 'A password is saved. Leave blank to keep it.' : undefined });
    const result = createNotice();
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Save');
    const testBtn = h('button', { type: 'button', class: 'btn btn-sm' }, 'Test connection');
    const delBtn = h('button', { type: 'button', class: 'btn btn-danger btn-sm' }, saved ? 'Remove' : 'Cancel');
    const map = { name, url, username: user, password: pass };

    /** @returns {{ name: string, url: string, username: string, password: string } | null} */
    function read() {
      for (const f of Object.values(map)) f.setError(null);
      const u = withScheme(url.input.value);
      let ok = true;
      const problem = beszelUrlProblem(u);
      if (problem) (url.setError(problem), (ok = false));
      if (!user.input.value.trim()) (user.setError('Enter the username.'), (ok = false));
      if (!saved && !pass.input.value) (pass.setError('Enter the password.'), (ok = false));
      if (!ok) return null;
      return { name: name.input.value.trim(), url: u, username: user.input.value.trim(), password: pass.input.value };
    }

    const el = h(
      'form',
      {
        class: 'sub-card glass',
        novalidate: true,
        onsubmit: async (/** @type {Event} */ e) => {
          e.preventDefault();
          result.clear();
          const v = read();
          if (!v) return;
          await whileBusy([saveBtn, testBtn, delBtn], async () => {
            try {
              /** @type {Record<string, any>} */
              const body = { name: v.name, url: v.url, username: v.username };
              if (v.password) body.password = v.password;
              const res = saved ? await api.patch('/api/beszel/instances/' + encodeURIComponent(saved.id), body) : await api.post('/api/beszel/instances', { ...body, password: v.password });
              saved = res.instance;
              title.textContent = saved.name || saved.url;
              pass.input.value = '';
              pass.setHint('A password is saved. Leave blank to keep it.');
              delBtn.textContent = 'Remove';
              toastSuccess('Hub saved.');
            } catch (err) {
              showFormError(err, map, result);
            }
          });
        },
      },
      h('div', { class: 'sub-card-head' }, title),
      h('div', { class: 'field-grid field-grid-2' }, name.root, url.root, user.root, pass.root),
      result.el,
      h('div', { class: 'form-actions' }, saveBtn, testBtn, delBtn),
    );

    testBtn.addEventListener('click', async () => {
      result.clear();
      for (const f of Object.values(map)) f.setError(null);
      /** @type {Record<string, any>} */
      let body;
      const u = withScheme(url.input.value);
      const unchanged = saved && !pass.input.value && stripTrailingSlashes(u) === stripTrailingSlashes(saved.url) && user.input.value.trim() === saved.username;
      if (unchanged && saved) body = { instance_id: saved.id };
      else {
        const problem = beszelUrlProblem(u);
        if (problem) return url.setError(problem), url.input.focus();
        if (!user.input.value.trim()) return user.setError('Enter the username.'), user.input.focus();
        if (!pass.input.value) return pass.setError('Enter the password to test the changed details.'), pass.input.focus();
        body = { url: u, username: user.input.value.trim(), password: pass.input.value };
      }
      await whileBusy([saveBtn, testBtn, delBtn], async () => {
        result.show('info', 'Testing…');
        try {
          const res = await api.post('/api/beszel/test', body);
          if (res.ok) result.show('success', res.name ? `Connected to “${res.name}”.` : 'Connected.');
          else result.show('error', 'Connection failed' + (res.error ? `: ${res.error}` : '.'));
        } catch (err) {
          showFormError(err, map, result);
        }
      });
    });

    delBtn.addEventListener('click', async () => {
      if (!saved) {
        el.remove();
        refreshEmpty();
        addBtn.focus();
        return;
      }
      const yes = await confirmDialog({ title: 'Remove this hub?', message: `“${saved.name || saved.url}” will no longer appear on your dashboard.`, confirmLabel: 'Remove', danger: true });
      if (!yes) return;
      try {
        await api.del('/api/beszel/instances/' + encodeURIComponent(saved.id));
        el.remove();
        refreshEmpty();
        addBtn.focus();
        toastSuccess('Hub removed.');
      } catch (err) {
        toastError(err instanceof Error ? err.message : "Couldn't remove the hub.");
      }
    });

    return { el, url };
  }

  function addDraft() {
    const c = card(null);
    list.appendChild(c.el);
    refreshEmpty();
    c.url.input.focus();
  }

  (async () => {
    try {
      const res = await api.get('/api/beszel/instances');
      for (const inst of res.instances) list.appendChild(card(inst).el);
      loadNote.remove();
    } catch (err) {
      loadNote.textContent = err instanceof Error ? err.message : "Couldn't load your hubs.";
      loadNote.setAttribute('role', 'alert');
    }
    refreshEmpty();
  })();
}

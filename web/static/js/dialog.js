// @ts-check
/**
 * The one dialog component used by every modal (forms, confirmations,
 * prompts, the search palette). Built on the native <dialog> modal, which
 * makes the rest of the page inert and handles Esc and the top layer; this
 * module adds the pieces the platform leaves out: a labelled shell, initial
 * focus, a Tab trap, focus restore, backdrop click and scroll locking.
 */

import { h, nextId } from './dom.js';
import { icon } from './icons.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openCount = 0;

/** True while any modal dialog is open. */
export function isModalOpen() {
  return document.querySelector('dialog[open]') !== null;
}

/**
 * @typedef {{
 *   el: HTMLDialogElement,
 *   body: HTMLElement,
 *   closed: Promise<any>,
 *   close(value?: any): void,
 *   setBusy(busy: boolean): void,
 * }} DialogController
 */

/**
 * Opens a modal dialog.
 * @param {{
 *   title: string,
 *   build: (ctrl: DialogController) => Node,
 *   size?: 'sm' | 'md' | 'lg',
 *   className?: string,
 *   dismissable?: boolean,
 *   bare?: boolean,
 *   ariaLabel?: string,
 * }} o `bare` omits the header (used by the search palette; then `ariaLabel` labels it).
 * @returns {DialogController}
 */
export function openDialog(o) {
  const opener = /** @type {HTMLElement | null} */ (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const titleId = nextId('dlg-title');
  const dismissable = o.dismissable !== false;

  const dlg = /** @type {HTMLDialogElement} */ (h('dialog', {
    class: `dlg dlg-${o.size || 'md'} ${o.className || ''}`.trim(),
    'aria-labelledby': o.bare ? undefined : titleId,
    'aria-label': o.bare ? o.ariaLabel || o.title : undefined,
  }));
  const body = h('div', { class: 'dlg-body' });
  const panel = h('div', { class: 'dlg-panel', tabindex: '-1' });
  let closeBtn = null;
  if (!o.bare) {
    closeBtn = h('button', { type: 'button', class: 'icon-btn dlg-close', 'aria-label': 'Close dialog', onclick: () => ctrl.close(undefined) }, icon('ui-close'));
    panel.appendChild(h('div', { class: 'dlg-header' }, h('h2', { id: titleId, class: 'dlg-title' }, o.title), dismissable ? closeBtn : null));
  }
  panel.appendChild(body);
  dlg.appendChild(panel);

  /** @type {(v: any) => void} */
  let resolve = () => {};
  /** @type {Promise<any>} */
  const closed = new Promise((r) => {
    resolve = r;
  });
  let done = false;

  /** @type {DialogController} */
  const ctrl = {
    el: dlg,
    body,
    closed,
    close(value) {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) document.documentElement.classList.remove('dlg-open');
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
      resolve(value);
    },
    setBusy(busy) {
      panel.setAttribute('aria-busy', String(busy));
      dlg.classList.toggle('is-busy', busy);
    },
  };

  body.appendChild(o.build(ctrl));
  document.body.appendChild(dlg);
  dlg.showModal();
  openCount += 1;
  document.documentElement.classList.add('dlg-open');

  // Esc fires `cancel`; route it through our close so focus is restored.
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dismissable) ctrl.close(undefined);
  });

  // Backdrop click: only when the press also started on the backdrop.
  let pressedBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => {
    pressedBackdrop = e.target === dlg;
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && pressedBackdrop && dismissable) ctrl.close(undefined);
    pressedBackdrop = false;
  });

  // Keep Tab inside the dialog.
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll(FOCUSABLE)]).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel || active === dlg)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Initial focus: explicit marker, else first control in the body, else the close button.
  const target =
    /** @type {HTMLElement | null} */ (body.querySelector('[data-autofocus]')) ||
    /** @type {HTMLElement | null} */ (body.querySelector(FOCUSABLE)) ||
    closeBtn ||
    panel;
  target.focus({ preventScroll: true });
  if (target instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(target.type)) target.select();

  return ctrl;
}

/**
 * Confirmation dialog replacing window.confirm.
 * @param {{ title: string, message: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} o
 * @returns {Promise<boolean>}
 */
export function confirmDialog(o) {
  const ctrl = openDialog({
    title: o.title,
    size: 'sm',
    build(c) {
      const msgId = nextId('dlg-msg');
      c.el.setAttribute('aria-describedby', msgId);
      return h(
        'div',
        { class: 'dlg-content' },
        h('p', { id: msgId, class: 'dlg-message' }, o.message),
        h(
          'div',
          { class: 'dlg-footer' },
          h('button', { type: 'button', class: 'btn btn-ghost', 'data-autofocus': o.danger ? '' : undefined, onclick: () => c.close(false) }, o.cancelLabel || 'Cancel'),
          h('button', { type: 'button', class: 'btn ' + (o.danger ? 'btn-danger-solid' : 'btn-primary'), 'data-autofocus': o.danger ? undefined : '', onclick: () => c.close(true) }, o.confirmLabel || 'Confirm'),
        ),
      );
    },
  });
  return ctrl.closed.then((v) => v === true);
}

/**
 * Text prompt replacing window.prompt. Resolves to the entered string, or
 * null when cancelled. `validate` may return an error message.
 * @param {{
 *   title: string, label: string, message?: string, type?: string, confirmLabel?: string,
 *   inputMode?: string, autocomplete?: string, placeholder?: string, hint?: string,
 *   validate?: (value: string) => string | null | undefined,
 * }} o
 * @returns {Promise<string | null>}
 */
export function promptDialog(o) {
  const ctrl = openDialog({
    title: o.title,
    size: 'sm',
    build(c) {
      const id = nextId('prompt');
      const input = h('input', {
        id,
        class: 'field',
        type: o.type || 'text',
        autocomplete: o.autocomplete || 'off',
        inputmode: o.inputMode,
        placeholder: o.placeholder,
        'data-autofocus': '',
        'aria-describedby': id + '-e' + (o.hint ? ' ' + id + '-h' : ''),
      });
      const err = h('p', { class: 'field-error', id: id + '-e', role: 'alert', hidden: true });
      const form = h(
        'form',
        {
          class: 'dlg-content',
          novalidate: true,
          onsubmit: (/** @type {Event} */ e) => {
            e.preventDefault();
            const value = /** @type {HTMLInputElement} */ (input).value.trim();
            const problem = o.validate ? o.validate(value) : value ? null : 'This field is required.';
            if (problem) {
              err.hidden = false;
              err.textContent = problem;
              input.setAttribute('aria-invalid', 'true');
              input.focus();
              return;
            }
            c.close(value);
          },
        },
        o.message ? h('p', { class: 'dlg-message' }, o.message) : null,
        h('label', { class: 'field-label', for: id }, o.label),
        input,
        o.hint ? h('p', { class: 'field-hint', id: id + '-h' }, o.hint) : null,
        err,
        h(
          'div',
          { class: 'dlg-footer' },
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => c.close(null) }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, o.confirmLabel || 'Continue'),
        ),
      );
      return form;
    },
  });
  return ctrl.closed.then((v) => (typeof v === 'string' ? v : null));
}

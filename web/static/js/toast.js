// @ts-check
/**
 * Transient notifications. The container is a manual popover so it renders in
 * the top layer, above open modal dialogs.
 */

import { h } from './dom.js';

/** @type {HTMLElement | null} */
let host = null;
const MAX_VISIBLE = 3;

function ensureHost() {
  if (host && host.isConnected) return host;
  host = h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications' });
  if ('popover' in HTMLElement.prototype) host.setAttribute('popover', 'manual');
  document.body.appendChild(host);
  return host;
}

function bringToFront() {
  const el = /** @type {any} */ (host);
  if (el && typeof el.showPopover === 'function') {
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      el.showPopover();
    } catch {
      /* popover not supported: plain fixed positioning still works */
    }
  }
}

/**
 * Shows a toast.
 * @param {string} message
 * @param {{ kind?: 'info' | 'success' | 'error', duration?: number }} [opts]
 */
export function toast(message, opts = {}) {
  const kind = opts.kind || 'info';
  const root = ensureHost();
  const el = h('div', { class: 'toast toast-' + kind, role: kind === 'error' ? 'alert' : 'status' }, message);
  root.appendChild(el);
  while (root.children.length > MAX_VISIBLE) root.firstElementChild?.remove();
  bringToFront();
  const ms = opts.duration ?? (kind === 'error' ? 6000 : 3000);
  setTimeout(() => {
    el.remove();
    if (!root.children.length) {
      try {
        /** @type {any} */ (root).hidePopover?.();
      } catch {
        /* ignore */
      }
    }
  }, ms);
}

/** @param {string} message */
export const toastError = (message) => toast(message, { kind: 'error' });
/** @param {string} message */
export const toastSuccess = (message) => toast(message, { kind: 'success' });

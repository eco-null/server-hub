// @ts-check
/**
 * Tiny DOM helpers. All dynamic content goes through createElement and
 * textContent; HTML is never built from strings.
 */

import { safeUrl } from './lib/url.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'use', 'path', 'circle', 'rect', 'g', 'symbol']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);
const PROP_ATTRS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'indeterminate', 'readOnly', 'required', 'multiple']);

/**
 * True for values that are safe in an href/src: same-site paths, fragments
 * and absolute http(s)/data:image URLs created by us.
 * @param {string} v
 */
function isSafeHref(v) {
  if (v.startsWith('#') || (v.startsWith('/') && !v.startsWith('//'))) return true;
  if (/^data:image\/(svg\+xml|png);/.test(v)) return true;
  return safeUrl(v) !== null;
}

/**
 * @typedef {string | number | boolean | null | undefined | Node | Child[]} Child
 */

/**
 * Creates an element.
 *   h('a', { class: 'x', href: url, onclick: fn, dataset: { id }, style: { '--pct': '40%' } }, 'text', child)
 * `on<event>` functions become listeners, `style` is applied through the CSSOM
 * (allowed under CSP), `false`/`null` attributes are skipped, URL attributes
 * are validated.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...Child} children
 * @returns {HTMLElement & SVGElement}
 */
export function h(tag, props, ...children) {
  const el = /** @type {any} */ (SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag));
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === 'class' || key === 'className') el.setAttribute('class', String(val));
      else if (key === 'text') el.textContent = String(val);
      else if (key === 'dataset') for (const [dk, dv] of Object.entries(val)) el.dataset[dk] = String(dv);
      else if (key === 'style') for (const [sk, sv] of Object.entries(val)) el.style.setProperty(sk, String(sv));
      else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
      else if (PROP_ATTRS.has(key)) el[key] = val;
      else if (URL_ATTRS.has(key)) {
        const s = String(val);
        if (isSafeHref(s)) el.setAttribute(key, s);
      } else if (val === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(val));
    }
  }
  append(el, children);
  return el;
}

/**
 * @param {Node} parent
 * @param {Child[]} children
 */
export function append(parent, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Replaces all children of `parent`.
 * @param {Node} parent
 * @param {...Child} children
 */
export function render(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
}

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
export function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing element #' + id);
  return /** @type {T} */ (el);
}

let uid = 0;
/** Unique id for label/aria wiring. @param {string} [prefix] */
export function nextId(prefix = 'id') {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Delays calls until `ms` have passed without another one.
 * @template {(...a: any[]) => void} F
 * @param {F} fn
 * @param {number} ms
 * @returns {F}
 */
export function debounce(fn, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  return /** @type {any} */ ((/** @type {any[]} */ ...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  });
}

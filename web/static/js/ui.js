// @ts-check
/** Small shared form/feedback components. */

import { h, nextId } from './dom.js';
import { ApiError } from './api.js';
import { fieldMessage } from './lib/format.js';

/**
 * @typedef {{
 *   root: HTMLElement, input: any, id: string,
 *   setError(msg: string | null | undefined): void, setHint(msg: string): void,
 * }} Field
 */

/**
 * A labelled form control with optional hint and inline error. The label is a
 * real <label for>, the hint/error are wired through aria-describedby.
 * @param {{
 *   label: string, name?: string, type?: string, value?: string, hint?: string, placeholder?: string,
 *   required?: boolean, autocomplete?: string, inputMode?: string, maxLength?: number, minLength?: number,
 *   pattern?: string, control?: HTMLElement, className?: string, autofocus?: boolean, spellcheck?: boolean,
 *   labelHidden?: boolean, readOnly?: boolean,
 * }} o
 * @returns {Field}
 */
export function createField(o) {
  const id = nextId('f');
  const hintId = id + '-hint';
  const errId = id + '-err';
  const input =
    o.control ||
    h('input', {
      type: o.type || 'text',
      value: o.value ?? '',
      placeholder: o.placeholder,
      autocomplete: o.autocomplete ?? 'off',
      inputmode: o.inputMode,
      maxlength: o.maxLength,
      minlength: o.minLength,
      pattern: o.pattern,
      spellcheck: o.spellcheck === undefined ? undefined : String(o.spellcheck),
      readOnly: o.readOnly,
      'data-autofocus': o.autofocus,
    });
  input.id = id;
  if (o.name) input.setAttribute('name', o.name);
  if (o.required) input.setAttribute('aria-required', 'true');
  if (!input.classList.contains('field')) input.classList.add('field');

  const hint = h('p', { class: 'field-hint', id: hintId, hidden: !o.hint, text: o.hint || '' });
  const err = h('p', { class: 'field-error', id: errId, hidden: true });
  const describe = () => {
    const ids = [];
    if (!hint.hidden) ids.push(hintId);
    if (!err.hidden) ids.push(errId);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
  };
  describe();

  const root = h(
    'div',
    { class: 'field-wrap' + (o.className ? ' ' + o.className : '') },
    h('label', { class: o.labelHidden ? 'sr-only' : 'field-label', for: id }, o.label, o.required && !o.labelHidden ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    input,
    hint,
    err,
  );

  return {
    root,
    input,
    id,
    setError(msg) {
      err.hidden = !msg;
      err.textContent = msg || '';
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      describe();
    },
    setHint(msg) {
      hint.hidden = !msg;
      hint.textContent = msg;
      describe();
    },
  };
}

/**
 * A <select> as a Field.
 * @param {{ label: string, options: Array<{ value: string, label: string }>, value?: string, hint?: string, className?: string, labelHidden?: boolean }} o
 */
export function createSelect(o) {
  const sel = h(
    'select',
    { class: 'field' },
    o.options.map((opt) => h('option', { value: opt.value, selected: opt.value === o.value }, opt.label)),
  );
  return createField({ label: o.label, control: sel, hint: o.hint, className: o.className, labelHidden: o.labelHidden });
}

/**
 * @param {string} label
 * @param {{ kind?: 'primary' | 'ghost' | 'danger' | 'default', type?: 'button' | 'submit', icon?: Node, onClick?: (e: MouseEvent) => void, small?: boolean, ariaLabel?: string, className?: string, title?: string }} [o]
 */
export function button(label, o = {}) {
  return h(
    'button',
    {
      type: o.type || 'button',
      class: ['btn', o.kind && o.kind !== 'default' ? 'btn-' + o.kind : '', o.small ? 'btn-sm' : '', o.className || ''].filter(Boolean).join(' '),
      'aria-label': o.ariaLabel,
      title: o.title,
      onclick: o.onClick,
    },
    o.icon || null,
    label ? h('span', null, label) : null,
  );
}

/**
 * Inline banner. Errors use role=alert, others role=status.
 * @param {'error' | 'success' | 'info'} kind
 * @param {string} message
 */
export function banner(kind, message) {
  return h('div', { class: 'banner banner-' + kind, role: kind === 'error' ? 'alert' : 'status' }, message);
}

/**
 * A reusable slot for one status/error message that screen readers announce.
 * @param {{ className?: string }} [o]
 */
export function createNotice(o = {}) {
  const el = h('div', { class: 'notice ' + (o.className || ''), hidden: true });
  return {
    el,
    /** @param {'error' | 'success' | 'info'} kind @param {string} message */
    show(kind, message) {
      el.hidden = false;
      el.className = 'banner banner-' + kind + (o.className ? ' ' + o.className : '');
      el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      // Re-insert text so repeated identical errors are announced again.
      el.textContent = '';
      queueMicrotask(() => {
        el.textContent = message;
      });
    },
    clear() {
      el.hidden = true;
      el.textContent = '';
    },
  };
}

/**
 * Applies an ApiError to a form: validation `fields` go under their inputs,
 * everything else (and fields without an input) into the notice.
 * @param {unknown} err
 * @param {Record<string, Field>} fields map of API field name -> Field
 * @param {ReturnType<typeof createNotice>} notice
 */
export function showFormError(err, fields, notice) {
  for (const f of Object.values(fields)) f.setError(null);
  if (!(err instanceof ApiError)) {
    notice.show('error', 'Something went wrong. Please try again.');
    return;
  }
  const unmatched = [];
  /** @type {Field | null} */
  let first = null;
  for (const [name, msg] of Object.entries(err.fields)) {
    const field = Object.hasOwn(fields, name) ? fields[name] : fields[name.split('.').pop() || ''];
    if (field) {
      field.setError(fieldMessage(msg));
      first = first || field;
    } else unmatched.push(fieldMessage(msg));
  }
  notice.show('error', [err.message, ...unmatched].filter(Boolean).join(' '));
  if (first) first.input.focus();
}

/**
 * Disables a button/form while an async task runs.
 * @template T
 * @param {HTMLElement[]} els
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function whileBusy(els, task) {
  for (const el of els) {
    el.setAttribute('aria-busy', 'true');
    if ('disabled' in el) /** @type {any} */ (el).disabled = true;
  }
  try {
    return await task();
  } finally {
    for (const el of els) {
      el.removeAttribute('aria-busy');
      if ('disabled' in el) /** @type {any} */ (el).disabled = false;
    }
  }
}

/**
 * A real switch: a checkbox with role=switch and a visible label.
 * @param {{ label: string, description?: string, checked: boolean, onChange: (checked: boolean) => void }} o
 */
export function createSwitch(o) {
  const id = nextId('sw');
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch', id, checked: o.checked, 'aria-describedby': o.description ? id + '-d' : undefined });
  input.addEventListener('change', () => o.onChange(input.checked));
  const root = h(
    'div',
    { class: 'switch-row' },
    h('div', { class: 'switch-text' }, h('label', { for: id, class: 'switch-label' }, o.label), o.description ? h('p', { class: 'field-hint', id: id + '-d' }, o.description) : null),
    input,
  );
  return { root, input };
}

/**
 * A radio group (native radios, so arrow keys and form semantics come free).
 * Options render as segmented buttons or custom content such as swatches.
 * @param {{
 *   legend: string, name?: string, value: string | null, className?: string, hint?: string,
 *   options: Array<{ value: string, label: string, content?: Node, title?: string }>,
 *   onChange: (value: string) => void,
 * }} o
 */
export function createRadioGroup(o) {
  const name = o.name || nextId('rg');
  /** @type {Map<string, HTMLInputElement>} */
  const inputs = new Map();
  const items = o.options.map((opt) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name, value: opt.value, checked: opt.value === o.value, class: 'sr-only' }));
    input.addEventListener('change', () => {
      if (input.checked) o.onChange(opt.value);
    });
    inputs.set(opt.value, input);
    return h('label', { class: 'choice', title: opt.title || opt.label }, input, opt.content || h('span', { class: 'choice-text' }, opt.label), opt.content ? h('span', { class: 'sr-only' }, opt.label) : null);
  });
  const root = h(
    'fieldset',
    { class: 'choice-group' + (o.className ? ' ' + o.className : '') },
    h('legend', { class: 'field-label' }, o.legend),
    h('div', { class: 'choice-row' }, items),
    o.hint ? h('p', { class: 'field-hint' }, o.hint) : null,
  );
  return {
    root,
    /** @param {string | null} v */
    setValue(v) {
      for (const [val, input] of inputs) input.checked = val === v;
    },
  };
}

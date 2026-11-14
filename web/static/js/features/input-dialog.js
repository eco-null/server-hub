// @ts-check
/**
 * A dialog with one input whose confirmation runs an API call. The dialog
 * stays open and shows the server's message when the call fails (unlike a
 * plain prompt), so a mistyped code can simply be corrected.
 */

import { h } from '../dom.js';
import { openDialog } from '../dialog.js';
import { createField, createNotice, showFormError, whileBusy } from '../ui.js';

/**
 * @param {{
 *   title: string, label: string, message?: string, type?: string, hint?: string,
 *   autocomplete?: string, inputMode?: string, maxLength?: number,
 *   submitLabel?: string, danger?: boolean,
 *   fieldNames?: string[],
 *   validate?: (value: string) => string | null,
 *   run: (value: string) => Promise<void>,
 * }} o
 * @returns {Promise<boolean>} true when `run` succeeded
 */
export function openInputDialog(o) {
  const dlg = openDialog({
    title: o.title,
    size: 'sm',
    build(ctrl) {
      const field = createField({
        label: o.label,
        type: o.type || 'text',
        autocomplete: o.autocomplete || 'off',
        inputMode: o.inputMode,
        hint: o.hint,
        maxLength: o.maxLength,
        required: true,
        autofocus: true,
        spellcheck: false,
      });
      const notice = createNotice();
      const map = Object.fromEntries((o.fieldNames || ['value']).map((n) => [n, field]));
      const submit = h('button', { type: 'submit', class: 'btn ' + (o.danger ? 'btn-danger-solid' : 'btn-primary') }, o.submitLabel || 'Continue');
      const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctrl.close(false) }, 'Cancel');
      return h(
        'form',
        {
          class: 'dlg-content',
          novalidate: true,
          onsubmit: async (/** @type {Event} */ e) => {
            e.preventDefault();
            notice.clear();
            field.setError(null);
            const value = field.input.value.trim();
            const problem = o.validate ? o.validate(value) : value ? null : 'This field is required.';
            if (problem) {
              field.setError(problem);
              field.input.focus();
              return;
            }
            await whileBusy([submit, cancel], async () => {
              try {
                await o.run(value);
                ctrl.close(true);
              } catch (err) {
                showFormError(err, map, notice);
              }
            });
          },
        },
        o.message ? h('p', { class: 'dlg-message' }, o.message) : null,
        notice.el,
        field.root,
        h('div', { class: 'dlg-footer' }, cancel, submit),
      );
    },
  });
  return dlg.closed.then((v) => v === true);
}

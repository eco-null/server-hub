// @ts-check

/**
 * True when a keyboard event may trigger an app shortcut: no Ctrl/Meta/Alt,
 * not coming from a form control or editable area, and no modal open.
 * @param {{ ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, isComposing?: boolean, defaultPrevented?: boolean, target?: any }} e
 * @param {{ modalOpen?: boolean }} [ctx]
 */
export function canUseShortcut(e, ctx = {}) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return false;
  if (ctx.modalOpen) return false;
  const t = e.target;
  if (t && typeof t === 'object') {
    const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
    if (t.isContentEditable) return false;
  }
  return true;
}

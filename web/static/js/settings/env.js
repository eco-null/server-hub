// @ts-check
/**
 * Shared environment handed to every settings section.
 *
 * @typedef {{
 *   api: import('../api.js').Api,
 *   store: ReturnType<typeof import('../store.js').createSettingsStore>,
 *   state: ReturnType<typeof createSettingsState>,
 *   register: (path: string, field: import('../ui.js').Field) => import('../ui.js').Field,
 *   applyBootstrap: (data: import('../types.js').Bootstrap) => void,
 * }} Env
 */

import { createState } from '../state.js';
import { normalizeLayout } from '../lib/grid.js';

export function createSettingsState() {
  return createState({
    /** @type {import('../types.js').User | null} */
    user: null,
    /** @type {import('../types.js').Service[]} */
    services: [],
    /** @type {import('../types.js').Bookmark[]} */
    bookmarks: [],
    layout: normalizeLayout(null),
    loaded: false,
  });
}

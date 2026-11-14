// @ts-check
/** Dashboard header: title, subtitle, user chip, theme toggle, logout. */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { nextThemeMode, themeLabel } from '../theme.js';
import { logout } from '../session.js';

const DEFAULT_TITLE = 'Server Hub';
const DEFAULT_SUBTITLE = 'Your apps and services, reachable from one place.';

/**
 * @param {{
 *   store: ReturnType<typeof import('../store.js').createSettingsStore>,
 *   api: import('../api.js').Api,
 * }} o
 */
export function createHeader({ store, api }) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const title = $('page-title');
  const subtitle = $('page-subtitle');
  const themeBtn = $('theme-btn');
  const userChip = $('user-chip');

  themeBtn.addEventListener('click', () => store.update({ theme: nextThemeMode(store.get().theme) }));
  $('logout-btn').addEventListener('click', () => void logout(api));

  return {
    /** @param {import('../types.js').Settings} s */
    renderSettings(s) {
      const name = s.pageTitle.trim() || DEFAULT_TITLE;
      title.textContent = name;
      subtitle.textContent = s.subtitle.trim() || DEFAULT_SUBTITLE;
      document.title = name;
      const label = themeLabel(s.theme);
      const iconId = s.theme === 'auto' ? 'ui-theme-auto' : s.theme === 'light' ? 'ui-theme-light' : 'ui-theme-dark';
      themeBtn.replaceChildren(icon(iconId), h('span', null, `Theme: ${label}`));
      themeBtn.title = `Theme: ${label}`;
      themeBtn.setAttribute('aria-label', `Theme: ${label}. Activate to switch theme.`);
    },
    /** @param {import('../types.js').User | null} user */
    renderUser(user) {
      userChip.hidden = !user;
      if (!user) return;
      userChip.replaceChildren(icon('user'), h('span', null, user.username), user.role === 'admin' ? h('span', { class: 'pill' }, 'admin') : null);
      userChip.setAttribute('aria-label', `Signed in as ${user.username}${user.role === 'admin' ? ' (administrator)' : ''}`);
    },
  };
}

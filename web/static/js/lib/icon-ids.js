// @ts-check
/**
 * Icon ids a service may use. Must stay identical to the backend's KNOWN_ICONS.
 * @type {readonly string[]}
 */
export const ICON_IDS = Object.freeze([
  'chart', 'pulse', 'database', 'shield', 'shield-check', 'key', 'lock',
  'lock-key', 'cloud', 'note', 'file', 'film', 'music', 'headphones', 'git',
  'branch', 'terminal', 'globe', 'home', 'broadcast', 'cog', 'box',
  'shopping', 'flask', 'sparkles', 'camera', 'image', 'book', 'gamepad',
  'wallet', 'map-pin', 'activity', 'cpu', 'server', 'wifi', 'zap', 'mail',
  'message', 'calendar', 'clock', 'download', 'upload', 'sliders', 'user',
  'users', 'bookmark', 'star', 'heart', 'link', 'external-link', 'folder',
  'archive', 'package', 'layers', 'refresh', 'bell', 'bug', 'code', 'command',
]);

export const ICON_SET = new Set(ICON_IDS);
export const DEFAULT_ICON = 'box';

/**
 * @param {unknown} id
 * @returns {string} a known service icon id (falls back to "box")
 */
export function knownIcon(id) {
  return typeof id === 'string' && ICON_SET.has(id) ? id : DEFAULT_ICON;
}

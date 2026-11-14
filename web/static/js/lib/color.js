// @ts-check
/** Colour maths used for accent handling and contrast guarantees. */

/** @param {unknown} v */
export function isHex(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/**
 * @param {string} hex #rrggbb
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** @param {[number, number, number]} rgb */
export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
}

/**
 * WCAG relative luminance.
 * @param {string} hex
 */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio (1..21).
 * @param {string} a
 * @param {string} b
 */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Text colour (white or near-black) that is most readable on `bg`.
 * @param {string} bg
 */
export function readableOn(bg) {
  return contrast(bg, '#ffffff') >= contrast(bg, '#0b0f19') ? '#ffffff' : '#0b0f19';
}

/**
 * Moves `fg` towards white or black (whichever direction increases contrast
 * with `bg`) until it reaches `min` contrast. Used so accent-coloured text
 * always meets WCAG AA.
 * @param {string} fg
 * @param {string} bg
 * @param {number} [min]
 */
export function ensureContrast(fg, bg, min = 4.5) {
  if (contrast(fg, bg) >= min) return fg;
  const target = luminance(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  const base = hexToRgb(fg);
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = rgbToHex(/** @type {[number, number, number]} */ (base.map((v, i) => v + (target[i] - v) * t)));
    if (contrast(c, bg) >= min) return c;
  }
  return rgbToHex(/** @type {[number, number, number]} */ (target));
}

/**
 * @param {string} hex
 * @param {number} alpha
 */
export function rgba(hex, alpha) {
  if (!isHex(hex)) return `rgba(94,106,210,${alpha})`;
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

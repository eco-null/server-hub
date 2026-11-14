// @ts-check

/**
 * Turns the server-provided `qr_svg` into a data: URL for an <img>. An SVG
 * shown through <img> cannot run scripts or apply page styles, so it is safe
 * to display even though it comes from the network. Returns null when the
 * payload does not look like an SVG document.
 * @param {unknown} svg
 * @returns {string | null}
 */
export function svgDataUrl(svg) {
  if (typeof svg !== 'string' || svg.length > 200000) return null;
  let s = svg.trim();
  if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s)) return null;
  // Inline-HTML SVG has no namespace; a standalone image needs one.
  if (!/<svg[^>]*\sxmlns\s*=/i.test(s)) s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'data:image/svg+xml;base64,' + btoa(bin);
}

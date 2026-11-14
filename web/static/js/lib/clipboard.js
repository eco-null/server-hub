// @ts-check

/**
 * Copies text to the clipboard. Returns false when the browser refuses
 * (insecure context, permissions); callers then tell the user to copy by hand.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Offers a text file for download.
 * @param {string} filename
 * @param {string} text
 * @param {string} [type]
 */
export function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

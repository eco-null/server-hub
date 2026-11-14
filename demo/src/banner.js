// @ts-check
/** Demo banner: the "Reset demo" control. The banner markup itself is added by build.js. */

import { STATE_KEY } from './backend.js';
import { BASE } from './install.js';

/** Clears everything the demo and the app stored in this browser, then starts over on the dashboard. */
export function resetDemo() {
  try {
    const ls = window.localStorage;
    const keys = Array.from({ length: ls.length }, (_, i) => ls.key(i)).filter((k) => typeof k === 'string');
    for (const k of keys) if (k === STATE_KEY || k.startsWith(STATE_KEY + ':') || k.startsWith('serverhub:')) ls.removeItem(k);
  } catch {
    /* storage blocked: the demo already runs from memory, a reload is a reset */
  }
  location.assign(BASE);
}

const btn = document.getElementById('demo-reset');
if (btn) btn.addEventListener('click', resetDemo);
